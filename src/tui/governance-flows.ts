// Flow 364 (AC3, AC5, AC6): the governance modal's Flows tab, as pure
// projections — which flows it lists, how an entry reads, what a check says,
// and when close is offered. No renderer here, so every rule is testable
// without OpenTUI; `governance-inspector.ts` paints what these return.

import path from "node:path";
import { completionFixHint } from "../flow/service";
import type { FlowCompleteResult, FlowCompletionCheck, GateOutcome } from "../flow/types";
import { renderEffectLine, renderSummaryLine, type FlowGovernance, type GovernanceReport } from "../governance/service";

/** What the Flows tab lists, and why it lists nothing when it does. */
export type FlowEntries = { flows: FlowGovernance[]; note: string | undefined };

/**
 * The current project's flows, open ones first, newest first within each
 * group. Check and close act on this project only, so a stored
 * `--all-projects` report contributes only its entry for `cwd`.
 */
export function flowEntriesFrom(report: GovernanceReport, cwd: string): FlowEntries {
  const project = report.projects.find((candidate) => path.resolve(candidate.root) === path.resolve(cwd));
  if (project === undefined) return { flows: [], note: "This report does not cover the current project. Press r to run one for it." };
  if (project.state === "skipped") return { flows: [], note: `The current project was skipped: ${project.reason ?? "unknown reason"}.` };
  const open = project.flows.filter((flow) => flow.status !== "done");
  const done = project.flows.filter((flow) => flow.status === "done");
  const newestFirst = (a: FlowGovernance, b: FlowGovernance): number => b.id.localeCompare(a.id, "en", { numeric: true });
  const flows = [...open.sort(newestFirst), ...done.sort(newestFirst)];
  return { flows, note: flows.length === 0 ? "No flows in this project yet." : undefined };
}

/** Whether close is offered for a flow, and if not, why. */
export type CloseOffer = { kind: "close" } | { kind: "confirm-in-terminal" } | { kind: "none"; reason: string };

/**
 * AC6: close is offered only on a check that passed every gate, saw the PR
 * merged (or a verified direct merge), and is no older than the state the list
 * shows. A flow that requires a confirmation token is pointed at the terminal
 * instead — the modal never mints one.
 */
export function closeOffer(flow: Pick<FlowGovernance, "status" | "updatedAt">, check: FlowCompletionCheck | undefined): CloseOffer {
  if (flow.status === "done") return { kind: "none", reason: "already done" };
  if (check === undefined) return { kind: "none", reason: "press c to check first" };
  if (check.updatedAt < flow.updatedAt) return { kind: "none", reason: "the flow changed since the check — press c again" };
  if (check.merge.state !== "merged") return { kind: "none", reason: `PR not merged (${check.merge.state})` };
  if (check.confirmationRequired) {
    // Without a token the confirmation gate always fails here; every OTHER gate decides.
    const othersPass = check.transition.allowed && check.gates.every((gate) => gate.name === "confirmation" || gate.status !== "fail");
    return othersPass ? { kind: "confirm-in-terminal" } : { kind: "none", reason: "the check did not pass" };
  }
  if (!check.passed) return { kind: "none", reason: "the check did not pass" };
  return { kind: "close" };
}

function gateMark(gate: GateOutcome): string {
  return gate.status === "pass" ? "✓" : gate.status === "skipped" ? "·" : "✗";
}

/** AC5: the check, one line per gate, with the fix under each failing one. */
export function formatCheckLines(check: FlowCompletionCheck): string[] {
  const lines = [
    `check at ${check.checkedAt.replace("T", " ").slice(0, 16)}: ${check.passed ? "complete would pass" : "complete would not pass"}`,
    `  ${check.transition.allowed ? "✓" : "✗"} status (${check.transition.detail})`,
    `  ${check.merge.state === "merged" ? "✓" : "·"} merge: ${check.merge.state} (${check.merge.detail})`,
  ];
  for (const gate of check.gates) {
    lines.push(`  ${gateMark(gate)} ${gate.name} (${gate.detail})`);
    const fix = completionFixHint(gate, check.id);
    if (fix !== undefined) lines.push(`      → ${fix}`);
  }
  return lines;
}

