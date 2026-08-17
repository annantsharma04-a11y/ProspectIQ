// Methodology text for the performance dashboard's info affordances.
//
// Two sources, deliberately:
//
//   * Rate metrics carry their own `definition` string, written next to the
//     arithmetic in metrics.ts. The dashboard reads THAT, so a formula and its
//     explanation cannot drift apart.
//   * Sections describing a whole panel rather than one ratio get their text
//     here: scope and counting level, never a restated formula.
//
// Kept to one or two sentences. A tooltip is a reminder, not documentation —
// the longer these ran, the larger the floating panel became, and a tooltip
// that covers the number it explains is worse than no tooltip.
//
// Nothing here invents a definition. A section with no useful explanation gets
// no entry, and the UI renders no icon rather than an empty one.

/** Panel-level scope notes, keyed by the panel title shown on the page. */
export const PANEL_DEFINITIONS: Record<string, string> = {
  'Pipeline funnel':
    'Run-level funnel. Each step counts runs that reached that stage, so counts are monotonic.',
  'Current bottleneck':
    'Largest step-to-step funnel loss, excluding final human review. Reported only when the loss is at least 10% of submitted runs.',
  'Failure analysis':
    'Runs that ended without a draft, counted once each under the earliest reason. In-flight runs are excluded.',
  Volume:
    'Run-level counts by status, windowed on run creation time.',
  Trends:
    'This window versus the preceding window of equal length. Shown only when the previous window has runs.',
  'Provider performance':
    'Provider outcomes recorded on runs and sources. Individual calls are not timed, so latency and timeouts cannot be separated.',
  'Not measured':
    'Metrics the current schema cannot support. Listed rather than hidden; no value here is estimated.',
  'Pipeline at a glance':
    'Milestones, not gates. A run may legitimately skip some of these. Full funnel is in Diagnostics.',
  'What ProspectIQ does well':
    'Each claim is gated on current data. A claim the data stops supporting disappears rather than being reworded.',
};

/** Overview figures that are counts rather than ratios, so carry no Rate. */
export const OVERVIEW_DEFINITIONS: Record<string, string> = {
  'Active prospects':
    'Distinct prospects with a run in this window. A person researched repeatedly counts once.',
  'Research runs':
    'Runs created in this window, one per execution. A retry reuses its run row, so it stays one run.',
  'Median runtime':
    'Median duration across runs with both start and completion timestamps.',
  'P95 runtime':
    '95th-percentile run duration, over the same timed runs as the median.',
  'Human review':
    'Every draft is held for a person to approve, edit or reject. ProspectIQ has no sending capability.',
};

/** Every static definition, for validation in tests. */
export const STATIC_DEFINITIONS = { ...PANEL_DEFINITIONS, ...OVERVIEW_DEFINITIONS };
