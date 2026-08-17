import { serve } from 'inngest/next';
import { inngest } from '@/inngest/client';
import { runOutreachPipeline } from '@/inngest/functions/run-outreach-pipeline';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runOutreachPipeline],
});
