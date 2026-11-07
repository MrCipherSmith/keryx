// Why an approval prompt appears: one cause from a closed set, one line the operator reads
// in the TUI modal, the readline shell and the Telegram relay (flow 426 AC5). Pure.

import { SHELL_TOOL_NAMES } from "../lib/shell-tool-names";
import type { ApprovalMeta } from "./agent";

export const APPROVAL_CAUSES = [
  "destructive",
  "credentials",
  "publish",
  "hc-launch",
  "hook-ask",
  "untrusted-content",
  "not-in-routine-list",
  "mode-ask",
] as const;

export type ApprovalCause = (typeof APPROVAL_CAUSES)[number];

export type ApprovalCauseFlags = {
  destructive?: boolean;
  credentials?: boolean;
  /** A human-confirmation step: SAC confirm-review, `flow confirm`, or an operator-confirmed tool. */
  confirmation?: boolean;
  publishLease?: boolean;
  /** An `hc run` starts an agent the session has not granted. */
  hcLaunch?: boolean;
  hookAsk?: boolean;
  untrusted?: boolean;
  /** The call is a shell command, so an untrusted-content ask means "not in the routine list". */
  shell?: boolean;
};

/** Hard floors first, then the hook, then the untrusted-content latch, then the mode itself. */
export function classifyApprovalCause(flags: ApprovalCauseFlags): ApprovalCause {
  if (flags.destructive === true) return "destructive";
  if (flags.credentials === true || flags.confirmation === true) return "credentials";
  if (flags.publishLease === true) return "publish";
  if (flags.hcLaunch === true) return "hc-launch";
  if (flags.hookAsk === true) return "hook-ask";
  if (flags.untrusted === true) return flags.shell === true ? "not-in-routine-list" : "untrusted-content";
  return "mode-ask";
}

const CAUSE_LINES: Readonly<Record<ApprovalCause, string>> = {
  destructive: "why: destructive command — no mode lifts this",
  credentials: "why: touches credentials or needs your confirmation — no mode lifts this",
  publish: "why: a git-publish lease applies — no mode lifts this",
  "hc-launch": "why: this starts another agent outside keryx's limits — no mode lifts this",
  "hook-ask": "why: a policy hook asked about this call",
  "untrusted-content": "why: this turn holds untrusted external content",
  "not-in-routine-list": "why: untrusted external content in this turn, and the command is not in the routine list",
  "mode-ask": "why: the permission mode asks before this call",
};

/**
 * `detail` names what the cause is about; only `hc-launch` uses it (the agent, from `ApprovalMeta.hcLaunch`).
 * A caller that passes none gets the generic line.
 */
export function approvalCauseLine(cause: ApprovalCause, detail?: string): string {
  if (cause === "hc-launch" && detail !== undefined && detail.length > 0) {
    return `why: this starts ${detail} as another agent outside keryx's limits — no mode lifts this`;
  }
  return CAUSE_LINES[cause];
}

/** The cause the agent set on the meta, or one derived from the meta's flags for an approver that sets none. */
export function causeOfMeta(tool: string, meta: ApprovalMeta | undefined): ApprovalCause {
  if (meta === undefined) return "mode-ask";
  if (meta.cause !== undefined) return meta.cause;
  return classifyApprovalCause({
    destructive: meta.destructive,
    credentials: meta.credentials === true,
    confirmation: meta.alwaysAsk === true,
    publishLease: meta.publishLease === true,
    hcLaunch: meta.hcLaunch !== undefined,
    hookAsk: meta.hookAsk === true,
    untrusted: meta.untrustedOrigin === true,
    shell: SHELL_TOOL_NAMES.has(tool),
  });
}
