// Flow 396: the pure rules behind "a turn that came from Telegram is gated like the shell".
//
// Two small decisions live here so a test can pin them without a terminal UI:
//   - which permission mode is in force for a turn, and why (`modeInForce`);
//   - what a Telegram approval prompt may offer to remember (`telegramRememberOffer`).
//
// Nothing here changes the risk gate itself. `agent.ts` still decides, from the mode this module
// names, whether a call asks; every floor (credentials, SAC and `flow confirm`, a publish lease,
// a hook ask, untrusted content, destructive under trust, read-only) is applied there.

import { evaluateShellApproval, type ShellApprovalEval, type ShellApprovalIO } from "../commands/shell-approval";
import type { ApprovalMeta } from "../commands/agent";
import type { PermissionMode } from "../commands/permission-mode";
import { suggestShellPatterns } from "../lib/shell-permissions";
import type { RemotePermissionMode } from "./config";
import { MAX_REMEMBER_PATTERN_CHARS } from "./protocol";

/** Where the mode in force came from. */
export type ModeSource =
  /** A Telegram-started turn, and `/mode` has not changed the shell's mode this session. */
  | "telegram-default"
  /** `/mode` changed the shell's mode this session (from the shell or the topic); it wins for every turn. */
  | "shell-mode"
  /** A turn typed in the shell, and `/mode` has not been used: the shell's own starting mode. */
  | "shell-default";

export interface ModeInForce {
  mode: PermissionMode;
  source: ModeSource;
}

/**
 * The mode a turn runs under. One permission mode exists per shell session; the saved Telegram
 * default is only the starting value for a turn that came from Telegram, until `/mode` has changed
 * the shell's mode. After that the shell's mode wins for every turn. `auto` is never reachable from
 * the default: its type excludes it.
 */
export function modeInForce(input: {
  shellMode: PermissionMode;
  changedThisSession: boolean;
  telegramTurn: boolean;
  telegramDefault: RemotePermissionMode;
}): ModeInForce {
  if (input.changedThisSession) return { mode: input.shellMode, source: "shell-mode" };
  if (input.telegramTurn) return { mode: input.telegramDefault, source: "telegram-default" };
  return { mode: input.shellMode, source: "shell-default" };
}

/** `trust (Telegram default)`, `ask (shell /mode)` or `ask (shell default)`. */
export function formatModeInForce(value: ModeInForce): string {
  const source =
    value.source === "telegram-default" ? "Telegram default" : value.source === "shell-mode" ? "shell /mode" : "shell default";
  return `${value.mode} (${source})`;
}

/** What an "Always" button on a Telegram approval would store. */
export interface RememberOffer {
  pattern: string;
  kind: "exact" | "prefix";
}

/**
 * The pattern a Telegram prompt may offer to remember, or `undefined` when nothing may be offered.
 * Offered only when the shell's own dock would offer a grant: not destructive, no credentials, no
 * SAC or `flow confirm` confirmation, no publish lease, no hook ask, no untrusted origin, and the
 * pattern passes the same validators (`suggestShellPatterns`). The exact command is preferred; the
 * first-word prefix is offered only when the exact form is not allowed (for example `docker *` stays
 * banned, so such a command never gets a prefix grant here either). A pattern too long for the
 * button request is not offered. The pattern comes from the command the shell parsed, never from
 * model text.
 */
export function telegramRememberOffer(ev: ShellApprovalEval): RememberOffer | undefined {
  if (ev.destructive || ev.credentials || ev.sacReviewConfirmation || ev.publishLease || ev.hookAsk || ev.untrustedOrigin) {
    return undefined;
  }
  const { exact, prefix, offerExact, offerPrefix } = suggestShellPatterns(ev.command);
  if (offerExact && exact.length <= MAX_REMEMBER_PATTERN_CHARS) return { pattern: exact, kind: "exact" };
  if (offerPrefix && prefix.length <= MAX_REMEMBER_PATTERN_CHARS) return { pattern: prefix, kind: "prefix" };
  return undefined;
}

export interface TelegramShellDecision {
  evaluation: ShellApprovalEval;
  /** A saved or session pattern already allows this call: no prompt, exactly as in the shell. */
  autoApprove: boolean;
  offer: RememberOffer | undefined;
}

/**
 * A `shell_exec` approval in a Telegram turn: the same evaluation the local dock runs (saved and
 * session allowlist, with every exclusion), then, when it must still ask, what the prompt may offer.
 */
export function evaluateTelegramShellApproval(input: {
  inputJson: string;
  meta?: ApprovalMeta | undefined;
  sessionAllow: Set<string>;
  fingerprintAtStart: string;
  io?: ShellApprovalIO;
}): TelegramShellDecision {
  const evaluation = evaluateShellApproval(input);
  return {
    evaluation,
    autoApprove: evaluation.autoApprove,
    offer: evaluation.autoApprove ? undefined : telegramRememberOffer(evaluation),
  };
}
