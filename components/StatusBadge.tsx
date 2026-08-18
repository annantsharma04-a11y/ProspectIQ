// The shared "status = dot + label" primitive.
//
// One small colored dot plus a plain-text label inside a subtle, translucent
// pill — the one shape every status/classification indicator in the app
// should use (run status, qualification, stage status). Restrained on
// purpose: color communicates state, but never as a solid, heavy fill.

export type StatusTone = 'emerald' | 'amber' | 'red' | 'accent' | 'neutral';

const TONE_BADGE: Record<StatusTone, string> = {
  emerald: 'bg-emerald-600/10 text-emerald-700',
  amber: 'bg-amber-600/10 text-amber-800',
  red: 'bg-red-600/10 text-red-700',
  accent: 'bg-accent/10 text-accent',
  neutral: 'bg-ink/6 text-muted',
};

const TONE_DOT: Record<StatusTone, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  accent: 'bg-accent',
  neutral: 'bg-faint',
};

export function StatusBadge({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_BADGE[tone]} ${className}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} aria-hidden="true" />
      {children}
    </span>
  );
}

/** Just the dot, for places a full pill is too heavy (list rows, stage rows). */
export function StatusDot({ tone = 'neutral', className = '' }: { tone?: StatusTone; className?: string }) {
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[tone]} ${className}`} aria-hidden="true" />;
}
