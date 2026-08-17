// Who the outreach is from. Configured per deployment, not per prospect, and
// read from the environment so the app isn't wired to one company.

export interface SenderConfig {
  name: string | null;
  company: string;
  value_prop: string;
  /** The capabilities qualification is allowed to match a company against. */
  capabilities: SenderCapability[];
}

export interface SenderCapability {
  /** Short id used in structured output, e.g. "ap_automation". */
  id: string;
  /** Human name of the capability. */
  name: string;
  /** What it does, in the sender's own words. */
  description: string;
  /** Observable company characteristics that make this capability plausible. */
  applies_when: string;
}

/**
 * The product surface qualification may reason about.
 *
 * This is configuration, not invention: nothing outside this list may be
 * offered to a prospect, and the qualifier is told explicitly not to imagine
 * capabilities beyond it.
 *
 * What ships here is a neutral EXAMPLE showing the required shape. Your real
 * capabilities — and especially `applies_when`, which encodes who you consider a
 * good fit — are commercial information and belong in SENDER_CAPABILITIES, not
 * in a repository anyone can read.
 */
const DEFAULT_CAPABILITIES: SenderCapability[] = [
  {
    id: 'example_capability',
    name: 'Example capability',
    description:
      'Replace this by setting SENDER_CAPABILITIES to a JSON array describing what your product actually does.',
    applies_when:
      'Describe the observable characteristics that make this capability plausibly relevant to a company.',
  },
];

export function getSenderCapabilities(): SenderCapability[] {
  const raw = process.env.SENDER_CAPABILITIES?.trim();
  if (!raw) return DEFAULT_CAPABILITIES;
  try {
    const parsed = JSON.parse(raw) as SenderCapability[];
    const valid = parsed.filter((c) => c && c.id && c.name && c.description);
    return valid.length > 0 ? valid : DEFAULT_CAPABILITIES;
  } catch {
    // Malformed configuration must not silently change what we claim to sell.
    console.warn('[sender] SENDER_CAPABILITIES is not valid JSON; using the configured defaults.');
    return DEFAULT_CAPABILITIES;
  }
}

// Neutral placeholder. The real positioning is deployment configuration, set via
// SENDER_VALUE_PROP — it does not belong in a shared repository.
const DEFAULT_VALUE_PROP =
  'Configure SENDER_VALUE_PROP with a one-line description of what you sell.';

export function getSenderConfig(): SenderConfig {
  return {
    name: process.env.SENDER_NAME?.trim() || null,
    company: process.env.SENDER_COMPANY?.trim() || 'Your Company',
    value_prop: process.env.SENDER_VALUE_PROP?.trim() || DEFAULT_VALUE_PROP,
    capabilities: getSenderCapabilities(),
  };
}

/** One-line description used to judge signal relevance and to draft copy. */
export function outreachContext(sender: SenderConfig = getSenderConfig()): string {
  return `${sender.company}: ${sender.value_prop}`;
}

/** Capability list rendered for a prompt. */
export function renderCapabilities(capabilities: SenderCapability[]): string {
  return capabilities
    .map((c) => `- ${c.id} — ${c.name}: ${c.description}\n  Plausible when: ${c.applies_when}`)
    .join('\n');
}

/** Shown whenever research did not support credible personalisation. */
export const INSUFFICIENT_EVIDENCE_NOTICE =
  'Insufficient verified public information for high-confidence personalization.';
