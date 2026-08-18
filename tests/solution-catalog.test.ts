import { describe, it, expect, afterEach, vi } from 'vitest';
import { getSolutionCatalog } from '@/lib/solutions/catalog';

// Same configuration pattern as getSenderCapabilities() (tested implicitly
// via tests/qualification.test.ts) — a deployment sets the real catalog via
// an env var; a missing or malformed value must fall back to an obvious
// placeholder rather than silently doing nothing.

const ENV_KEY = 'ZAMP_SOLUTION_CATALOG';

afterEach(() => {
  delete process.env[ENV_KEY];
  vi.unstubAllEnvs();
});

describe('getSolutionCatalog', () => {
  it('falls back to the placeholder catalog when unset', () => {
    delete process.env[ENV_KEY];
    const catalog = getSolutionCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('example_solution');
  });

  it('parses a valid JSON catalog from the environment', () => {
    process.env[ENV_KEY] = JSON.stringify([
      {
        id: 'ap_suite',
        name: 'AP Automation Suite',
        description: 'Automates invoice capture and vendor payments.',
        supported_workflows: ['accounts payable'],
        target_functions: ['Finance'],
        use_cases: ['High-volume invoice processing.'],
        non_use_cases: ['Payroll.'],
        matches_capability_ids: ['ap_automation'],
      },
    ]);
    const catalog = getSolutionCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe('ap_suite');
  });

  it('falls back to the placeholder on malformed JSON rather than throwing', () => {
    process.env[ENV_KEY] = '{ not valid json';
    expect(() => getSolutionCatalog()).not.toThrow();
    expect(getSolutionCatalog()[0].id).toBe('example_solution');
  });

  it('drops entries missing required fields and falls back if nothing valid remains', () => {
    process.env[ENV_KEY] = JSON.stringify([{ id: 'incomplete', name: 'Missing everything else' }]);
    const catalog = getSolutionCatalog();
    expect(catalog[0].id).toBe('example_solution');
  });
});