/** AC7: what a close attempt did. */
export function formatCloseLines(result: Pick<FlowCompleteResult, "passed" | "gates">): string[] {
  if (result.passed) return ["closed: flow complete passed — the flow is done"];
  return [
    "close failed: flow complete returned the flow to in-progress",
    ...result.gates.filter((gate) => gate.status === "fail").map((gate) => `  ✗ ${gate.name} (${gate.detail})`),
  ];
}

export type FlowEntryState = {
  selected: boolean;
  check: FlowCompletionCheck | undefined;
  checking: boolean;
  closing: boolean;
  closeResult: Pick<FlowCompleteResult, "passed" | "gates"> | undefined;
  error: string | undefined;
};

/** One flow in the list: a title row, the summary and effect, and for the selected flow its check and actions. */
export function formatFlowEntryLines(flow: FlowGovernance, state: FlowEntryState): string[] {
  const marker = state.selected ? "▸" : " ";
  const verdict = state.check === undefined ? "" : state.check.passed ? "  [check: would pass]" : "  [check: would not pass]";
  const lines = [`${marker} ${flow.id} ${flow.status}  ${flow.title}${verdict}`, `    ${renderSummaryLine(flow.summary)}`, `    ${renderEffectLine(flow.effect)}`];
  if (!state.selected) return lines;
  if (state.checking) lines.push("    Checking… (every completion gate, read-only)");
  else if (state.check !== undefined) lines.push(...formatCheckLines(state.check).map((line) => `    ${line}`));
  if (state.closing) lines.push("    Closing… (running flow complete)");
  else if (state.closeResult !== undefined) lines.push(...formatCloseLines(state.closeResult).map((line) => `    ${line}`));
  if (state.error !== undefined) lines.push(`    error: ${state.error}`);
  return lines;
}

/**
 * Word-wrap one line to `width`, continuation rows indented two past the
 * line's own indent, so a wrapped summary or effect still reads as part of
 * its flow. A word longer than the room left is cut, never dropped.
 */
export function wrapHanging(line: string, width: number | undefined): string[] {
  if (width === undefined || width < 16 || line.length <= width) return [line];
  const lead = /^ */.exec(line)?.[0] ?? "";
  const indent = " ".repeat(Math.min(lead.length + 2, Math.floor(width / 2)));
  const rows: string[] = [];
  let current = lead;
  let empty = true;
  for (const word of line.slice(lead.length).split(" ")) {
    const candidate = empty ? `${current}${word}` : `${current} ${word}`;
    if (candidate.length <= width) {
      current = candidate;
      empty = false;
      continue;
    }
    if (!empty) {
      rows.push(current);
      current = indent;
    }
    let piece = `${current}${word}`;
    while (piece.length > width) {
      rows.push(piece.slice(0, width));
      piece = `${indent}${piece.slice(width)}`;
    }
    current = piece;
    empty = false;
  }
  rows.push(current);
  return rows;
}

/** The actions row under the list, for the selected flow. */
export function formatActionLine(
  flow: FlowGovernance | undefined,
  offer: CloseOffer | undefined,
  confirming: { id: string; typed: string; branch: string | undefined } | undefined,
): string {
  if (confirming !== undefined) {
    const branch = confirming.branch !== undefined ? ` on branch ${confirming.branch}` : "";
    return `Close flow ${confirming.id}${branch}: type ${confirming.id} and press Enter — ${confirming.typed || "…"} (any other key cancels)`;
  }
  if (flow === undefined) return "";
  if (flow.status === "done") return `${flow.id} is done — nothing to check or close`;
  const close =
    offer === undefined || offer.kind === "none"
      ? `close: ${offer?.reason ?? "press c to check first"}`
      : offer.kind === "confirm-in-terminal"
        ? `close needs \`keryx flow confirm ${flow.id}\` in a terminal, then \`keryx flow complete ${flow.id} --confirm-token <token>\``
        : `[d] complete ${flow.id}`;
  return `[c] check ${flow.id}   ${close}`;
}
