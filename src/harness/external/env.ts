// Child environment for an external agent CLI (flow 176, T6).
//
// Built by COPY-THEN-STRIP, not by allow-listing: an allow-list would have to
// enumerate every variable a build toolchain needs and would fail in ways that
// look like the CLI being broken. Each removal below has a measured reason; see
// the package's security-policy.md §2, which this module implements.
//
// Two removals are counter-intuitive enough to restate here, because a future
// reader will otherwise "simplify" them back:
//
//   - `ANTHROPIC_API_KEY` is stripped to make the SUBSCRIPTION work, not for
//     secrecy. Measured against claude 2.1.220 (flow 176 T5): with a key present
//     the CLI initialises normally, burns eight `system/api_retry` events, then
//     ends `result.subtype = error_during_execution`. A slow failure is worse
//     than a fast one, and it looks like a network problem rather than a
//     configuration one.
//   - keryx's own `KERYX_*` variables are swept wholesale. A nested CLI that
//     inherited its parent's session/channel identity registered itself as the
//     SAME session in a reference implementation: the parent's next tool call
//     never returned and three operator messages sat queued for twenty-two
//     minutes. Nothing in `KERYX_*` means anything to a vendor CLI, so sweeping
//     the namespace costs nothing and closes the whole class.
//
// The depth marker is the one variable deliberately ADDED, and it is added AFTER
// the sweep so the sweep cannot eat it.
//
// Pure: the parent environment is a parameter, never read from `process.env` here.

/**
 * Variables removed by name, each for its own reason (security-policy §2.1).
 * Not alphabetised — grouped by the failure each prevents.
 */
export const EXTERNAL_ENV_DENY: readonly string[] = [
  // Break the subscription path, or silently redirect it to a third-party model
  // while the result still carries the external agent's name.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  // Config pointers that can re-set the variables above from inside a settings
  // file. Stripping the variables while leaving the pointer achieves nothing.
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  // "You are running inside Claude Code" — a child that inherits it misidentifies
  // its own context.
  "CLAUDECODE",
];

/**
 * Namespaces swept rather than enumerated. A table of individual names is a table
 * that falls behind the vendor's next release, and this is exactly the kind of
 * list nobody notices has gone stale.
 */
export const EXTERNAL_ENV_PREFIX_SWEEPS: readonly string[] = ["CLAUDE_CODE_", "KERYX_"];

/**
 * Depth marker honoured by keryx ON ENTRY.
 *
 * The directive in the prompt asks an external agent not to delegate; this is the
 * part that does not depend on a model complying. An external CLI has a shell and
 * will find keryx, so keryx refuses to spawn any child when this marker says the
 * process is already at or beyond the configured depth (agent-protocol.md §2).
 */
export const ENV_EXTERNAL_DEPTH = "KERYX_EXTERNAL_DEPTH";

/** Inputs for {@link buildExternalChildEnv}. */
export interface ExternalEnvInput {
  /** The parent process environment. Passed in, never read from a global. */
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** Nesting depth this child runs at; written to {@link ENV_EXTERNAL_DEPTH}. */
  readonly depth: number;
}

/**
 * Build the child environment: the parent's, minus every denied name, minus every
 * swept namespace, plus the depth marker and colour suppression.
 *
 * Keys whose value is `undefined` in the parent are dropped rather than copied as
 * `undefined`, so the result is directly usable as a spawn environment.
 */
export function buildExternalChildEnv(input: ExternalEnvInput): Record<string, string> {
  const denied = new Set(EXTERNAL_ENV_DENY);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.parent)) {
    if (value === undefined) continue;
    if (denied.has(key)) continue;
    if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  // Machine-readable output only; both CLIs otherwise colour their streams and a
  // parser would have to strip escapes it never needed to see.
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";

  // After the sweep, deliberately: `KERYX_` is one of the swept namespaces.
  env[ENV_EXTERNAL_DEPTH] = String(input.depth);

  return env;
}

/**
 * Read the depth marker from an environment. `0` when unset or unparseable —
 * absence means "not inside an external child", which is the safe reading for a
 * marker whose only job is to bound nesting.
 */
export function readExternalDepth(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env[ENV_EXTERNAL_DEPTH];
  if (raw === undefined || raw.trim().length === 0) return 0;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Whether a process at this depth may spawn a further external child.
 *
 * Fail-closed and checked on ENTRY, not on exit: the grandchild we are preventing
 * is spawned by a vendor CLI that has never heard of `maxTreeDepth`, so the only
 * control we actually hold is refusing at our own boundary.
 */
export function canNestExternalChild(
  env: Readonly<Record<string, string | undefined>>,
  maxDepth: number,
): { ok: true } | { ok: false; reason: string } {
  const depth = readExternalDepth(env);
  if (depth >= maxDepth) {
    return {
      ok: false,
      reason: `external agent depth cap ${maxDepth} reached (current depth ${depth}); refusing to nest`,
    };
  }
  return { ok: true };
}
