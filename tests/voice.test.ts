import { describe, it, expect } from 'vitest';
import { checkVoice, scannableText, MIN_WORDS, MAX_WORDS } from '@/lib/generation/voice';
import { VOICE_SAMPLES, PROHIBITED_SAMPLES, SHORT_SAMPLES } from './fixtures/voice-samples';

// The voice policy lives in the prompt; these tests verify it in CODE, so a
// model that ignores the instruction still cannot ship the draft silently.
//
// The important boundary: style rules apply to the sender's own prose, never to
// verified evidence. A prospect who actually said "transformative" must stay
// quotable, or the checker would push the pipeline toward misquoting sources.

describe('prohibited AI constructions are rejected', () => {
  for (const sample of PROHIBITED_SAMPLES) {
    it(`rejects ${sample.rule}`, () => {
      const result = checkVoice(sample.text);
      expect(result.passed, `expected "${sample.rule}" to be caught`).toBe(false);
      expect(result.failures.length).toBeGreaterThan(0);
    });
  }
});

describe('specific prohibited patterns', () => {
  const wrap = (s: string) =>
    // Padded to a valid length so only the pattern under test can fail it.
    `Hi Priya, saw the hiring push at Northwind and wanted to ask about it. ${s} We work with data teams going through the same rebuild, mostly on pipeline reliability and handover. Curious whether that is the part that worries you most, or whether the harder problem sits elsewhere. Best, Sam`;

  const cases: [string, string][] = [
    ['it\'s not X, it\'s Y', 'It\'s not scale, it\'s reliability.'],
    ['it\'s not just X, it\'s Y', 'It\'s not just hiring, it\'s architecture.'],
    ['less about X, more about Y', 'Less about headcount, more about tooling.'],
    ['the real question isn\'t', 'The real question isn\'t cost.'],
    ['here\'s the thing', 'Here\'s the thing about reporting stacks.'],
    ['it\'s worth noting', 'It\'s worth noting that timing matters here.'],
    ['at the end of the day', 'At the end of the day the data has to land.'],
    ['in today\'s world', 'In today\'s world reporting is never finished.'],
    ['at the intersection of', 'You sit at the intersection of data and finance.'],
    ['unlock', 'This helps teams unlock better reporting.'],
    ['leverage', 'Teams leverage the pipeline for reporting.'],
    ['reimagine', 'A chance to reimagine the reporting stack.'],
    ['transformative', 'That is a transformative change for reporting.'],
    ['game-changing', 'A game-changing shift for the data team.'],
    ['meaningful', 'That is meaningful progress on reporting.'],
    ['impactful', 'An impactful change to the reporting stack.'],
    ['compelling', 'A compelling reason to rebuild reporting.'],
    ['powerful', 'A powerful shift in how reporting works.'],
    ['profound', 'A profound change to the reporting stack.'],
  ];

  for (const [name, snippet] of cases) {
    it(`flags "${name}"`, () => {
      expect(checkVoice(wrap(snippet)).passed).toBe(false);
    });
  }
});

describe('punctuation rules', () => {
  const body =
    'Hi Priya, saw the hiring push at Northwind and wanted to ask about it. Six engineers is a serious commitment to make while the business keeps running on the old stack. We work with data teams going through the same rebuild, mostly on pipeline reliability and the handover between shifts. Curious whether that is the part that worries you most right now, or whether the harder problem sits somewhere else entirely. Best, Sam';

  it('rejects an em dash', () => {
    const r = checkVoice(body.replace('and wanted to ask about it.', '— six engineers is a lot.'));
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.rule === 'em_dash')).toBe(true);
  });

  it('accepts periods and commas', () => {
    expect(checkVoice(body).passed).toBe(true);
  });

  it('rejects any exclamation mark by default', () => {
    const r = checkVoice(body.replace('about it.', 'about it!'));
    expect(r.passed).toBe(false);
    expect(r.exclamations).toBe(1);
  });

  it('counts multiple exclamations', () => {
    const r = checkVoice(body.replace('about it.', 'about it!!'));
    expect(r.exclamations).toBe(2);
  });
});

