// Shared shell_exec approval policy for TUI and readline.
// Surfaces still own the prompt chrome; this module decides auto-approve vs ask.

import type { ApprovalMeta } from "./agent";
import { touchesSacConfirmReview } from "../lib/command-risk";
import {
  allowShellPattern,
  isShellCommandAllowed,
  loadShellPermissionsWithAudit,
  parseShellExecCommand,
  shellPermissionsFingerprint,
  suggestShellPatterns,
  type PatternRejection,
} from "../lib/shell-permissions";

export type ShellApprovalEval = {
  command: string;
  destructive: boolean;
  credentials: boolean;
  /**
   * SAC's proposal-review/confirm-token family (`touchesSacConfirmReview`).
   * Computed from `command` directly, not from `meta` — this module has the
   * parsed command already, and `ApprovalMeta` has no field for this (adding
   * one would widen a shape shared with every other approver for one
   * command-family-specific signal this is the only reader of).
   */
  sacReviewConfirmation: boolean;
  autoApprove: boolean;
  rejected: readonly PatternRejection[];
  tampered: boolean;
};

export type ShellApprovalIO = {
  loadAudit: () => { permissions: { allow: string[] }; rejected: readonly PatternRejection[] };
  fingerprint: () => string;
};

const defaultApprovalIO: ShellApprovalIO = {
  loadAudit: () => loadShellPermissionsWithAudit(),
  fingerprint: () => shellPermissionsFingerprint(),
};

export function evaluateShellApproval(input: {
  inputJson: string;
  meta?: ApprovalMeta | undefined;
  sessionAllow: Set<string>;
  fingerprintAtStart: string;
  io?: ShellApprovalIO;
}): ShellApprovalEval {
  const io = input.io ?? defaultApprovalIO;
  const command = parseShellExecCommand(input.inputJson);
  const destructive = input.meta?.destructive === true;
  const credentials = input.meta?.credentials === true;
  const sacReviewConfirmation = touchesSacConfirmReview(command);
  const audit = io.loadAudit();
  for (const pattern of audit.permissions.allow) {
    input.sessionAllow.add(pattern);
  }
  const tampered = io.fingerprint() !== input.fingerprintAtStart;
  const autoApprove =
    !destructive &&
    !credentials &&
    !sacReviewConfirmation &&
    isShellCommandAllowed(command, [...input.sessionAllow]);
  return {
    command,
    destructive,
    credentials,
    sacReviewConfirmation,
    autoApprove,
    rejected: audit.rejected,
    tampered,
  };
}

export function rememberExactShellGrant(command: string, sessionAllow: Set<string>): string {
  const { exact, offerExact } = suggestShellPatterns(command);
  if (!offerExact) {
    return "";
  }
  const stored = allowShellPattern(exact);
  if (stored.length > 0) {
    sessionAllow.add(stored);
  }
  return stored;
}

export function formatShellApprovalHints(evaled: ShellApprovalEval): string[] {
  const lines: string[] = [];
  if (evaled.destructive) {
    lines.push("destructive command — will not be remembered");
  }
  if (evaled.credentials) {
    lines.push("touches agent credentials — will not be remembered");
  }
  if (evaled.sacReviewConfirmation) {
    lines.push("SAC proposal review/confirm-token — will not be remembered");
  }
  return lines;
}
