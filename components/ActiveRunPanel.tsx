'use client';

import { useState } from 'react';
import { LiveRunView } from './LiveRunView';
import type { RunSnapshot } from '@/lib/types';

/**
 * Thin state holder so the Command Center can embed the EXISTING LiveRunView
 * unchanged — same realtime subscription, same stage list, same retry
 * affordances Workspace.tsx already uses on the run page. This component adds
 * no pipeline behavior of its own; it only owns the snapshot state
 * `onSnapshot` needs somewhere to live.
 */
export function ActiveRunPanel({ initial }: { initial: RunSnapshot }) {
  const [snapshot, setSnapshot] = useState(initial);
  return <LiveRunView runId={snapshot.run.id} snapshot={snapshot} onSnapshot={setSnapshot} />;
}
