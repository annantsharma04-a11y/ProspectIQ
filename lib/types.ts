// Shared contracts. Row shapes mirror supabase/migrations/002_real_pipeline.sql.

import type { CheckedClaim, ValidationStatus } from '@/lib/validation/factcheck';
import type { SignalCategory } from '@/lib/signals/types';
import type { LinkedInProfile, ProfileAccess } from '@/lib/linkedin/profile';
import type { TargetQualification } from '@/lib/qualification/types';
import type { IdentityVerification } from '@/lib/identity/types';

export type RunStatus =
  | 'queued'
  | 'running'
  /** Profile + research collected and saved; only the AI analysis still owes us. */
  | 'ai_analysis_pending'
  | 'ready_for_review'
  | 'needs_manual_review'
  | 'approved'
  | 'rejected'
  | 'failed';

/** The pipeline stages, in execution order. This array IS the pipeline order. */
export const STAGE_ORDER = [
  'validate_input',
  'identify_prospect',
  'resolve_candidate',
  'verify_identity',
  'research_prospect',
  'research_company',
  'qualify_prospect',
  'qualify_company',
  'collect_signals',
  'evaluate_signals',
  'select_hook',
  'generate_message',
  'validate_claims',
  'ready_for_review',
] as const;

export type StageName = (typeof STAGE_ORDER)[number];

export const STAGE_LABELS: Record<StageName, string> = {
  validate_input: 'Validate input',
  identify_prospect: 'Identify prospect',
  resolve_candidate: 'Candidate resolution',
  verify_identity: 'Verify identity',
  research_prospect: 'Research prospect',
  research_company: 'Research company',
  qualify_prospect: 'Qualify prospect',
  qualify_company: 'Qualify company',
  collect_signals: 'Collect signals',
  evaluate_signals: 'Evaluate signals',
  select_hook: 'Select hook',
  generate_message: 'Generate message',
  validate_claims: 'Validate claims',
  ready_for_review: 'Ready for review',
};

export type StageStatus = 'pending' | 'running' | 'complete' | 'degraded' | 'skipped' | 'failed';

export type LinkedInAccessStatus = 'accessible' | 'blocked' | 'unavailable' | 'not_attempted';

export interface RunRow {
  id: string;
  linkedin_url: string;
  linkedin_slug: string;
  input_name: string | null;
  input_company: string | null;
  input_title: string | null;
  /** Name to sign this run's outreach with; falls back to SENDER_NAME. */
  sender_name: string | null;
  prospect_name: string | null;
  prospect_title: string | null;
  company_name: string | null;
  company_domain: string | null;
  identity_confidence: number | null;
  linkedin_access_status: LinkedInAccessStatus | null;
  linkedin_access_note: string | null;
  /** Normalized profile from the LinkedIn provider; null when retrieval failed. */
  linkedin_profile: LinkedInProfile | null;
  profile_access: ProfileAccess | null;
  profile_source: string | null;
  status: RunStatus;
  overall_confidence: number | null;
  selected_hook: string | null;
  generated_message: string | null;
  insufficient_evidence: boolean;
  error: string | null;
  /** LLMErrorType when the analysis failed; drives the retry affordance. */
  ai_error_type: string | null;
  /** Identity verification: VERIFIED | PARTIAL | AMBIGUOUS | FAILED. */
  identity_status: string | null;
  /** AUTOMATIC | USER_CONFIRMED */
  identity_resolution: string | null;
  identity_verification: IdentityVerification | null;
  /** Full target qualification result; null before the qualify stages run. */
  qualification: TargetQualification | null;
  /** QUALIFIED | BORDERLINE | NOT_QUALIFIED */
  qualification_status: string | null;
  overall_fit: number | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunStageRow {
  id: string;
  run_id: string;
  stage_name: StageName;
  stage_order: number;
  status: StageStatus;
  summary: string | null;
  output: unknown | null;
  error: string | null;
  duration_ms: number | null;
  started_at: string | null;
  completed_at: string | null;
}

export interface SourceRow {
  id: string;
  run_id: string;
  url: string;
  canonical_url: string;
  title: string | null;
  snippet: string | null;
  source_type: string | null;
  credibility: number | null;
  published_date: string | null;
  retrieved_at: string;
  fetch_status: string | null;
  providers: string[] | null;
  found_via: string[] | null;
  duplicate_count: number;
  /** Extracted page text when the page was retrieved; null for snippet-only. */
  content: string | null;
  content_chars: number | null;
}

export interface SignalRow {
  id: string;
  run_id: string;
  signal: string;
  why_it_matters: string | null;
  category: SignalCategory | null;
  source_url: string;
  source_title: string | null;
  source_type: string | null;
  published_date: string | null;
  supporting_quote: string | null;
  relevance_score: number | null;
  specificity_score: number | null;
  recency_score: number | null;
  confidence_score: number | null;
  credibility_score: number | null;
  corroboration_count: number;
  composite_score: number | null;
  conflicts_with: string | null;
  selected_as_hook: boolean;
  retrieved_at: string;
}

export interface DraftRow {
  id: string;
  run_id: string;
  hook_signal_id: string | null;
  mode: 'personalized' | 'conservative';
  subject: string | null;
  message_text: string;
  final_text: string | null;
  personalization_basis: string | null;
  reasoning: string | null;
  claims: CheckedClaim[] | null;
  validation_status: ValidationStatus | null;
  validation_notes: string | null;
  sensitivity_note: string | null;
  confidence: number | null;
  information_requests: string[] | null;
  reviewer_action: 'approved' | 'edited' | 'rejected' | null;
  edited_text: string | null;
  reviewed_at: string | null;
  created_at: string;
}

/** What POST /api/runs accepts. Only the LinkedIn URL is required. */
export interface RunRequest {
  linkedin_url: string;
  prospect_name?: string | null;
  company_name?: string | null;
  prospect_title?: string | null;
  /** Who the outreach is from. Signed into the message. */
  sender_name?: string | null;
}

/** Full snapshot the live view and result panel render from. */
export interface RunSnapshot {
  run: RunRow;
  stages: RunStageRow[];
  signals: SignalRow[];
  sources: SourceRow[];
  draft: DraftRow | null;
}
