import { Inngest } from 'inngest';

export const inngest = new Inngest({ id: 'ps3-outreach-engine' });

export const OUTREACH_RUN_REQUESTED = 'outreach/run.requested';

export interface OutreachRunRequestedEvent {
  name: typeof OUTREACH_RUN_REQUESTED;
  data: { runId: string };
}
