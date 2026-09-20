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
  /**
   * A `git-publish` pause lease applies to this command (`ApprovalMeta.publishLease`,
   * specification §4.4). Excluded from `autoApprove` exactly like `credentials`:
   * a saved or session allowlist pattern must not answer the prompt while a
   * peer's publish lease is in effect, and the caller must not offer "always
   * allow" while this is set (see `formatShellApprovalHints`).
   */
  publishLease: boolean;
  /**
   * Flow 275 T6/F1 (specification §4.4): `ApprovalMeta.publishLeaseDetail`
   * carried through unchanged — a display-ready `held by @name — "reason"`
   * string, present only when {@link publishLease} is true and the holder was
   * resolved. Escalation-only, like `publishLease` itself: it never changes
   * `autoApprove`, only what the prompt says once `publishLease` already
   * forced `ask`.
   */
  publishLeaseDetail?: string;
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
  const publishLease = input.meta?.publishLease === true;
  const publishLeaseDetail = input.meta?.publishLeaseDetail;
  const audit = io.loadAudit();
  for (const pattern of audit.permissions.allow) {
    input.sessionAllow.add(pattern);
  }
  const tampered = io.fingerprint() !== input.fingerprintAtStart;
  const autoApprove =
    !destructive &&
    !credentials &&
    !sacReviewConfirmation &&
    !publishLease &&
    isShellCommandAllowed(command, [...input.sessionAllow]);
  return {
    command,
    destructive,
    credentials,
    sacReviewConfirmation,
    publishLease,
    ...(publishLeaseDetail !== undefined ? { publishLeaseDetail } : {}),
    autoApprove,
    rejected: audit.rejected,
    tampered,
  };
}

/**
 * `publishLease: true` refuses to remember anything, mirroring the destructive/
 * credentials posture: while a peer's `git-publish` lease applies, "always
 * allow" must not be offered (§4.4) and, defensively, must not persist even if
 * a caller offered it anyway. Optional so the existing two-argument call sites
 * (which predate the publish-lease floor) still compile unchanged.
 *
 * `dir` is the SAME directory concept `runAgentRepl`'s own `configDir`
 * threads into `loadShellPermissions`/`shellPermissionsFingerprint` at its
 * call site — undefined (the default) reproduces the pre-flow-277 behaviour
 * of always writing the operator's real, default permissions file. Added so
 * a hermetic test can prove "no grant was persisted" against a throwaway
 * directory instead of either skipping the property or writing to
 * `~/.local/share/keryx/permissions.json`.
 */
export function rememberExactShellGrant(
  command: string,
  sessionAllow: Set<string>,
  options?: { publishLease?: boolean; dir?: string },
): string {
  if (options?.publishLease === true) {
    return "";
  }
  const { exact, offerExact } = suggestShellPatterns(command);
  if (!offerExact) {
    return "";
  }
  const stored = allowShellPattern(exact, options?.dir);
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
  if (evaled.publishLease) {
    // Flow 275 F1 (specification §4.4): name the lease's holder and reason
    // when they were resolved — "The prompt names the lease, its holder and
    // its reason." Falls back to the generic line when the detail is absent.
    lines.push(
      evaled.publishLeaseDetail !== undefined
        ? `a git-publish lease applies — ${evaled.publishLeaseDetail} — will not be remembered`
        : "a peer's git-publish lease applies — will not be remembered",
    );
  }
  return lines;
}
