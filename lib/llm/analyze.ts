// analyzeProspect — the ONE model call per prospect.
//
// Everything the LLM is genuinely needed for happens here in a single
// schema-constrained request: reading the evidence, extracting signals, judging
// which is the best opener, writing the message, and declaring the factual
// claims that message makes.
//
// Everything deterministic stays in normal code and is NOT sent to a model:
// URL validation, profile normalization, source dedup, recency/composite
// scoring, hook gating, quote verification, claim-survival checks.
//
// The pipeline calls this through lib/pipeline; no stage talks to a provider
// directly, so swapping providers means changing only lib/llm.

import { callStructured } from './gemini';
import type { JsonSchema } from './types';
import type { LinkedInProfile } from '@/lib/linkedin/profile';
import type { NormalizedSource } from '@/lib/research/normalize';
import { renderProfile } from '@/lib/linkedin/profile';
import type { ApprovedProofContext } from '@/lib/proof/match';
import { renderBrief, type EmailBrief } from '@/lib/generation/brief';
import { EMAIL_WRITING_RULES } from '@/lib/generation/email-rules';

export interface AnalysisProspect {
  name: string | null;
  headline: string | null;
  currentCompany: string | null;
  currentRole: string | null;
  location: string | null;
  identityConfidence: number;
  identityNotes: string | null;
  ambiguous: boolean;
  employerChangeNote: string | null;
}

export interface AnalysisHook {
  signal: string;
  why_it_matters: string;
  /** PERSON = about the prospect themselves; COMPANY = about their employer. */
  signal_level?: 'PERSON' | 'COMPANY';
  /** Why a company-level signal is relevant to THIS person's role. */
  role_relevance?: string | null;
  /** Why this justifies making contact now. */
  outreach_rationale?: string | null;
  /**
   * The capability id this hook's angle rests on, or null when the hook is a
   * general company/person observation that assumes no particular use case.
   */
  related_capability_id?: string | null;
  category: string;
  source_url: string;
  published_date: string | null;
  supporting_quote: string;
  relevance_score: number;
  specificity_score: number;
  confidence_score: number;
  conflicts_with: string | null;
}

/**
 * What KIND of assertion a claim is. This drives whether external evidence is
 * required: a statement about the sender's own product cannot and should not be
 * corroborated by third-party research about the prospect.
 */
export type ClaimType =
  /** A fact about the person: role, tenure, remit, public activity. */
  | 'PROSPECT_FACT'
  /** A fact about their company. */
  | 'COMPANY_FACT'
  /** A dated event: funding, launch, acquisition, partnership. */
  | 'EXTERNAL_EVENT'
  /** What the sender sells — a description of the product. */
  | 'SENDER_OFFERING'
  /** What the sender's product can technically do. */
  | 'SENDER_CAPABILITY'
  /** A performance/results claim about the sender's product. */
  | 'SENDER_OUTCOME_CLAIM'
  /** Pleasantries, questions, calls to action. */
  | 'GENERIC_LANGUAGE';

export interface AnalysisClaim {
  claim: string;
  type: ClaimType;
  verdict: 'SUPPORTED' | 'UNSUPPORTED' | 'UNCERTAIN';
  evidence_url: string | null;
  explanation: string;
}

export interface ProspectAnalysis {
  prospect: AnalysisProspect;
  summary: string;
  careerInsights: string[];
  companyContext: string[];
  personalizationHooks: AnalysisHook[];
  painPointsOrInterests: string[];
  selectedHookIndex: number | null;
  hookReason: string;
  alternativesConsidered: { index: number; why_not: string }[];
  insufficientEvidence: boolean;
  insufficientReason: string | null;
  outreachAngle: string;
  suggestedSubject: string;
  suggestedMessage: string;
  messageClaims: AnalysisClaim[];
  confidence: number;
  informationRequests: string[];
}

