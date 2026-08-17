// The state a run accumulates as it moves through the stages.
//
// Held in memory for the duration of the run and persisted stage by stage, so a
// reload of the live view always reflects real committed progress.

import type { LinkedInRetrievalResult } from '@/lib/linkedin/fetch';
import type { LinkedInProfile } from '@/lib/linkedin/profile';
import type { NormalizedSource } from '@/lib/research/normalize';
import type { SearchRound } from '@/lib/research/engine';
import type { ResolvedIdentity } from '@/lib/research/identity';
import type { ProspectAnalysis } from '@/lib/llm/analyze';
import type { TargetQualification } from '@/lib/qualification/types';
import type {
  CandidateSelection,
  IdentityCandidate,
  IdentityVerification,
} from '@/lib/identity/types';
import type { StructuredResponse } from '@/lib/llm/types';
import type { ScoredSignal } from '@/lib/signals/types';
import type { HookSelection } from '@/lib/ranking/rank';
import type { ValidationResult } from '@/lib/validation/factcheck';
import type { RunRow } from '@/lib/types';

export interface PipelineContext {
  runId: string;
  run: RunRow;

  slug: string;
  normalizedUrl: string;
  nameHint: string | null;

  linkedinAccess: LinkedInRetrievalResult | null;
  /** Profile data from the LinkedIn provider; null when retrieval failed. */
  profile: LinkedInProfile | null;
  identity: ResolvedIdentity | null;

  sources: NormalizedSource[];
  rounds: SearchRound[];
  /** True once company-level research has been performed for this run. */
  companyResearchDone: boolean;

  /** Every person the input could plausibly represent. */
  identityCandidates: IdentityCandidate[];
  /** Which candidate is under verification, and how it was chosen. */
  candidateSelection: CandidateSelection | null;
  /** Who this person is, verified across sources before any targeting. */
  identityVerification: IdentityVerification | null;

  /** Target qualification, decided before any outreach work. */
  qualification: TargetQualification | null;

  /** Output of the single model call. */
  analysis: ProspectAnalysis | null;
  analysisMeta: StructuredResponse<unknown>['meta'] | null;

  rejectedSignals: { signal: string; reason: string }[];
  ranked: ScoredSignal[];

  selection: HookSelection | null;
  hook: ScoredSignal | null;
  hookSignalId: string | null;

  draftId: string | null;
  /** True when the draft still read as generic after one regeneration. */
  messageFailedGate: boolean;
  validation: ValidationResult | null;
}

export function newContext(run: RunRow): PipelineContext {
  return {
    runId: run.id,
    run,
    slug: run.linkedin_slug,
    normalizedUrl: run.linkedin_url,
    nameHint: null,
    linkedinAccess: null,
    profile: null,
    identity: null,
    sources: [],
    rounds: [],
    companyResearchDone: false,
    identityCandidates: [],
    candidateSelection: null,
    identityVerification: null,
    qualification: null,
    analysis: null,
    analysisMeta: null,
    rejectedSignals: [],
    ranked: [],
    selection: null,
    hook: null,
    hookSignalId: null,
    draftId: null,
    messageFailedGate: false,
    validation: null,
  };
}

/** Thrown to stop the pipeline after a stage has already recorded its failure. */
export class StageAbort extends Error {
  constructor(readonly stage: string, message: string) {
    super(message);
    this.name = 'StageAbort';
  }
}
