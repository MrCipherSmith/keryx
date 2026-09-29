// How an approval reads to a person (flow 369): one place for the CLI, the
// readline command and the TUI modal, so the three never describe it differently.
// Pure; nothing here touches the store or the clock on its own.

import type { ApprovalView } from "./serve-approvals-store";

export const RECENT_RESOLVED_LIMIT = 10;

export function expiresInLabel(view: Pick<ApprovalView, "state" | "expiresAt">, now: Date): string {
  if (view.state !== "pending") {
    return "-";
  }
  const seconds = Math.ceil((Date.parse(view.expiresAt) - now.getTime()) / 1000);
  if (seconds <= 0) {
    return "expired";
  }
  if (seconds < 60) {
    return `expires in ${seconds}s`;
  }
  return `expires in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export interface ApprovalListing {
  pending: ApprovalView[];
  resolved: ApprovalView[];
}

/** Pending oldest first, resolved newest first and bounded. Due pending records count as resolved. */
export function splitApprovals(views: readonly ApprovalView[], now: Date, recentLimit: number = RECENT_RESOLVED_LIMIT): ApprovalListing {
  const isPending = (view: ApprovalView): boolean => view.state === "pending" && Date.parse(view.expiresAt) > now.getTime();
  const pending = views.filter(isPending).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const resolved = views
    .filter((view) => !isPending(view))
    .sort((a, b) => (b.resolvedAt ?? b.expiresAt).localeCompare(a.resolvedAt ?? a.expiresAt))
    .slice(0, Math.max(0, recentLimit));
  return { pending, resolved };
}

export function stateLabel(view: ApprovalView, now: Date): string {
  return view.state === "pending" && Date.parse(view.expiresAt) <= now.getTime() ? "expired" : view.state;
}

/** The lines one approval takes in a text listing. */
export function approvalLines(view: ApprovalView, now: Date): string[] {
  const state = stateLabel(view, now);
  const head = view.state === "pending" ? `${state} - ${expiresInLabel(view, now)}` : state;
  const lines = [`${view.approvalId}  ${head}`, `  ${view.summary}`, `  Scope: ${view.scope}`, `  Consequence: ${view.consequence}`];
  if (view.state !== "pending" && view.reason !== undefined) {
    lines.push(`  Reason: ${view.reason}`);
  }
  return lines;
}

export function approvalsText(views: readonly ApprovalView[], now: Date, options: { all: boolean }): string[] {
  const { pending, resolved } = splitApprovals(views, now);
  const out: string[] = [];
  if (pending.length === 0) {
    out.push("No pending approvals.");
  } else {
    out.push(`Pending approvals (${pending.length}):`);
    for (const view of pending) {
      out.push("", ...approvalLines(view, now));
    }
  }
  if (options.all && resolved.length > 0) {
    out.push("", `Recently resolved (${resolved.length}):`);
    for (const view of resolved) {
      out.push("", ...approvalLines(view, now));
    }
  }
  return out;
}
