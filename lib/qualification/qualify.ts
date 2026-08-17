// Target qualification — one model call, before any outreach work happens.
//
// Runs after research and before signal evaluation, so an unqualified target
// costs one cheap call rather than a full analysis-and-drafting pass. The model
// assesses fit; the QUALIFIED / BORDERLINE / NOT_QUALIFIED decision is made in
// code (lib/qualification/types.ts) so the bar cannot drift.

import { callStructured } from '@/lib/llm/gemini';
import type { JsonSchema } from '@/lib/llm/types';
import { renderProfile, type LinkedInProfile } from '@/lib/linkedin/profile';
import { renderSources } from '@/lib/llm/analyze';
import type { NormalizedSource } from '@/lib/research/normalize';
import { renderCapabilities, type SenderConfig } from '@/lib/generation/sender';
import {
  applyEvidenceDiscipline,
  applyProspectEvidenceDiscipline,
  type CompanyFit,
  type EvidenceBasis,
  type ProspectFit,
} from './types';
import { verifyEvidence, type RawEvidenceItem } from './verify';

const SYSTEM = `You qualify sales targets. You decide whether a seller should be
talking to THIS person about THIS product at THIS company — before anyone writes
an outreach message.

Two independent judgments:

PROSPECT FIT — is this person a meaningful target?
  Weigh seniority, function, likely responsibilities, decision authority, and
  influence over the workflows the product addresses. Judge the ROLE, never the
  person: this is a targeting decision, not a comment on their ability.
  - Junior/entry-level individual contributors and interns are usually LOW,
    unless the evidence shows they directly own the relevant workflow.
  - Managers and Directors depend on function: finance/operations/compliance
    ownership matters far more than the seniority word in the title.
  - VP/Head/CXO/Founder are often plausible targets by role, but seniority is
    NOT evidence of functional relevance. A CEO holds ultimate decision
    authority over everything and personally owns almost nothing operational —
    "chief executive, therefore an elite target for [workflow]" is the same
    guess as "fintech, therefore KYC" on the company side, and is banned for
    the same reason.
  - Do not rely on the title alone. Use responsibilities, department, company
    context and anything public they have said.
  - Someone in an unrelated function (recruiting, design, facilities) at a great
    company is still a LOW prospect unless evidence shows relevant influence.

  PRODUCT RELEVANCE EVIDENCE — reason in this order, every time:
      person → their actual remit or stated activity → does it touch the
      qualified workflow → product_relevance
  NEVER reason: seniority → assumed influence → product_relevance.

  Set evidence_basis for product_relevance:
      OBSERVED — a supplied source ties THIS SPECIFIC PERSON to the qualified
                 workflow: their own stated responsibilities, something they
                 said or did publicly, or a source describing their remit.
                 For each such source, add an entry to evidence with the URL
                 AND a short quote copied VERBATIM from that source's text
                 that itself shows the connection to the workflow — not a
                 quote that merely confirms their name or title. A bio page
                 or an article ABOUT the person that never mentions the
                 workflow does not qualify, even if it is a real, relevant-
                 looking source about them.
      INFERRED — plausible from title, seniority or decision authority alone,
                 with no source tying this individual to the workflow itself.
                 evidence may be empty.
      UNKNOWN  — you cannot tell.
  Decision authority and seniority may be HIGH while evidence_basis is still
  INFERRED — those are different questions. "Could approve a purchase" is not
  "personally touches this workflow". Every evidence quote is checked
  mechanically against the source's actual retrieved text: a quote that is
  paraphrased, invented, or copied from a different source is rejected and
  does not count, and product_relevance with no surviving verified evidence
  will be capped automatically downstream, however senior the person is.

COMPANY FIT — does the EVIDENCE show workflows this product would serve?
  Reason in this order, every time:
      company → observed workflow or operational context → matching capability
      → supporting source → fit score
  NEVER reason: industry → assumed product fit.

  INDUSTRY IS CONTEXT, NOT EVIDENCE. "They are a fintech, so they must run KYC"
  is not a finding — it is a guess about a category. A brokerage with no visible
  verification workflow in the sources is not evidenced, and a consultancy with a
  documented high-volume payables operation IS evidenced. Judge the company in
  front of you, not its sector's stereotype.

  A company existing is not evidence of fit. An interesting news event is not
  evidence of fit. Only workflows and operational characteristics that appear in
  the supplied sources count as observed.

CAPABILITY MAPPING
  For each capability, state the workflow you actually saw, and label how you
  arrived at it:
      OBSERVED — a supplied source describes this workflow or operational context
                 at this company. For each such source, add an entry to evidence
                 with the URL AND a short quote copied VERBATIM from that
                 source's text that itself describes the workflow — not just a
                 quote naming the company.
      INFERRED — plausible from context (including industry) but no source
                 confirms it for this company. evidence may be empty.
      UNKNOWN  — you cannot tell.
  Be honest with these labels: every evidence quote is checked mechanically
  against the source's actual retrieved text, so an OBSERVED match whose quote
  does not genuinely appear in the cited source will be downgraded
  automatically, and a company with nothing verified cannot score highly
  however obvious its sector seems.
  You may ONLY reason about the capabilities listed. Never invent products,
  features, customers or integrations.

  Label every entry in fit_reasons the same way, with its own basis and evidence.

EVIDENCE DISCIPLINE
  - Base every judgment on the supplied profile and sources.
  - Where evidence is thin, say so and use UNKNOWN. UNKNOWN is a correct and
    useful answer — it is far better than false confidence.
  - Never write "this company definitely needs X". Prefer "public information
    indicates a plausible use case for X" or "insufficient public evidence".
  - Put concise business reasoning in the reason fields. Do not narrate your
    deliberation.

Scores are 0-100 and must be consistent with the classification:
HIGH ≈ 70-100, MEDIUM ≈ 45-69, LOW ≈ 0-44, UNKNOWN ≈ whatever the evidence
supports (use a low-to-middling score and set classification UNKNOWN).`;

const SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    prospect_fit: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        classification: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
        role: { type: 'string', nullable: true },
        seniority: { type: 'string', nullable: true },
        relevance_reason: { type: 'string' },
        decision_authority: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
        product_relevance: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
        why_this_person: { type: 'array', items: { type: 'string' } },
        why_not_this_person: { type: 'array', items: { type: 'string' } },
        missing_information: { type: 'array', items: { type: 'string' } },
        evidence_basis: {
          type: 'string',
          enum: ['OBSERVED', 'INFERRED', 'UNKNOWN'],
          description: 'How product_relevance was arrived at. See PRODUCT RELEVANCE EVIDENCE above.',
        },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              quote: {
                type: 'string',
                description: 'Verbatim excerpt from that URL, copied exactly, showing THIS person tied to the workflow.',
              },
            },
            required: ['url', 'quote'],
          },
          description:
            'Evidence tying THIS person to the qualified workflow. Required when evidence_basis is OBSERVED. Each quote is checked mechanically against the source; a quote that does not verify does not count.',
        },
      },
      required: [
        'score',
        'classification',
        'relevance_reason',
        'decision_authority',
        'product_relevance',
        'evidence_basis',
      ],
    },
    company_fit: {
      type: 'object',
      properties: {
        score: { type: 'integer' },
        classification: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] },
        industry: { type: 'string', nullable: true },
        company_size: { type: 'string', nullable: true },
        relevant_workflows: { type: 'array', items: { type: 'string' } },
        capability_matches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              capability_id: { type: 'string' },
              capability_name: { type: 'string' },
              company_signal: {
                type: 'string',
                description: 'The workflow or operational context actually seen for THIS company.',
              },
              fit_strength: { type: 'integer' },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    quote: {
                      type: 'string',
                      description: 'Verbatim excerpt from that URL, copied exactly, describing the workflow.',
                    },
                  },
                  required: ['url', 'quote'],
                },
                description: 'Evidence showing the workflow. Required when basis is OBSERVED. Each quote is checked mechanically against the source.',
              },
              basis: { type: 'string', enum: ['OBSERVED', 'INFERRED', 'UNKNOWN'] },
              reason: { type: 'string' },
            },
            required: ['capability_id', 'capability_name', 'company_signal', 'fit_strength', 'basis', 'reason'],
          },
        },
        fit_reasons: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              reason: { type: 'string' },
              basis: { type: 'string', enum: ['OBSERVED', 'INFERRED', 'UNKNOWN'] },
              evidence: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    url: { type: 'string' },
                    quote: { type: 'string' },
                  },
                  required: ['url', 'quote'],
                },
              },
            },
            required: ['reason', 'basis'],
          },
        },
        missing_information: { type: 'array', items: { type: 'string' } },
      },
      required: ['score', 'classification', 'fit_reasons'],
    },
  },
  required: ['prospect_fit', 'company_fit'],
};

export interface QualifyInput {
  profile: LinkedInProfile | null;
  profileAccessNote: string;
  sources: NormalizedSource[];
  prospectName: string | null;
  role: string | null;
  company: string | null;
  sender: SenderConfig;
}

