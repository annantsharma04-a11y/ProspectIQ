// Plain-language explanation of why a candidate identity was surfaced.
//
// Derived entirely from the candidate's stored fields, its cited sources, and
// the recorded conflicts — no model call, so it cannot invent a justification.
// Every clause corresponds to something the record actually contains.

import { valuesAgree, type IdentityCandidate, type IdentityConflict } from './types';

/** Conflicts that concern the values this particular candidate carries. */
function conflictsForCandidate(
  candidate: IdentityCandidate,
  conflicts: IdentityConflict[],
): IdentityConflict[] {
  return conflicts.filter((c) => {
    if (c.field === 'company') {
      // The conflict is about this candidate if either side matches what it says.
      return valuesAgree(candidate.company, c.claimed_value) || valuesAgree(candidate.company, c.public_value);
    }
    if (c.field === 'role') {
      return valuesAgree(candidate.role, c.claimed_value) || valuesAgree(candidate.role, c.public_value);
    }
    return false;
  });
}

function list(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * One or two sentences a person can scan when comparing candidates.
 *
 * Says only what the evidence supports: which identity fields are present,
 * whether independent sources back them, and where the record disagrees.
 */
export function explainCandidate(
  candidate: IdentityCandidate,
  conflicts: IdentityConflict[] = [],
  /**
   * The other candidates in the same run. Used only to compare EVIDENCE
   * STRENGTH between them — never to suggest which person is the right one.
   * That judgment is the user's, and only their selection settles it.
   */
  peers: IdentityCandidate[] = [],
): string {
  const present: string[] = [];
  if (candidate.name) present.push('name');
  if (candidate.role) present.push('role');
  if (candidate.company) present.push('company');
  if (candidate.location) present.push('location');

  const missing: string[] = [];
  if (!candidate.role) missing.push('role');
  if (!candidate.company) missing.push('employer');

  const sourceCount = candidate.sources.length;
  const corroborated = sourceCount > 0;
  const fromProvider = candidate.origin === 'profile_provider';
  const relevantConflicts = conflictsForCandidate(candidate, conflicts);

  // Nothing identifying at all.
  if (present.length === 0) {
    return 'No identifying details were established for this candidate.';
  }

  const sentences: string[] = [];

  // 1. What matches, and whether anything independent backs it.
  if (relevantConflicts.length > 0) {
    const fields: string[] = [
      ...new Set(relevantConflicts.map((c) => (c.field === 'company' ? 'company' : 'role'))),
    ];
    sentences.push(
      `${capitalise(list(present.filter((f) => !fields.includes(f))) || 'Name')} match${
        present.filter((f) => !fields.includes(f)).length === 1 ? 'es' : ''
      }, but the available public evidence differs on ${list(fields)}.`,
    );
  } else if (corroborated) {
    sentences.push(
      `${capitalise(list(present))} match${present.length === 1 ? 'es' : ''}, corroborated by ${sourceCount} independent public source${
        sourceCount === 1 ? '' : 's'
      }.`,
    );
  } else if (fromProvider) {
    sentences.push(
      `${capitalise(list(present))} come${present.length === 1 ? 's' : ''} from the profile provider, with no independent public source corroborating it.`,
    );
  } else {
    sentences.push(
      `${capitalise(list(present))} appear${present.length === 1 ? 's' : ''} in public research, but no source was retained to corroborate it.`,
    );
  }

  // 2. What could not be established, or how it compares with the alternatives.
  if (missing.length > 0 && relevantConflicts.length === 0) {
    sentences.push(`The ${list(missing)} could not be independently corroborated.`);
  } else if (peers.length > 1) {
    const others = peers.filter((p) => p.id !== candidate.id);
    const bestSources = Math.max(...others.map((p) => p.sources.length), 0);
    const bestConfidence = Math.max(...others.map((p) => p.confidence), 0);

    if (candidate.confidence >= bestConfidence && sourceCount >= bestSources) {
      sentences.push(
        'This candidate has the strongest supporting evidence among the candidates found.',
      );
    } else if (sourceCount < bestSources) {
      sentences.push(
        `Fewer sources support this than the strongest candidate found (${bestSources}).`,
      );
    } else if (candidate.confidence < bestConfidence) {
      sentences.push(
        'Another candidate is supported by more closely matching evidence.',
      );
    }
  }

  return sentences.slice(0, 2).join(' ');
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
