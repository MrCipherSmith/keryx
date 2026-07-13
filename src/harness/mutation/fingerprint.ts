// Deterministic action fingerprint for guarded mutation (flow 013, W10 / M-01,
// reviewer track: security).
//
// `actionFingerprint` produces a canonical sha256 over the normalized action
// surface — the worktree-resolved path, the exact argv, and ONLY the
// allowlisted environment variables. It is deterministic and side-effect-free:
// there is NO `Date.now`, `Math.random`, network, or filesystem access here
// (paths are normalized as data, never `realpath`-ed against a real fs), so the
// same normalized input always yields the same fingerprint (AC1).
import { createHash } from "node:crypto";
import path from "node:path";

/**
 * The action surface a fingerprint is computed over. `path` is the target file
 * or resource; `argv` is the exact, ordered argument vector (order is
 * significant); `env` is the full environment map, of which only the
 * allowlisted keys contribute to the fingerprint.
 */
export interface ActionSpec {
  path: string;
  argv: string[];
  env: Record<string, string>;
}

/** Fingerprint options: the approved worktree root and the env allowlist. */
export interface ActionFingerprintOptions {
  worktreeRoot: string;
  envAllowlist: string[];
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Canonical, deterministic sha256 fingerprint of `spec` under `opts`.
 *
 * Normalization:
 *   - `path` is resolved against `worktreeRoot` and normalized (data-only; no
 *     real filesystem `realpath`), so equivalent path spellings collapse.
 *   - `argv` is taken verbatim (order preserved).
 *   - `env` is filtered to the allowlist and its keys are sorted, so a change
 *     to a non-allowlisted variable — value or presence — never perturbs the
 *     fingerprint, while any allowlisted change does.
 *
 * Returns a lowercase 64-char hex string (matches the harness-envelope
 * `sha256` `$def`).
 */
export function actionFingerprint(spec: ActionSpec, opts: ActionFingerprintOptions): string {
  const normalizedPath = path.resolve(opts.worktreeRoot, spec.path);

  const allowlistedEnv: Record<string, string> = {};
  for (const key of [...opts.envAllowlist].sort()) {
    if (Object.prototype.hasOwnProperty.call(spec.env, key)) {
      allowlistedEnv[key] = spec.env[key] as string;
    }
  }

  const canonical = JSON.stringify({
    path: normalizedPath,
    argv: spec.argv,
    env: allowlistedEnv,
  });

  return sha256Hex(canonical);
}
