/**
 * `value` as a plain JSON object (not null, not an array), else undefined: the one narrowing of parsed package JSON the
 * review modules share. A leaf module, so a reader on either side of the coverage/research import edge can use it.
 */
export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * The run objects of a dispatch record (research.json's `dispatch`): each one a plain object, [] when there are none.
 * The one walk of `dispatch.runs`; `dispatchRuns` (research.ts) reads the typed fields of each.
 */
export function dispatchRunRecords(dispatch: unknown): Array<Record<string, unknown>> {
  const runs = asRecord(dispatch)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((value) => {
    const run = asRecord(value);
    return run === undefined ? [] : [run];
  });
}