function clamp(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function classify(value: unknown): ProspectFit['classification'] {
  const v = String(value ?? '').toUpperCase();
  return v === 'HIGH' || v === 'MEDIUM' || v === 'LOW' || v === 'UNKNOWN' ? v : 'UNKNOWN';
}

export async function qualifyTarget(input: QualifyInput) {
  const profileBlock = input.profile
    ? `LinkedIn profile (retrieved directly):\n${renderProfile(input.profile)}`
    : `LinkedIn profile data: NOT AVAILABLE (${input.profileAccessNote})`;

  const prompt = `PRODUCT BEING SOLD
${input.sender.company}: ${input.sender.value_prop}

Capabilities you may reason about (and ONLY these):
${renderCapabilities(input.sender.capabilities)}

PROSPECT
name: ${input.prospectName ?? '(unresolved)'}
role: ${input.role ?? '(unknown)'}
company: ${input.company ?? '(unknown)'}

${profileBlock}

PUBLIC SOURCES
${renderSources(input.sources, 2500)}

Assess prospect fit and company fit.`;

  const { data, meta } = await callStructured<{
    prospect_fit: Omit<ProspectFit, 'evidence'> & { evidence?: RawEvidenceItem[] | null };
    company_fit: Omit<CompanyFit, 'capability_matches' | 'fit_reasons'> & {
      capability_matches?: (Omit<CompanyFit['capability_matches'][number], 'evidence'> & {
        evidence?: RawEvidenceItem[] | null;
      })[];
      fit_reasons?: (Omit<CompanyFit['fit_reasons'][number], 'evidence'> & { evidence?: RawEvidenceItem[] | null })[];
    };
  }>({
    purpose: 'qualify_target',
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 120_000,
  });

  const allowedIds = new Set(input.sender.capabilities.map((c) => c.id));

  const basis = (v: unknown): EvidenceBasis => {
    const x = String(v ?? '').toUpperCase();
    return x === 'OBSERVED' || x === 'INFERRED' ? x : 'UNKNOWN';
  };

  const prospect_fit_raw: ProspectFit = {
    score: clamp(data.prospect_fit?.score),
    classification: classify(data.prospect_fit?.classification),
    role: data.prospect_fit?.role ?? input.role,
    seniority: data.prospect_fit?.seniority ?? null,
    relevance_reason: data.prospect_fit?.relevance_reason ?? '',
    decision_authority: classify(data.prospect_fit?.decision_authority),
    product_relevance: classify(data.prospect_fit?.product_relevance),
    why_this_person: data.prospect_fit?.why_this_person ?? [],
    why_not_this_person: data.prospect_fit?.why_not_this_person ?? [],
    missing_information: data.prospect_fit?.missing_information ?? [],
    evidence_basis: basis(data.prospect_fit?.evidence_basis),
    // Only evidence whose URL was genuinely retrieved AND whose quote
    // genuinely appears in that source's content counts — a real-but-
    // unrelated URL (a generic bio, a paywalled article) is not evidence.
    evidence: verifyEvidence(data.prospect_fit?.evidence, input.sources),
  };

  // Seniority and decision authority describe the role, not functional
  // ownership — enforced in code, the same way industry alone cannot produce a
  // high company score.
  const prospect_fit = applyProspectEvidenceDiscipline(prospect_fit_raw);

  const company_fit_raw: CompanyFit = {
    score: clamp(data.company_fit?.score),
    classification: classify(data.company_fit?.classification),
    industry: data.company_fit?.industry ?? null,
    company_size: data.company_fit?.company_size ?? null,
    relevant_workflows: data.company_fit?.relevant_workflows ?? [],
    // Drop any capability the model invented — we only sell what is configured.
    capability_matches: (data.company_fit?.capability_matches ?? [])
      .filter((m) => allowedIds.has(m.capability_id))
      .map((m) => ({
        capability_id: m.capability_id,
        capability_name: m.capability_name,
        company_signal: m.company_signal,
        fit_strength: clamp(m.fit_strength),
        evidence: verifyEvidence(m.evidence, input.sources),
        basis: basis(m.basis),
        reason: m.reason ?? '',
      })),
    fit_reasons: (data.company_fit?.fit_reasons ?? []).map((r) => ({
      reason: r.reason,
      basis: basis(r.basis),
      evidence: verifyEvidence(r.evidence, input.sources),
    })),
    missing_information: data.company_fit?.missing_information ?? [],
    evidence_basis: 'UNKNOWN',
    evidence_adjustment: null,
  };

  // Industry alone cannot produce a high score — enforced in code.
  const company_fit = applyEvidenceDiscipline(company_fit_raw);

  return { prospect_fit, company_fit, meta };
}
