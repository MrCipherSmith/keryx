// Acceptance layer W0 (AC13): the TUI half of `keryx flow ac kinds`. The AC tab
// of `/flows` (and `/ac`) lists a flow's acceptance criteria; this module gives
// it each criterion's verification kind and the same distribution block
// `keryx flow freeze` prints, so the two surfaces never say different things.
//
// Pure formatting over the DERIVED `acKinds` of a flow, read once by
// `loadInspectorFlows`. Nothing here gates, refuses or runs anything.

import { describeAcKind, reportFromRecords, renderAcKindDistribution } from "../flow/service";
import type { FlowInspectorItem } from "./inspector-sources";

/** Column the kind starts in, so the rows line up under `AC12`. */
const ID_WIDTH = 5;

/**
 * The kinds section of the AC tab: the distribution block, then one row per
 * criterion (`AC1   exec \`bun test …\``). A flow frozen before kinds existed has
 * no `acKinds`; that reads as "not recorded" (every criterion unclassified), never
 * as an empty list and never as `none`.
 */
export function formatAcKindLines(item: FlowInspectorItem): string[] {
  if (item.acKinds === undefined) {
    return [
      "Verification kinds: not recorded (this flow was frozen before kinds existed; every criterion reads unclassified).",
    ];
  }
  const report = reportFromRecords(item.id, item.acKinds);
  const rows = Object.entries(report.criteria).map(([id, record]) => `${id.padEnd(ID_WIDTH)}${describeAcKind(record)}`);
  return [...renderAcKindDistribution(report), "", ...(rows.length === 0 ? ["(no criteria)"] : rows)];
}