const SYSTEM = `You are a B2B prospect research analyst. In ONE pass you read the
evidence about a prospect and produce a complete analysis plus a cold outreach
message.

EVIDENCE RULES — these override everything else:
- Use ONLY the supplied LinkedIn profile data and web sources. Never use outside
  knowledge about this person or company, and never generalise beyond a source.
- Every personalizationHook MUST cite one of the supplied source URLs exactly,
  and supporting_quote MUST be text copied verbatim from that source. If you
  cannot quote it, do not emit the hook. Quotes are checked mechanically.
- Set signal_level for each hook:
    PERSON  — the signal is about the prospect themselves (their role, their
              appointment, something they said or did)
    COMPANY — the signal is about their employer
  A COMPANY signal is perfectly valid, but only when you can state why it is
  relevant to THIS person's role or function. Put that in role_relevance. If the
  prospect's role is unknown, or the company signal has no credible connection to
  what they actually do, do NOT emit that hook — look for another signal.
  Example: a company's AI partnership is relevant to a Head of Data; the same
  partnership is not obviously relevant to a facilities manager.
- Set outreach_rationale on every hook: the concrete reason this justifies making
  contact now.
- Set related_capability_id when the hook's angle depends on a particular use
  case, otherwise null. USE CASE DISCIPLINE: this company qualified on specific
  evidenced workflows, listed below. Prefer hooks that connect to those. Do NOT
  build an angle around a use case that was only inferred — a hook implying the
  company runs a workflow no source shows is exactly the fabrication this system
  exists to prevent.
- Never assert an inferred capability as fact. Do not write "the company uses",
  "the company has" or "the company needs" about a workflow no source confirms.
  Ask about it or leave it out.
- When information is unavailable, use null or an empty array. Never guess a
  company, title, figure, date or initiative.
- If two sources disagree, emit both hooks and set conflicts_with on each.
- An empty personalizationHooks list is a correct answer for a thin prospect.

IDENTITY:
- When LinkedIn profile data is supplied it is the strongest evidence for name,
  headline, current company and role — prefer it over web sources.
- currentCompany and currentRole are SEPARATE fields. Split combined titles:
  "Chair, Gates Foundation" is role "Chair", company "Gates Foundation".
- If several distinct people plausibly match the evidence, set ambiguous=true.

HOOK SELECTION:
- Choose the single best opener and put its index in selectedHookIndex.
- The freshest hook is NOT automatically the best; prefer the one giving the most
  credible business reason to reach out now, tied to the prospect's own remit.
- NEVER select a disputed hook, or one about layoffs, lawsuits, bankruptcies,
  deaths, or other sensitive negative events.
- If nothing supports credible personalisation, set selectedHookIndex to null and
  insufficientEvidence to true.

${EMAIL_WRITING_RULES}

Scores are 0-100. relevance = to the sender's offering; specificity = how unique
to THIS company/person; confidence = how firmly the source establishes it.`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    prospect: {
      type: 'object',
      properties: {
        name: { type: 'string', nullable: true },
        headline: { type: 'string', nullable: true },
        currentCompany: { type: 'string', nullable: true },
        currentRole: { type: 'string', nullable: true },
        location: { type: 'string', nullable: true },
        identityConfidence: { type: 'integer' },
        identityNotes: { type: 'string', nullable: true },
        ambiguous: { type: 'boolean' },
        employerChangeNote: { type: 'string', nullable: true },
      },
      required: ['identityConfidence', 'ambiguous'],
    },
    summary: { type: 'string' },
    careerInsights: { type: 'array', items: { type: 'string' } },
    companyContext: { type: 'array', items: { type: 'string' } },
    personalizationHooks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          signal: { type: 'string' },
          why_it_matters: { type: 'string' },
          signal_level: { type: 'string', enum: ['PERSON', 'COMPANY'] },
          related_capability_id: {
            type: 'string',
            nullable: true,
            description:
              'Capability id this hook leans on, or null if it assumes no specific use case.',
          },
          role_relevance: { type: 'string', nullable: true },
          outreach_rationale: { type: 'string', nullable: true },
          category: {
            type: 'string',
            enum: [
              'job_change', 'promotion', 'funding', 'product_launch', 'expansion',
              'hiring', 'strategic_initiative', 'interview', 'company_announcement',
              'acquisition', 'partnership', 'technology_adoption', 'leadership_change',
              'public_post', 'press_coverage', 'business_challenge', 'other',
            ],
          },
          source_url: { type: 'string' },
          published_date: { type: 'string', nullable: true },
          supporting_quote: { type: 'string' },
          relevance_score: { type: 'integer' },
          specificity_score: { type: 'integer' },
          confidence_score: { type: 'integer' },
          conflicts_with: { type: 'string', nullable: true },
        },
        required: [
          'signal', 'why_it_matters', 'category', 'source_url', 'supporting_quote',
          'relevance_score', 'specificity_score', 'confidence_score',
        ],
      },
    },
    painPointsOrInterests: { type: 'array', items: { type: 'string' } },
    selectedHookIndex: { type: 'integer', nullable: true },
    hookReason: { type: 'string' },
    alternativesConsidered: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer' }, why_not: { type: 'string' } },
        required: ['index', 'why_not'],
      },
    },
    insufficientEvidence: { type: 'boolean' },
    insufficientReason: { type: 'string', nullable: true },
    outreachAngle: { type: 'string' },
    suggestedSubject: { type: 'string' },
    suggestedMessage: { type: 'string' },
    messageClaims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          type: {
            type: 'string',
            enum: [
              'PROSPECT_FACT', 'COMPANY_FACT', 'EXTERNAL_EVENT',
              'SENDER_OFFERING', 'SENDER_CAPABILITY', 'SENDER_OUTCOME_CLAIM',
              'GENERIC_LANGUAGE',
            ],
          },
          verdict: { type: 'string', enum: ['SUPPORTED', 'UNSUPPORTED', 'UNCERTAIN'] },
          evidence_url: { type: 'string', nullable: true },
          explanation: { type: 'string' },
        },
        required: ['claim', 'type', 'verdict', 'explanation'],
      },
    },
    confidence: { type: 'integer' },
    informationRequests: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'prospect', 'summary', 'personalizationHooks', 'insufficientEvidence',
    'suggestedMessage', 'messageClaims', 'confidence',
  ],
};

