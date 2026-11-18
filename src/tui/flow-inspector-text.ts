// The pure, OpenTUI-free half of `flow-inspector.ts`: the /flows and /ac text the
// readline shell and the ACP `shell` profile print. `flow-inspector.ts` re-exports it.

import { originDetailLines } from "../flow/service";
import { formatHygieneTags } from "./flow-hygiene";
import { sortFlowsNewestFirst, type AcMarker, type FlowInspectorItem } from "./inspector-sources";

export const FLOWS_COMMAND = "/flows";
/** Flow 328, AC7: `/ac` opens the same modal straight to the AC tab of the current flow. */
export const AC_COMMAND = "/ac";

/** Flow 328, AC7: one line per criterion — English, fixed marker glyphs so a screen reader/log reads the same word every time. */
const MARKER_GLYPH: Readonly<Record<AcMarker["status"], string>> = {
  "likely-met": "[met]",
  "not-evident": "[not evident]",
  "not-checkable": "[not checkable]",
};

/** The compact per-criterion summary the list row and the AC tab both use. */
export function formatAcMarkersSummary(item: FlowInspectorItem): string {
  if (item.acMarkers === undefined || item.acMarkers.length === 0) {
    return "AC: not run";
  }
  const counts = item.acMarkers.reduce(
    (acc, marker) => {
      if (marker.status === "likely-met") acc.met += 1;
      else if (marker.status === "not-evident") acc.notEvident += 1;
      else acc.notCheckable += 1;
      return acc;
    },
    { met: 0, notEvident: 0, notCheckable: 0 },
  );
  const staleNote =
    item.acCheckStale === true
      ? " (stale — the criteria or the diff changed since this check)"
      : item.acCheckStale === "unknown"
        ? " (freshness unknown — could not compute the current diff quickly)"
        : "";
  return `AC: ${counts.met} met, ${counts.notEvident} not evident, ${counts.notCheckable} not checkable${staleNote}`;
}

/** Flow 328, AC7: the AC tab's detail lines — per criterion, with evidence when a Jev call produced a probability. */
export function formatAcCheckLines(item: FlowInspectorItem): string[] {
  if (item.acMarkers === undefined || item.acMarkers.length === 0) {
    return ["No acceptance-criteria check has been run for this flow yet.", "Press `c` to run `keryx flow check-ac` now."];
  }
  const freshnessNote =
    item.acCheckStale === true
      ? "  (STALE — the criteria or the diff changed since this check; press `c` to re-check)"
      : item.acCheckStale === "unknown"
        ? "  (FRESHNESS UNKNOWN — could not compute the current diff quickly; press `c` to re-check)"
        : "";
  const lines: string[] = [`Last checked: ${item.acCheckedAt ?? "unknown"}${freshnessNote}`, ""];
  for (const marker of item.acMarkers) {
    lines.push(`${marker.id}  ${MARKER_GLYPH[marker.status]}`);
  }
  lines.push("", "Press `c` to re-check now.");
  return lines;
}

export function isFlowsCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === FLOWS_COMMAND;
}

/** Flow 328, AC7: `/ac` — an entry point straight to the AC tab of the currently active flow. */
export function isAcCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === AC_COMMAND;
}

export function findFlowItem(
  items: readonly FlowInspectorItem[],
  query: string,
): FlowInspectorItem | undefined {
  const needle = query.trim();
  if (needle.length === 0) {
    return undefined;
  }
  const padded = /^\d+$/.test(needle) ? needle.padStart(3, "0") : needle;
  return (
    items.find((item) => item.id === needle || item.id === padded || item.dir === needle || item.dir.endsWith(`/${needle}`)) ??
    items.find((item) => item.slug === needle)
  );
}

/** The status column: `completing (interrupted)` when nothing is running the completion (flow 299). */
function statusCell(item: FlowInspectorItem): string {
  return item.interrupted ? `${item.status} (interrupted)` : item.status;
}

export function formatFlowListLines(items: readonly FlowInspectorItem[], selected: number): string[] {
  if (items.length === 0) {
    return ["No flows in this project."];
  }
  return items.map((item, index) => {
    const mark = index === selected ? ">" : " ";
    return `${mark} ${item.id}  ${statusCell(item)}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}${formatHygieneTags(item.hygiene)}`;
  });
}

export function formatFlowDetailLines(item: FlowInspectorItem): string[] {
  const taskLines =
    item.tasks.length === 0
      ? ["  (no tasks)"]
      : item.tasks.map((task) => `  ${task.id}  ${task.status}  ${task.title}`);
  return [
    `${item.id}  ${item.title}`,
    `Status   ${item.status}`,
    `Outcome author  ${item.outcomeAuthor ?? "unknown"}`,
    ...originDetailLines(item.origin),
    ...(item.interrupted ? [`         ${item.interrupted}`] : []),
    ...(item.uncommitted ? [`         note: ${item.uncommitted}`] : []),
    ...(item.hygiene?.notes ?? []).map((note) => `         ${note}`),
    `Dir      ${item.dir}`,
    `Tasks    ${item.tasksDone}/${item.tasksTotal}`,
    `PR       ${item.prUrl ?? "—"}`,
    `Source   ${item.source}`,
    `Created  ${item.createdAt}`,
    `Updated  ${item.updatedAt}`,
    "",
    "Tasks",
    ...taskLines,
  ];
}

export function formatFlowListText(items: readonly FlowInspectorItem[]): string {
  const ordered = sortFlowsNewestFirst(items);
  if (ordered.length === 0) {
    return "Flows\n  No flows in this project.\n";
  }
  return [
    "Flows",
    ...ordered.map(
      (item) => `  ${item.id}  ${statusCell(item)}  ${item.tasksDone}/${item.tasksTotal}  ${item.title}${formatHygieneTags(item.hygiene)}`,
    ),
    "",
  ].join("\n");
}

export function formatFlowDetailText(item: FlowInspectorItem): string {
  return `${formatFlowDetailLines(item).join("\n")}\n`;
}
