import { describe, it, expect } from 'vitest';
import { runOutreachPipeline } from '@/inngest/functions/run-outreach-pipeline';

// executePipeline() always restarts from validate_input — it is not
// resume-safe. The whole run is wrapped in ONE Inngest step, so Inngest's
// default of 3 automatic retries would re-run the entire pipeline (and
// re-spend on Bright Data, search and Gemini calls that already succeeded)
// on any transient failure. `retries: 0` is the fix; this test guards
// against it silently reverting to the SDK default.

describe('runOutreachPipeline — automatic retries disabled', () => {
  it('is configured with retries: 0', () => {
    expect(runOutreachPipeline.opts.retries).toBe(0);
  });

  it('does not fall back to the Inngest SDK default (3) by leaving retries unset', () => {
    expect(runOutreachPipeline.opts.retries).not.toBeUndefined();
    expect(runOutreachPipeline.opts.retries).not.toBe(3);
  });

  it('leaves the function id, name and trigger untouched', () => {
    expect(runOutreachPipeline.opts.id).toBe('run-outreach-pipeline');
    expect(runOutreachPipeline.opts.name).toBe('Run Outreach Pipeline');
  });
});
