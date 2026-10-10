// Flow 422 (AC6): how many criteria of the flows frozen in the last 7 days carry no verification kind. The
// share goes into `sync-status.md` so a week of untagged criteria is visible. Reports, never gates.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseAcKinds } from "../flow/ac-kinds";

export const KIND_WINDOW_DAYS = 7;
/** A share above this (in percent) gets a warning line. */
export const KIND_WARN_PERCENT = 20;

export interface FrozenFlow {
  /** When the flow's last `frozen` history entry was written. */
  frozenAt: Date;
  total: number;
  unclassified: number;
}

/** The flows with a `frozen` history entry, with their criteria counted by the same parser the freeze uses. Unreadable flows are skipped. */
export async function collectFrozenFlows(root: string): Promise<FrozenFlow[]> {
  const flowsDir = path.join(root, ".metaproject", "flows");
  let names: string[];
  try {
    names = await readdir(flowsDir);
  } catch {
    return [];
  }
  const out: FrozenFlow[] = [];
  for (const name of names.sort()) {
    try {
      const flow = JSON.parse(await readFile(path.join(flowsDir, name, "flow.json"), "utf8")) as { history?: unknown };
      if (!Array.isArray(flow.history)) continue;
      let frozenAt: Date | null = null;
      for (const entry of flow.history as Array<{ at?: unknown; event?: unknown }>) {
        if (entry?.event !== "frozen" || typeof entry.at !== "string") continue;
        const at = new Date(entry.at);
        if (!Number.isNaN(at.getTime())) frozenAt = at;
      }
      if (frozenAt === null) continue;
      const { criteria } = parseAcKinds(await readFile(path.join(flowsDir, name, "acceptance-criteria.md"), "utf8"));
      out.push({ frozenAt, total: criteria.length, unclassified: criteria.filter((c) => c.record.kind === "unclassified").length });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * The status lines. The window is the 7 x 24 hours before `now` (the sync's run clock, UTC): a flow counts when
 * its last `frozen` entry is later than `now` minus 7 days and not later than `now`.
 */
export function renderKindShare(flows: readonly FrozenFlow[], now: Date): string[] {
  const from = now.getTime() - KIND_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inWindow = flows.filter((flow) => flow.frozenAt.getTime() > from && flow.frozenAt.getTime() <= now.getTime());
  const definition = `- Определение (definition): flows whose last \`frozen\` history entry is within ${KIND_WINDOW_DAYS} days before the run time above (UTC clock of this run); criteria are the \`- ACn:\` lines of each flow's acceptance-criteria.md; unclassified means no \`[verify: ...]\` marker or a malformed one.`;
  if (inWindow.length === 0) return [`- verification kinds: no flows frozen in the last ${KIND_WINDOW_DAYS} days`, definition];
  const criteria = inWindow.reduce((sum, flow) => sum + flow.total, 0);
  const unclassified = inWindow.reduce((sum, flow) => sum + flow.unclassified, 0);
  if (criteria === 0) return [`- verification kinds, flows frozen in the last ${KIND_WINDOW_DAYS} days: ${inWindow.length} flows, 0 criteria`, definition];
  const percent = Math.round((unclassified / criteria) * 100);
  const lines = [`- verification kinds, flows frozen in the last ${KIND_WINDOW_DAYS} days: ${inWindow.length} flows, ${criteria} criteria, unclassified ${unclassified} (${percent}%)`];
  // The rounded percent that is printed is the one compared, so the line and the warning never disagree.
  if (percent > KIND_WARN_PERCENT) {
    lines.push(`- WARNING: unclassified share ${percent}% is above ${KIND_WARN_PERCENT}%: criteria are being frozen without a verification kind.`);
  }
  lines.push(definition);
  return lines;
}
