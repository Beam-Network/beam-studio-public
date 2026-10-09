export type RunSummaryCounts = {
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
};

/**
 * The hint under the run count. Cancelled, queued and running runs are
 * neither completed nor failed, so "all completed" is only true when every
 * run completed.
 */
export function runSummaryHint(counts: RunSummaryCounts) {
  if (counts.failedRunCount) return `${counts.failedRunCount} failed`;
  if (!counts.runCount) return "none yet";
  if (counts.completedRunCount === counts.runCount) return "all completed";
  return `${counts.completedRunCount} of ${counts.runCount} completed`;
}
