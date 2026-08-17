// Signal contracts shared by extraction, ranking, generation and validation.

export type SignalCategory =
  | 'job_change'
  | 'promotion'
  | 'funding'
  | 'product_launch'
  | 'expansion'
  | 'hiring'
  | 'strategic_initiative'
  | 'interview'
  | 'company_announcement'
  | 'acquisition'
  | 'partnership'
  | 'technology_adoption'
  | 'leadership_change'
  | 'public_post'
  | 'press_coverage'
  | 'business_challenge'
  | 'other';

/** A signal as the model extracts it, before deterministic scoring. */
export interface ExtractedSignal {
  signal: string;
  why_it_matters: string;
  category: SignalCategory;
  source_title: string;
  source_url: string;
  published_date: string | null;
  /** Verbatim text from the source that supports the claim. */
  supporting_quote: string;
  relevance_score: number;
  specificity_score: number;
  confidence_score: number;
  /** Set when this signal contradicts another one. */
  conflicts_with: string | null;
  /** PERSON = about the prospect; COMPANY = about their employer. */
  signal_level: 'PERSON' | 'COMPANY';
  /** Why a company-level signal connects to this person's role. */
  role_relevance: string | null;
  /** Why this justifies making contact now. */
  outreach_rationale: string | null;
  /** Capability this hook's angle rests on, or null if none. */
  related_capability_id: string | null;
}

/** A signal after deterministic recency + credibility scoring is applied. */
export interface ScoredSignal extends ExtractedSignal {
  source_type: string;
  /** FULL | SNIPPET | UNAVAILABLE — how well the cited source could be read. */
  evidence_level: string;
  credibility_score: number;
  recency_score: number;
  corroboration_count: number;
  /** Weighted composite used for ranking, 0–100. */
  composite_score: number;
  retrieved_at: string;
}
