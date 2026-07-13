// Structural mutation guard (flow 013, W10 / M-01, reviewer track: security).
//
// `guardAction` is the fail-closed structural gate in front of any mutating or
// shell-capable action. It denies — BEFORE composing the W3 policy engine — on:
// unavailable scan/isolation, path traversal / symlink escape outside the
// worktree, shell metacharacters in argv, private/loopback/link-local/metadata
// egress, and direct credential/secret access; only a structurally clean action
// is handed to `decide()` for the profile/risk verdict. Deterministic and
// side-effect-free: clock/id arrive via `deps`; path resolution and symlink
// resolution are data-only (`resolveSymlink` is injected, never a real fs call);
// there is NO `Date.now`/`Math.random`/network/fs here (AC2, AC3,
// SC_R15_* scenarios).
import path from "node:path";
import type { ToolRisk } from "../tool/types";
import { decide } from "../policy/engine";
import type { PolicyContext, PolicyDeps, PolicyProfile } from "../policy/types";
import { actionFingerprint, type ActionSpec } from "./fingerprint";

/** A structural-guard verdict: allow the action, or deny it with a reason. */
export type GuardOutcome = { kind: "allow" } | { kind: "deny"; reason: string };

/**
 * Inputs to {@link guardAction}. `risk` is required because the composed
 * `decide()` needs a {@link ToolRisk} to resolve the profile baseline, and
 * {@link ActionSpec} carries none. `resolveSymlink`, when supplied, maps a
 * resolved in-root path to its (data-only) symlink target for escape detection.
 */
export interface GuardInput {
  spec: ActionSpec;
  worktreeRoot: string;
  profile: PolicyProfile;
  interactive: boolean;
  scanAvailable: boolean;
  risk: ToolRisk;
  resolveSymlink?: (resolvedPath: string) => string;
}

/**
 * Shell metacharacters that must never appear inside a single argv token
 * (argv-over-shell: one argument element may not carry shell-interpretable
 * syntax): `;  &  |  \`  $  (  )  <  >`.
 */
const SHELL_METACHARS = /[;&|`$()<>]/;

/** Private/loopback/link-local/metadata host markers denied at the egress boundary. */
const PRIVATE_HOST_TOKENS = [
  "127.0.0.1",
  "169.254.169.254",
  "10.",
  "172.16.",
  "192.168.",
  "localhost",
] as const;

/** Case-insensitive markers of a direct credential/secret file. */
const CREDENTIAL_PATH_TOKENS = [".env", "credentials", ".ssh/", "id_rsa", ".pem"] as const;

/** argv vectors that dump the whole environment (unrestricted secret snapshot). */
const ENV_DUMP_ARGV = new Set(["env", "printenv"]);

function deny(reason: string): GuardOutcome {
  return { kind: "deny", reason };
}

/** True when `candidate`, once resolved, stays inside `root`. */
function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Structurally guard `input`, then compose the W3 policy engine.
 *
 * Order (fail-closed first, then structural denies, then policy):
 *   1. `scanAvailable === false`                    -> deny (scan/isolation)
 *   2. path traversal / symlink escape              -> deny (traversal/escape)
 *   3. shell metacharacters in argv                 -> deny (shell injection)
 *   4. private/loopback/link-local/metadata egress  -> deny (private address)
 *   5. direct credential/secret access              -> deny (credential/env)
 *   6. otherwise                                     -> `decide()` verdict
 */
export function guardAction(input: GuardInput, deps: PolicyDeps): GuardOutcome {
  const { spec, worktreeRoot, profile, interactive, scanAvailable, risk, resolveSymlink } = input;

  // 1. Fail-closed: no scan/isolation, no execution — regardless of profile.
  if (scanAvailable === false) {
    return deny("Required scan/isolation is unavailable; failing closed.");
  }

  // 2. Path traversal / symlink escape — denied before the target is opened.
  const resolvedPath = path.resolve(worktreeRoot, spec.path);
  if (!isWithinRoot(worktreeRoot, resolvedPath)) {
    return deny(
      `Path traversal: ${spec.path} escapes and resolves outside the worktree root ${worktreeRoot}.`,
    );
  }
  if (resolveSymlink !== undefined) {
    const linkTarget = path.resolve(worktreeRoot, resolveSymlink(resolvedPath));
    if (!isWithinRoot(worktreeRoot, linkTarget)) {
      return deny(
        `Symlink escape: ${spec.path} resolves to a target outside the worktree root ${worktreeRoot}.`,
      );
    }
  }

  // 3. Shell injection — any argv token carrying shell metacharacters.
  for (const token of spec.argv) {
    if (SHELL_METACHARS.test(token)) {
      return deny(`Shell injection denied: argv token "${token}" carries shell metacharacters.`);
    }
  }

  // 4. Private/loopback/link-local/metadata egress destination in argv.
  for (const token of spec.argv) {
    if (PRIVATE_HOST_TOKENS.some((host) => token.includes(host))) {
      return deny(
        `Private/loopback/link-local/metadata address egress denied: "${token}".`,
      );
    }
  }

  // 5. Direct credential/secret access — sensitive path or full env dump.
  const lowerPath = spec.path.toLowerCase();
  if (CREDENTIAL_PATH_TOKENS.some((token) => lowerPath.includes(token))) {
    return deny(`Direct credential/secret file access denied: ${spec.path}.`);
  }
  if (spec.argv.length === 1 && ENV_DUMP_ARGV.has(spec.argv[0] as string)) {
    return deny(`Unrestricted environment snapshot denied: ${spec.argv[0]}.`);
  }

  // 6. Structurally clean — compose the W3 policy engine for the verdict.
  const actionFp = actionFingerprint(spec, { worktreeRoot, envAllowlist: [] });
  const ctx: PolicyContext = {
    profile,
    interactive,
    approvals: [],
    actionFingerprint: actionFp,
    targetPath: spec.path,
  };
  const decision = decide({ toolCallId: deps.idSeq(), risk }, ctx, deps);
  if (decision.decision === "allow") {
    return { kind: "allow" };
  }
  return deny(decision.reason ?? `Denied by ${profile.profileId} policy for ${risk}.`);
}
