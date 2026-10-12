// Flow 384 (AC7): the two flow-folder hygiene problems `keryx flow check`
// reports, as a short tag beside a flow's row and a line in its detail view.
//
// Fed from the flow service's own `check` result — never recomputed here — and
// computed once per list refresh, not per row or per paint. A failure to read it
// is silent: the tags are informational, and `keryx flow check` owns the report.

import type { FlowCheckResult } from "../flow/types";

export type FlowHygieneTag = "dup id" | "not committed";

export type FlowHygiene = {
  tags: FlowHygieneTag[];
  /** The `flow check` message behind each tag, for the detail view. */
  notes: string[];
};

/** Folder name → what is wrong with it. A folder with nothing wrong has no entry. */
export type FlowHygieneMap = ReadonlyMap<string, FlowHygiene>;

export function hygieneFromCheck(check: Pick<FlowCheckResult, "issues" | "warnings">): Map<string, FlowHygiene> {
  const map = new Map<string, FlowHygiene>();
  const add = (dir: string, tag: FlowHygieneTag, message: string): void => {
    const entry = map.get(dir) ?? { tags: [], notes: [] };
    if (!entry.tags.includes(tag)) entry.tags.push(tag);
    entry.notes.push(message);
    map.set(dir, entry);
  };
  for (const issue of check.issues) {
    if (issue.kind === "duplicate-id") add(issue.flow, "dup id", issue.message);
  }
  for (const warning of check.warnings ?? []) {
    if (warning.kind === "untracked") add(warning.flow, "not committed", warning.message);
  }
  return map;
}

/**
 * One `service.check` pass for the whole list. `check` is injectable for tests;
 * the default builds the real service in `cwd` (imported lazily, so this module
 * stays free of the command layer's import graph).
 */
export async function loadFlowHygiene(
  cwd: string,
  check?: (cwd: string) => Promise<Pick<FlowCheckResult, "issues" | "warnings">>,
): Promise<Map<string, FlowHygiene>> {
  try {
    const run =
      check ??
      (async (dir: string) => {
        const [{ flowServiceDeps }, { createFlowService }] = await Promise.all([import("../commands/flow"), import("../flow/service")]);
        return createFlowService(flowServiceDeps()).check({ cwd: dir });
      });
    return hygieneFromCheck(await run(cwd));
  } catch {
    return new Map();
  }
}

/** The tag text beside a row: `  [dup id] [not committed]`, or nothing. */
export function formatHygieneTags(hygiene: Pick<FlowHygiene, "tags"> | undefined): string {
  return hygiene === undefined || hygiene.tags.length === 0 ? "" : `  ${hygiene.tags.map((tag) => `[${tag}]`).join(" ")}`;
}
