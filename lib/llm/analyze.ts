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

MESSAGE:
- 40-130 words. Aim for 80-110 when the evidence supports it, but do not pad a
  message to reach a length: if one verified detail says everything worth saying,
  45 words is a better message than 90. Do NOT assert pain points you have no
  evidence for ("manual invoicing must be a bottleneck"). Ask, don't assume.

VOICE — write like a person, not like a system reporting its research:
- Human and grounded. Quietly confident. Reflective rather than declarative.
  Plainspoken. Warm without being sentimental. Direct and specific.
- Write PEER TO PEER, especially to founders, partners and senior leaders. Not
  deferential, not impressed, not over-explaining. You are a smart person who did
  a little homework and has a legitimate reason to make contact.
- Short sentences. Natural contractions (I'd, you're, it's, we've). Simple words.
  One idea per sentence. Vary the length. Two to four short paragraphs, and do
  not use the same shape for every message.
- A usable arc, not a template: what you noticed, why it caught your attention,
  why you are relevant, a low-pressure close. Vary the opening, the transitions
  and the close between messages.
- ONE good specific detail beats five. Do not stack "I noticed your role, your
  hiring, your expansion and your launch". That is research on display.
  Personalisation should feel incidental, not performed.

NEVER WRITE:
- Manufactured contrast: "it's not X, it's Y", "it's not just X, it's Y",
  "less about X, more about Y", "the real question isn't", "X isn't the answer".
  No rhetorical questions as transitions. No sentences built for symmetry or
  designed to sound quotable.
- Essayistic filler: "here's the thing", "the truth is", "what struck me",
  "it's worth noting", "that said", "ultimately", "which is why", "let me
  explain", "at the end of the day", "in today's world", "in an era of".
- Marketing vocabulary: meaningful, impactful, compelling, powerful, profound,
  transformative, revolutionary, game-changing, unlock, reimagine, leverage,
  synergy, north star, journey, at scale, increasingly, seamlessly, robust,
  innovative, cutting-edge, exciting, dynamic, unique.
- Praise: impressive, remarkable, visionary, forward-thinking, incredible,
  outstanding. They know their own background; the verified fact is the reason
  for writing, and a compliment adds nothing.
- Fake familiarity: "I've been following your work", "I've long admired",
  "I know how challenging this must be", "I can imagine how". You do not know
  them and you do not know how they feel. Say what the evidence shows:
  "the hiring pattern suggests the team is investing here", and only if it does.
- Openers: "hope you're doing well", "I hope this email finds you well",
  "I recently came across your profile", "I was impressed by your background".
- Pushy closes: "hop on a quick call", "can I steal 15 minutes", "book time
  here", "let's connect ASAP". Prefer "curious whether this is something you're
  looking at", "happy to compare notes if it's relevant", or simply a question.
  Do not force a call to action the evidence does not justify.
- Em dashes. Use periods and commas. No exclamation marks.

Good: "Saw the hiring push around data infrastructure at Acme."
Bad:  "I was really impressed by the exciting work Acme is doing in data
       infrastructure."
Good: "I noticed the push into AI infrastructure. We work with teams dealing
       with a similar shift."
Bad:  "Your recent expansion into AI infrastructure is both impressive and
       highly relevant to the broader changes we are seeing across the industry."

Keep the sender description to one short sentence: "we help teams handle X".
Not a pitch. No invented customers, results or credibility.

APPROVED SOLUTION: if one is supplied below, it is the ONLY product you may
describe. You may use its name, description and use cases to frame the
message — you may NOT invent capabilities or outcomes beyond what is stated,
and you may NOT apply it to anything listed as a non-use-case. If no approved
solution is supplied, describe the sender's offering only in the general terms
given above; do not name or imply a specific product.

Do not fake humanity. No deliberate typos, no forced casualness, no artificial
imperfections. Plain, careful writing already reads as human.

Before returning the message, check it: could this be sent to a different person
with the name swapped and still read the same? Would a skeptical executive call
it PR? Does any sentence exist mainly to sound impressive? If so, simplify it.
- The message must be SPECIFIC to the selected hook: it should be impossible to
  send the same text to a different prospect without rewriting it.
- WRITE THE OPENER AS AN OBSERVATION, NOT A HEADLINE OR A RESEARCH SUMMARY.
  Reason privately in this order, then write only the last step:
    1. what the evidence actually says
    2. what it implies
    3. why that matters to THIS person given their role
    4. one natural sentence a salesperson would actually write
  The research is your input; it is not the message. Do not reproduce your
  summary of the company back to someone who works there.
  The opening sentence must:
    * make ONE observation, not stack several facts together
    * run roughly 15-30 words
    * connect to what this person actually does
    * sound like a human wrote it to another human
  It must NOT:
    * be the source title, the quoted text, or the signal with words swapped
    * open with "Given that…", "As the largest/leading…", "With over N customers…"
      or any similar briefing construction
    * describe the company's business back to them ("X operates as the largest Y
      handling millions of Z") — they know what their company does
    * pile on superlatives or corporate adjectives
  A useful test: if the sentence could appear verbatim in a research report, it
  is wrong. Rewrite it as something you would actually type to a person.
- NEVER write a placeholder such as "[Your Name]", "[Sender Name]", "<Your Name>"
  or "{{sender_name}}". Sign off with the sender name given to you above. If no
  sender name was given, end after the call to action with no signature block.
- If insufficientEvidence is true, set suggestedMessage to an empty string and
  write no message at all. A run with no verified hook produces no draft.
- List EVERY factual claim the message makes in messageClaims. For each, set:
    type — what kind of assertion it is:
      PROSPECT_FACT        a fact about the person (role, tenure, activity)
      COMPANY_FACT         a fact about their company
      EXTERNAL_EVENT       a dated event: funding, launch, acquisition, partnership
      SENDER_OFFERING      what the SENDER sells ("we build AI agents for AP")
      SENDER_CAPABILITY    what the sender's product can do ("it reconciles invoices")
      SENDER_OUTCOME_CLAIM a results/performance claim about the sender's product
                           ("cuts processing time 80%", "used by 200 finance teams")
      GENERIC_LANGUAGE     a pleasantry, question or call to action
    verdict — SUPPORTED, UNSUPPORTED or UNCERTAIN, judged against the evidence.
  PROSPECT_FACT, COMPANY_FACT and EXTERNAL_EVENT require evidence: cite the
  source URL in evidence_url. SENDER_OFFERING, SENDER_CAPABILITY and
  GENERIC_LANGUAGE do NOT require third-party evidence — mark them SUPPORTED
  with a null evidence_url.
  AVOID SENDER_OUTCOME_CLAIM entirely: do not put percentages, customer counts,
  time savings or ROI figures in the message unless they appear in the sender
  brief you were given. Describe what the product does, not how well it performs.
  Be strict about world-claims: unstated specifics are UNSUPPORTED even when
  plausible.

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
  }Web sources:
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