describe('word count limits', () => {
  const filler = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
  /** A message of exactly n words, with no other rule violations. */
  const exactly = (n: number) => filler(n);

  it('the configured range is 40 to 130 words', () => {
    expect(MIN_WORDS).toBe(40);
    expect(MAX_WORDS).toBe(130);
  });

  // The boundary is where a length rule is either correct or quietly wrong, so
  // both sides of each edge are pinned.
  const boundaries: [number, boolean][] = [
    [39, false],
    [40, true],
    [45, true],
    [56, true],
    [59, true],
    [60, true],
    [129, true],
    [130, true],
    [131, false],
  ];

  for (const [words, shouldPass] of boundaries) {
    it(`${words} words → ${shouldPass ? 'PASS' : 'FAIL'}`, () => {
      const r = checkVoice(exactly(words));
      expect(r.wordCount).toBe(words);
      expect(
        r.issues.some((i) => i.rule === 'word_count'),
        `${words} words should ${shouldPass ? 'not ' : ''}trigger the length rule`,
      ).toBe(!shouldPass);
    });
  }

  it('rejects a message under the minimum', () => {
    const r = checkVoice('Hi Priya, saw the hiring push. Curious how it is going. Best, Sam');
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.rule === 'word_count')).toBe(true);
  });

  it('rejects a message over the maximum', () => {
    const r = checkVoice(`Hi Priya, saw the hiring push at Northwind. ${filler(MAX_WORDS + 20)}`);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.rule === 'word_count')).toBe(true);
  });

  it('accepts a message inside the configured range', () => {
    const r = checkVoice(`Hi Priya, saw the hiring push at Northwind. ${filler(MIN_WORDS + 10)}`);
    expect(r.issues.some((i) => i.rule === 'word_count')).toBe(false);
  });

  it('does not let a sign-off block push a message over the limit', () => {
    const body = `Hi Priya, saw the hiring push at Northwind. ${filler(MAX_WORDS - 20)}`;
    const withSignoff = `${body}\n\nBest regards,\nSam Whitfield\nHead of Partnerships`;
    expect(checkVoice(withSignoff).wordCount).toBe(checkVoice(body).wordCount);
  });

  it('an empty message is not reported as a length failure', () => {
    // The no-hook path produces no draft at all; that is handled upstream.
    expect(checkVoice('').issues.some((i) => i.rule === 'word_count')).toBe(false);
  });
});

describe('verified evidence is never penalised', () => {
  const quote = 'This is a transformative moment for the industry, and we are leveraging it fully.';

  it('a banned word inside the supplied verified quote does not fail the draft', () => {
    const message = `Hi Marcus, you said on the earnings call: "${quote}" That is a strong position to take publicly, and not many teams in the sector are willing to say it that plainly. We work with teams making the same shift, mostly on the reporting side of it. Curious how you are approaching it internally, or whether that question is settled already. Best, Sam`;
    expect(checkVoice(message, { quotes: [quote] }).passed).toBe(true);
  });

  it('the same banned word in the sender\'s own prose does fail', () => {
    const message = `Hi Marcus, this is a transformative moment for your industry and we are leveraging it fully across the sector. We work with teams making the same shift, mostly on the reporting side of it. Curious how you are approaching it internally, or whether that question is settled already for now. Best, Sam`;
    expect(checkVoice(message, { quotes: [quote] }).passed).toBe(false);
  });

  it('strips quoted spans even when no quote is supplied', () => {
    const text = scannableText('He said "this is transformative work" in the interview.');
    expect(text).not.toMatch(/transformative/);
  });

  it('leaves the sender\'s prose intact when stripping', () => {
    const text = scannableText('We build reporting tools. He said "it is transformative".');
    expect(text).toMatch(/We build reporting tools/);
  });

  it('ignores a quote too short to be meaningful evidence', () => {
    // A 4-character "quote" would strip half the message if honoured.
    const message = `Hi Priya, this is a transformative change for the team at Northwind and worth asking about. We work with data teams going through the same rebuild, mostly on pipeline reliability and the handover work between shifts. Curious whether that is the part that worries you most right now, or something else. Best, Sam`;
    expect(checkVoice(message, { quotes: ['data'] }).passed).toBe(false);
  });
});

describe('fixture drafts: before and after', () => {
  for (const sample of VOICE_SAMPLES) {
    it(`${sample.scenario} — the old draft is rejected`, () => {
      expect(checkVoice(sample.before, { quotes: [sample.quote] }).passed).toBe(false);
    });

    it(`${sample.scenario} — the rewritten draft passes`, () => {
      const r = checkVoice(sample.after, { quotes: [sample.quote] });
      expect(r.passed, `failures: ${r.failures.join(' | ')}`).toBe(true);
    });
  }

  it('every rewritten draft stays inside the length target', () => {
    for (const s of VOICE_SAMPLES) {
      const r = checkVoice(s.after, { quotes: [s.quote] });
      expect(r.wordCount).toBeGreaterThanOrEqual(MIN_WORDS);
      expect(r.wordCount).toBeLessThanOrEqual(MAX_WORDS);
    }
  });

  it('no rewritten draft uses an em dash or an exclamation mark', () => {
    for (const s of VOICE_SAMPLES) {
      expect(s.after).not.toMatch(/—/);
      expect(s.after).not.toMatch(/!/);
    }
  });

  it('rewritten drafts keep the verified detail rather than dropping it', () => {
    // Rewriting for voice must not quietly remove the reason for writing.
    const hiring = VOICE_SAMPLES[0];
    expect(hiring.after).toMatch(/six data engineers/i);
    expect(hiring.after).toMatch(/Northwind/);
  });
});