/** Capability context carried from qualification into analysis. */
export interface QualifiedCapabilityContext {
  observed: { id: string; name: string; workflow: string }[];
  inferred: { id: string; name: string }[];
}

/**
 * The single approved product the model may reference by name, matched
 * deterministically in code (lib/solutions/match.ts) from the company's
 * VERIFIED capabilities before this call is ever made. The model may use
 * this to frame the message — it may not add capabilities, outcomes or use
 * cases beyond what is stated here, and may not apply it to a listed
 * non-use-case.
 */
export interface ApprovedSolutionContext {
  id: string;
  name: string;
  description: string;
  target_functions: string[];
  use_cases: string[];
  non_use_cases: string[];
  matched_on: string[];
}

export interface AnalyzeInput {
  /** Direct profile data, when the LinkedIn provider returned it. */
  profile: LinkedInProfile | null;
  /** Human-readable note about how profile access went. */
  profileAccessNote: string;
  sources: NormalizedSource[];
  slug: string;
  nameHint: string | null;
  userHints: { name: string | null; company: string | null; title: string | null };
  /** What the sender offers — drives relevance scoring and the message. */
  outreachContext: string;
  senderName: string | null;
  senderCompany: string;
  /** What actually qualified this company, and what was only inferred. */
  capabilityContext?: QualifiedCapabilityContext;
  /** The approved solution matched to this company's verified capabilities, if any. */
  approvedSolution?: ApprovedSolutionContext;
  /**
   * The ONE approved customer proof selected for this prospect, if any.
   *
   * Chosen deterministically in lib/proof/match.ts before this call — the
   * model never sees the catalog and never picks. Absent means there is no
   * approved proof for this workflow, which is a normal outcome and never a
   * cue to supply one.
   */
  approvedProof?: ApprovedProofContext;
  /**
   * The already-settled inputs the email should be written FROM.
   *
   * Available only once hook gating has run, so it is supplied on the rewrite
   * path today (see lib/generation/brief.ts for why, and for the architecture
   * this is moving toward). When present it narrows the model's job to prose:
   * which fact, which workflow and which proof are no longer its decisions.
   */
  emailBrief?: EmailBrief;
  /** Set only when regenerating a draft that failed the personalisation gate. */
  rewriteDirective?: string;
}

