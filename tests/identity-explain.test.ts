import { describe, it, expect } from 'vitest';
import { explainCandidate } from '@/lib/identity/explain';
import { applyUserSelection, decideIdentity, selectCandidate, type IdentityCandidate, type IdentityConflict } from '@/lib/identity/types';

const candidate = (over: Partial<IdentityCandidate> = {}): IdentityCandidate => ({
  id: 'candidate_1',
  name: 'Alex Rivera',
  role: 'Founder & CEO',
  company: 'Northwind Brokerage',
  location: 'Bengaluru',
  headline: null,
  linkedin_url: 'https://www.linkedin.com/in/example-person',
  confidence: 92,
  sources: ['https://example.com/leadership', 'https://example.com/interview'],
  origin: 'public_research',
  ...over,
});

describe('1. strong candidate', () => {
  it('reflects the matching fields and counts the corroborating sources', () => {
    const text = explainCandidate(candidate());
    expect(text).toMatch(/name, role, company and location match/i);
    expect(text).toMatch(/2 independent public sources/i);
  });

  it('uses singular wording for a single source', () => {
    const text = explainCandidate(candidate({ sources: ['https://example.com/a'] }));
    expect(text).toMatch(/1 independent public source\b/i);
    expect(text).not.toMatch(/sources\b/i);
  });
});

describe('2. candidate with a conflict', () => {
  const conflict: IdentityConflict = {
    field: 'company',
    profile_value: 'Almasons',
    public_value: 'Northwind Brokerage',
    explanation: 'Two employers reported for this name.',
    sources: ['https://example.com/x'],
  };

  it('says the public evidence differs on the conflicting field', () => {
    const text = explainCandidate(candidate(), [conflict]);
    expect(text).toMatch(/differs on company/i);
    expect(text).not.toMatch(/corroborated by/i);
  });

  it('names both conflicting fields when role and company disagree', () => {
    const roleConflict: IdentityConflict = {
      field: 'role',
      profile_value: 'Software Developer',
      public_value: 'Founder & CEO',
      explanation: 'Different roles reported.',
      sources: [],
    };
    const text = explainCandidate(candidate(), [conflict, roleConflict]);
    expect(text).toMatch(/company/i);
    expect(text).toMatch(/role/i);
  });

  it('ignores a conflict that concerns a different candidate’s values', () => {
    const other = candidate({ company: 'Fabrikam Holdings', role: 'Analyst' });
    const text = explainCandidate(other, [conflict]);
    expect(text).toMatch(/corroborated by/i);
  });
});

describe('3. candidate with missing fields', () => {
  it('says the employer could not be corroborated when company is absent', () => {
    const text = explainCandidate(candidate({ company: null, role: 'Engineer' }));
    expect(text).toMatch(/employer could not be independently corroborated/i);
    expect(text).not.toMatch(/company match/i);
  });

  it('reports both missing fields', () => {
    const text = explainCandidate(candidate({ company: null, role: null }));
    expect(text).toMatch(/role and employer could not be independently corroborated/i);
  });

  it('flags a provider-only candidate with no public support', () => {
    const text = explainCandidate(candidate({ sources: [], origin: 'profile_provider' }));
    expect(text).toMatch(/from the profile provider/i);
    expect(text).toMatch(/no independent public source/i);
  });

  it('handles a candidate with nothing identifying', () => {
    const text = explainCandidate(
      candidate({ name: null, role: null, company: null, location: null, sources: [] }),
    );
    expect(text).toMatch(/no identifying details/i);
  });
});

describe('4. explanations never introduce unsupported facts', () => {
  it('mentions only fields the candidate actually carries', () => {
    const text = explainCandidate(candidate({ company: null, location: null }));
    expect(text).not.toMatch(/location/i);
    expect(text).not.toMatch(/Northwind/);
  });

  it('never states a source count the candidate does not have', () => {
    expect(explainCandidate(candidate({ sources: [] }))).not.toMatch(/\d+ independent public source/i);
  });

  it('never names the company or person — it describes evidence, not content', () => {
    const text = explainCandidate(candidate());
    expect(text).not.toMatch(/Alex Rivera|Northwind|Bengaluru/);
  });

  it('stays within two sentences', () => {
    for (const c of [candidate(), candidate({ company: null }), candidate({ sources: [], origin: 'profile_provider' })]) {
      const sentences = explainCandidate(c).split(/(?<=\.)\s+/).filter(Boolean);
      expect(sentences.length).toBeLessThanOrEqual(2);
    }
  });
});

