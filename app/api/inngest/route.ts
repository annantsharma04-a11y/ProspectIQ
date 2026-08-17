import { serve } from 'inngest/next';
import { NextResponse, type NextRequest } from 'next/server';
import { inngest } from '@/inngest/client';
import { runOutreachPipeline } from '@/inngest/functions/run-outreach-pipeline';

// Durable-execution endpoint. It is an invocation path into the pipeline, so it
// bypasses the session guards the other routes use — Inngest authenticates by
// request signature instead.
//
// It is therefore served only when Inngest is genuinely configured: enabled AND
// holding a signing key to verify against. Left open with no signing key, an
// unsigned POST could trigger pipeline work for an arbitrary run id.

const enabled =
  process.env.USE_INNGEST === 'true' && Boolean(process.env.INNGEST_SIGNING_KEY?.trim());

const handlers = enabled
  ? serve({
      client: inngest,
      functions: [runOutreachPipeline],
    })
  : null;

/** Indistinguishable from a route that does not exist. */
function disabled(): NextResponse {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

type Ctx = Parameters<NonNullable<typeof handlers>['GET']>[1];

export async function GET(req: NextRequest, ctx: Ctx) {
  return handlers ? handlers.GET(req, ctx) : disabled();
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return handlers ? handlers.POST(req, ctx) : disabled();
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  return handlers ? handlers.PUT(req, ctx) : disabled();
}
