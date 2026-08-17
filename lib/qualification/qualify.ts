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
import { applyEvidenceDiscipline, type CompanyFit, type EvidenceBasis, type ProspectFit } from './types';

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
  - VP/Head/CXO/Founder are often HIGH, but only when their remit plausibly
    touches the product's area.
  - Do not rely on the title alone. Use responsibilities, department, company
    context and anything public they have said.
  - Someone in an unrelated function (recruiting, design, facilities) at a great
    company is still a LOW prospect unless evidence shows relevant influence.

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
  For each capability, state the workflow you actually saw, cite the source URLs
  that show it, and label how you arrived at it:
      OBSERVED — a supplied source describes this workflow or operational context
                 at this company. Cite the URL(s) in evidence.
      INFERRED — plausible from context (including industry) but no source
                 confirms it for this company. evidence may be empty.
      UNKNOWN  — you cannot tell.
  Be honest with these labels: an OBSERVED match with no cited source will be
  downgraded automatically, and a company with nothing observed cannot score
  highly however obvious its sector seems.
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
      },
      required: ['score', 'classification', 'relevance_reason', 'decision_authority', 'product_relevance'],
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
                items: { type: 'string' },
                description: 'Source URLs showing the workflow. Required when basis is OBSERVED.',
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
              evidence: { type: 'array', items: { type: 'string' } },
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
    prospect_fit: ProspectFit;
    company_fit: CompanyFit;
  }>({
    purpose: 'qualify_target',
    system: SYSTEM,
    input: prompt,
    schema: SCHEMA,
    timeoutMs: 120_000,
  });

  const allowedIds = new Set(input.sender.capabilities.map((c) => c.id));
  // A citation only counts if it points at a source this run actually retrieved.
  const retrievedUrls = new Set<string>();
  for (const src of input.sources) {
    retrievedUrls.add(src.url);
    retrievedUrls.add(src.canonical_url);
  }

  const prospect_fit: ProspectFit = {
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
  };

  const basis = (v: unknown): EvidenceBasis => {
    const x = String(v ?? '').toUpperCase();
    return x === 'OBSERVED' || x === 'INFERRED' ? x : 'UNKNOWN';
  };

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
        // Only URLs we actually retrieved count as evidence.
        evidence: (m.evidence ?? []).filter((url) => retrievedUrls.has(url)),
        basis: basis(m.basis),
        reason: m.reason ?? '',
      })),
    fit_reasons: (data.company_fit?.fit_reasons ?? []).map((r) => ({
      reason: r.reason,
      basis: basis(r.basis),
      evidence: (r.evidence ?? []).filter((url) => retrievedUrls.has(url)),
    })),
    missing_information: data.company_fit?.missing_information ?? [],
    evidence_basis: 'UNKNOWN',
    evidence_adjustment: null,
  };

  // Industry alone cannot produce a high score — enforced in code.
  const company_fit = applyEvidenceDiscipline(company_fit_raw);

  return { prospect_fit, company_fit, meta };
}