export function renderSources(sources: NormalizedSource[], maxChars = 3500): string {
  if (sources.length === 0) return '(no web sources retrieved)';
  return sources
    .map(
      (s, i) =>
        `[S${i + 1}] ${s.title}
url: ${s.url}
type: ${s.source_type} (credibility ${s.credibility})
published: ${s.published_date ?? 'unknown'}
found_via: ${s.categories.join(', ')}
text: ${(s.content ?? s.snippet).slice(0, maxChars)}`,
    )
    .join('\n\n');
}

export async function analyzeProspect(input: AnalyzeInput) {
  const profileBlock = input.profile
    ? `LinkedIn profile data (retrieved directly — strongest evidence):
${renderProfile(input.profile)}`
    : `LinkedIn profile data: NOT AVAILABLE (${input.profileAccessNote})
Do not imply the profile was read. Work from the web sources below.`;

  const prompt = `Sender: ${input.senderName ? `${input.senderName}, ` : ''}${input.senderCompany}
Sign the message as: ${input.senderName ?? '(no individual name configured — omit the signature block)'}
Sender's offering (judge relevance against this):
${input.outreachContext}

LinkedIn profile slug: ${input.slug}
Name suggested by the slug (a guess, not evidence): ${input.nameHint ?? 'none'}

User-supplied hints (authoritative if present):
- name: ${input.userHints.name ?? '(not provided)'}
- company: ${input.userHints.company ?? '(not provided)'}
- title: ${input.userHints.title ?? '(not provided)'}

${profileBlock}

${
    input.capabilityContext
      ? `QUALIFYING EVIDENCE — what this company was actually shown to do
${
  input.capabilityContext.observed.length > 0
    ? input.capabilityContext.observed
        .map((c) => `- ${c.id} (${c.name}) — OBSERVED: ${c.workflow}`)
        .join('\n')
    : '- (none directly observed)'
}
${
  input.capabilityContext.inferred.length > 0
    ? `Only inferred, NOT established — do not build an angle on these:\n${input.capabilityContext.inferred
        .map((c) => `- ${c.id} (${c.name})`)
        .join('\n')}`
    : ''
}

`
      : ''
  }${
    input.approvedSolution
      ? `APPROVED SOLUTION — the only product you may describe
${input.approvedSolution.name}: ${input.approvedSolution.description}
Target functions: ${input.approvedSolution.target_functions.join(', ') || '(none listed)'}
Use cases: ${input.approvedSolution.use_cases.join('; ') || '(none listed)'}
Do NOT use for: ${input.approvedSolution.non_use_cases.join('; ') || '(none listed)'}
Matched because this company was verified to have: ${input.approvedSolution.matched_on.join(', ')}

`
      : ''
  }${
    input.approvedProof
      ? `APPROVED ZAMP PROOF — the only customer result you may mention
ID: ${input.approvedProof.id}
Customer: ${input.approvedProof.customer}
Workflow: ${input.approvedProof.workflow}
Approved statement: ${input.approvedProof.approved_statement}

Use this statement WORD FOR WORD, or leave it out entirely. Those are the only
two options. Do not paraphrase it, shorten it, expand it, split it, merge it
with another sentence, restate its numbers, change its customer, or draw a
further result from it.

`
      : `NO APPROVED PROOF is available for this prospect. Write the message
with no customer result at all. Specifically, do not:
  - name a customer, or describe one as "a client", "a retailer", "a large bank"
  - describe another company's outcome, however hedged
  - cite a percentage, a time saving, a headcount figure or an ROI number
  - create an anonymous or composite customer result
  - write a case study, a mini case study, or a "teams typically see" claim
  - invent evidence of any kind
An email with no proof is correct and expected here. Make the message land on
the verified fact, the operational implication and the specific work instead.

`
  }${input.emailBrief ? `${renderBrief(input.emailBrief)}

` : ''}Web sources:
${renderSources(input.sources)}

Produce the full analysis and the outreach message.${
    input.rewriteDirective ? `

REWRITE INSTRUCTION (overrides prior output):
${input.rewriteDirective}` : ''
  }`;

  return callStructured<ProspectAnalysis>({
    purpose: 'analyze_prospect',
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 180_000,
  });
}
