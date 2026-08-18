// Controlled solution catalog — configuration, not invention.
//
// Mirrors the pattern in lib/generation/sender.ts (SENDER_CAPABILITIES): the
// real catalog is commercial information and belongs in the deployment
// environment (ZAMP_SOLUTION_CATALOG, a JSON array), never in a shared
// repository. What ships here is a neutral placeholder showing the required
// shape, so a misconfigured deployment fails loud (falls back to an obvious
// placeholder solution) rather than silently inventing product claims.

import type { ZampSolution } from './types';

const DEFAULT_CATALOG: ZampSolution[] = [
  {
    id: 'example_solution',
    name: 'Example solution',
    description:
      'Replace this by setting ZAMP_SOLUTION_CATALOG to a JSON array describing the solutions you actually sell.',
    supported_workflows: ['Describe the workflow(s) this solution supports.'],
    target_functions: ['Describe the roles or functions this solution targets.'],
    use_cases: ['Describe when this solution genuinely applies.'],
    non_use_cases: ['Describe when this solution does NOT apply, so outreach is never stretched to fit.'],
    matches_capability_ids: ['example_capability'],
  },
];

export function getSolutionCatalog(): ZampSolution[] {
  const raw = process.env.ZAMP_SOLUTION_CATALOG?.trim();
  if (!raw) return DEFAULT_CATALOG;
  try {
    const parsed = JSON.parse(raw) as ZampSolution[];
    const valid = parsed.filter(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.name === 'string' &&
        typeof s.description === 'string' &&
        Array.isArray(s.matches_capability_ids) &&
        Array.isArray(s.supported_workflows) &&
        Array.isArray(s.target_functions) &&
        Array.isArray(s.use_cases) &&
        Array.isArray(s.non_use_cases),
    );
    return valid.length > 0 ? valid : DEFAULT_CATALOG;
  } catch {
    // Malformed configuration must not silently change what we claim to sell.
    console.warn('[solutions] ZAMP_SOLUTION_CATALOG is not valid JSON; using the configured defaults.');
    return DEFAULT_CATALOG;
  }
}
