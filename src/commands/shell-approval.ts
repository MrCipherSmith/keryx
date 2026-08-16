// Shared shell_exec approval policy for TUI and readline.
// Surfaces still own the prompt chrome; this module decides auto-approve vs ask.

import type { ApprovalMeta } from "./agent";
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
  const audit = io.loadAudit();
  for (const pattern of audit.permissions.allow) {
    input.sessionAllow.add(pattern);
  }
  const tampered = io.fingerprint() !== input.fingerprintAtStart;
  const autoApprove =
    !destructive && !credentials && isShellCommandAllowed(command, [...input.sessionAllow]);
  return {
    command,
    destructive,
    credentials,
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
  return lines;
}
