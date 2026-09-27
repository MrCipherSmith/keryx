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
//
// AC1 (flow 352 audit): the by-name list above was proven incomplete the same
// way `spawn-env.ts`'s own header describes for MCP servers — it named
// `GOOGLE_APPLICATION_CREDENTIALS` but not `KUBECONFIG`/`NETRC`, named no
// credential-harvesting primitive (`SSH_AUTH_SOCK`, `GIT_ASKPASS`,
// `SSH_ASKPASS`), and named no OTHER provider's model key, so an external
// `codex` child inherited a live `OPENAI_API_KEY` for the operator's own
// account and a `gemini` child inherited it too, though it authenticates with
// neither. Rather than growing a second hand-written list with the same blind
// spots, this module now runs the SHAPE-based check `spawn-env.ts` already
// verified against a real `env | sort` child (`isDeniedForMcpChild`) —
// segment/substring/connection-string/value rules that catch a class of name
// rather than an enumeration of examples — and exempts only the credential the
// TARGET runtime itself authenticates with (`EXTERNAL_RUNTIME_CREDENTIAL_ALLOW`
// below), so a subscription login via its own config dir keeps working while
// every other provider's key still does not cross the boundary.
import { isDeniedForMcpChild } from "../../mcp-servers/spawn-env";
import { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "./env-deny";

// The name lists live in a leaf module so `spawn-env.ts` can read them without
// importing this file back (it would close an import cycle).
export { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "./env-deny";


/**
 * The credential names {@link isDeniedForMcpChild}'s shape check would
 * otherwise strip, exempted per TARGET agent because that agent authenticates
 * with it (`ExternalAgentEntry.id`, `./registry.ts`).
 *
 * `codex-cli` accepts `OPENAI_API_KEY` as its non-subscription auth path
 * (`preferred_auth_method = apikey`); `gemini-acp` accepts either
 * `GEMINI_API_KEY` or `GOOGLE_API_KEY` (the CLI checks both). `claude-cli` has
 * no entry: its own key, `ANTHROPIC_API_KEY`, is on {@link EXTERNAL_ENV_DENY}
 * unconditionally — presence breaks its subscription path outright (this
 * file's header) — so there is nothing to exempt it FROM.
 *
 * A subscription login is untouched by any of this: it lives in the CLI's own
 * config dir (`CODEX_HOME`, Claude's credential store, `gemini`'s), reached
 * through `HOME`/`PATH`, neither of which this module ever strips.
 */
export const EXTERNAL_RUNTIME_CREDENTIAL_ALLOW: Readonly<Record<string, readonly string[]>> = {
  "codex-cli": ["OPENAI_API_KEY"],
  "gemini-acp": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

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
  /**
   * Which registered agent this environment is being built for
   * ({@link ExternalAgentEntry.id} — `"codex-cli"`, `"claude-cli"`,
   * `"gemini-acp"`). Decides the {@link EXTERNAL_RUNTIME_CREDENTIAL_ALLOW}
   * exemption from the shape-based strip below; an id with no entry there
   * gets no exemption, which is the fail-closed default for an agent this
   * module has never heard of.
   */
  readonly runtimeId: string;
}

/**
 * Build the child environment: the parent's, minus every denied name, minus every
 * swept namespace, minus everything CREDENTIAL-SHAPED that isn't this target's
 * own auth (AC1), plus the depth marker and colour suppression.
 *
 * Keys whose value is `undefined` in the parent are dropped rather than copied as
 * `undefined`, so the result is directly usable as a spawn environment.
 */
export function buildExternalChildEnv(input: ExternalEnvInput): Record<string, string> {
  const denied = new Set(EXTERNAL_ENV_DENY);
  const allowedForThisRuntime = new Set(
    (EXTERNAL_RUNTIME_CREDENTIAL_ALLOW[input.runtimeId] ?? []).map((name) => name.toUpperCase()),
  );
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.parent)) {
    if (value === undefined) continue;
    if (denied.has(key)) continue;
    if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => key.startsWith(prefix))) continue;
    // Same shape check `spawn-env.ts` runs for an MCP server child — see this
    // file's header for why a second hand list was rejected — skipped only for
    // the name(s) this specific target authenticates with.
    if (!allowedForThisRuntime.has(key.toUpperCase()) && isDeniedForMcpChild(key, value)) continue;
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