describe('5-6. selection behaviour is unchanged', () => {
  const twoCandidates = () =>
    decideIdentity({
      profile: {
        name: 'Alex Rivera',
        role: 'Founder & CEO',
        company: 'Northwind Brokerage',
        location: 'Bengaluru',
        linkedin_url: 'https://www.linkedin.com/in/example-person',
      },
      hasProfile: true,
      candidates: [
        candidate({ id: 'candidate_1', confidence: 94 }),
        candidate({ id: 'candidate_2', role: 'Software Developer', company: 'Almasons', confidence: 68 }),
      ],
      conflicts: [],
      assessedConfidence: 90,
      missingFields: [],
    });

  it('explanations do not alter the selection decision', () => {
    const candidates = twoCandidates().candidates;
    const before = selectCandidate(candidates);
    expect(before.needs_user_choice).toBe(true);

    // Explaining a candidate is a pure read.
    candidates.forEach((c) => expect(typeof explainCandidate(c, [], candidates)).toBe('string'));

    expect(selectCandidate(candidates).needs_user_choice).toBe(true);
  });

  it('selection still resolves to the chosen candidate', () => {
    const v = applyUserSelection(twoCandidates(), 'candidate_2');
    expect(v.status).toBe('VERIFIED');
    expect(v.resolved.company).toBe('Almasons');
    expect(v.resolution).toBe('USER_CONFIRMED');
  });
});

describe('comparison between candidates', () => {
  const strong = candidate({ id: 'candidate_1', confidence: 95, sources: ['a', 'b', 'c', 'd'] });
  const weak = candidate({ id: 'candidate_2', confidence: 80, sources: ['e'] });

  it('describes the strongest candidate in terms of evidence, not correctness', () => {
    const text = explainCandidate(strong, [], [strong, weak]);
    expect(text).toMatch(/strongest supporting evidence among the candidates found/i);
    // It must not imply the system has decided who the right person is.
    expect(text).not.toMatch(/most likely|correct (person|identity)|intended person|the person you meant/i);
  });

  it('tells the user when a candidate rests on fewer sources', () => {
    const text = explainCandidate(weak, [], [strong, weak]);
    expect(text).toMatch(/fewer sources support this than the strongest candidate found \(4\)/i);
  });

  it('distinguishes candidates that would otherwise read identically', () => {
    // The whole point: the two explanations must not be the same sentence.
    expect(explainCandidate(strong, [], [strong, weak])).not.toBe(
      explainCandidate(weak, [], [strong, weak]),
    );
  });

  it('notes a closer match when source counts tie but confidence differs', () => {
    const a = candidate({ id: 'a', confidence: 90, sources: ['x'] });
    const b = candidate({ id: 'b', confidence: 60, sources: ['y'] });
    expect(explainCandidate(b, [], [a, b])).toMatch(/supported by more closely matching evidence/i);
  });

  it('adds no comparison when there is only one candidate', () => {
    const text = explainCandidate(strong, [], [strong]);
    expect(text).not.toMatch(/strongest supporting evidence|fewer sources|more closely/i);
  });

  it('never implies the system has identified the correct person', () => {
    for (const c of [strong, weak]) {
      const text = explainCandidate(c, [], [strong, weak]);
      expect(text).not.toMatch(
        /most likely correct|definitely|correct person|correct identity|intended person|person you meant/i,
      );
    }
  });

  it('still says nothing unsupported', () => {
    const text = explainCandidate(weak, [], [strong, weak]);
    expect(text).not.toMatch(/Alex Rivera|Northwind|Bengaluru/);
    expect(text.split(/(?<=\.)\s+/).filter(Boolean).length).toBeLessThanOrEqual(2);
  });
});