describe('short drafts are judged on quality, not length', () => {
  for (const sample of SHORT_SAMPLES) {
    it(`${sample.scenario} passes every check`, () => {
      const r = checkVoice(sample.text, { quotes: [sample.quote] });
      expect(r.passed, `failures: ${r.failures.join(' | ')}`).toBe(true);
      expect(r.issues.filter((i) => i.severity === 'block')).toEqual([]);
    });

    it(`${sample.scenario} really is in the 40-59 band`, () => {
      const { wordCount } = checkVoice(sample.text, { quotes: [sample.quote] });
      expect(wordCount).toBeGreaterThanOrEqual(40);
      expect(wordCount).toBeLessThan(60);
    });

    it(`${sample.scenario} keeps its verified detail`, () => {
      // A short draft still has to carry the reason for writing. Brevity is not
      // permission to drop the specific fact that justified contact.
      for (const anchor of sample.anchors) {
        expect(sample.text.toLowerCase()).toContain(anchor.toLowerCase());
      }
    });
  }

  it('a short message is NOT exempt from the other voice rules', () => {
    // Same length as the good short drafts, but generated-sounding. The lower
    // floor must not become a loophole.
    const short =
      'Hi Priya, I was really impressed by the exciting work at Northwind and wanted to reach out about it today. It is not just hiring, it is a transformative shift for the whole sector. Can I steal 15 minutes to unlock some meaningful next steps for your remarkable team this week?';
    const r = checkVoice(short);
    expect(r.wordCount).toBeGreaterThanOrEqual(MIN_WORDS);
    expect(r.passed).toBe(false);
    expect(r.issues.some((i) => i.rule === 'word_count')).toBe(false);
    // It fails on substance, not on size.
    expect(
      r.issues.filter((i) => i.rule !== 'word_count' && i.severity === 'block').length,
    ).toBeGreaterThan(2);
  });

  it('drafts that were previously rejected only for length now pass', () => {
    // 45 words, one verified detail, plain and specific. Under the old floor
    // this was sent back for padding.
    const draft =
      'Hi Marcus, noticed Halcyon started publishing its incident reports publicly. Not many teams do that. We build tooling for engineering teams that report externally, mostly to take the write-up load off whoever is on call. Curious whether that is a real cost for you.';
    const r = checkVoice(draft);
    expect(r.wordCount).toBeGreaterThanOrEqual(40);
    expect(r.wordCount).toBeLessThan(60);
    expect(r.passed, `failures: ${r.failures.join(' | ')}`).toBe(true);
  });
});

describe('the checker does not over-fire on legitimate prose', () => {
  const good = [
    'Hi Priya, saw that Northwind is hiring six data engineers to rebuild the reporting stack. That is a big lift to take on alongside everything else the team is already running day to day. We work with data teams going through the same rebuild, mostly on the pipeline reliability side of it. Curious whether that is the part you are most worried about, or whether the harder problem is somewhere else. Best, Sam',
    'Hi Tom, noticed Vela launched the API marketplace in March. Opening a platform to third-party developers tends to change what support looks like fairly quickly, usually inside the first two quarters. We work with teams just after that shift, mainly on developer onboarding and the documentation around it. Interested to hear how the first few months have gone, if you are up for sharing any of it. Best, Sam',
  ];

  for (const [i, text] of good.entries()) {
    it(`passes a plain, specific draft (${i + 1})`, () => {
      const r = checkVoice(text);
      expect(r.passed, `failures: ${r.failures.join(' | ')}`).toBe(true);
      expect(r.issues.filter((x) => x.severity === 'block')).toEqual([]);
    });
  }

  it('does not treat a closing question as a rhetorical transition', () => {
    const r = checkVoice(good[0]);
    expect(r.issues.some((i) => i.rule === 'rhetorical_question')).toBe(false);
  });

  it('a mid-message question is warned about, not blocked', () => {
    const text =
      'Hi Priya, saw the hiring push at Northwind. Is the reporting stack the hard part here? We work with data teams going through the same rebuild, mostly on pipeline reliability and the handover work between shifts, which is usually where it hurts. Happy to compare notes if that would be useful to you at all, or to leave it there. Best, Sam';
    const r = checkVoice(text);
    expect(r.issues.some((i) => i.rule === 'rhetorical_question' && i.severity === 'warn')).toBe(true);
    expect(r.passed).toBe(true);
  });

  it('allows natural contractions', () => {
    const text =
      "Hi Priya, saw the hiring push at Northwind and I'd like to ask about it. You're rebuilding while the business keeps running on the old stack, and we've worked with data teams doing exactly that. It's usually the handover between shifts that causes the most trouble. Curious whether pipeline reliability is the part that worries you most right now. Best, Sam";
    expect(checkVoice(text).passed).toBe(true);
  });
});

describe('reported detail is usable as a regeneration directive', () => {
  it('names the offending text so the model can fix it precisely', () => {
    const r = checkVoice(PROHIBITED_SAMPLES[0].text);
    expect(r.failures.join(' ')).toMatch(/it'?s not just/i);
    expect(r.issues[0].match.length).toBeGreaterThan(0);
  });

  it('separates blocking issues from warnings', () => {
    const r = checkVoice(PROHIBITED_SAMPLES[2].text);
    expect(r.issues.some((i) => i.severity === 'block')).toBe(true);
    expect(r.passed).toBe(false);
  });
});
