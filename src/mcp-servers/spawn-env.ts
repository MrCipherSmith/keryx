// The environment a third-party MCP server is spawned with.
//
// An MCP server is code the operator installed with one `npx` line, from a
// registry, running with their user account. It gets a filtered environment,
// and the filter is built for THIS job — not borrowed from one built for
// another.
//
// The SHAPE decision — is this name/value pair credential-shaped? — moved to
// `src/security/credential-shape.ts` (R-MIN1, flow 355 AC7): `isDeniedForMcpChild`
// was reached cross-subsystem (`harness/external/env.ts` imported it from this
// sibling package), which said nothing about what it actually is. See that
// module's header for the two rounds of review that shaped the classifier
// itself. This file keeps only what is specific to an MCP SERVER child: the
// saved-credential-by-name strip and the final env assembly.
//
// NOT the last word on the child environment: the SDK re-injects
// `HOME`/`PATH`/`SHELL`/`TERM`/`USER`/`LOGNAME` after this runs. None is a
// credential, and a server without `PATH` cannot start.
//
// Pure: the parent environment is a parameter, never read from a global.

import { isDeniedForMcpChild } from "../security/service";
import { declaredCredentialEnvKeys, savedCredentialEnvKeys } from "../lib/shell-config";

// Re-exported for every existing importer of THIS module (`spawn-env.test.ts`,
// `spawn-env.table.test.ts`) — the classifier itself now lives behind the
// security facade; this file is still where an MCP-server caller reaches for it.
export { isDeniedForMcpChild } from "../security/service";

export type McpChildEnvInput = {
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** The server's own `env` block, already variable-expanded. Applied last. */
  readonly serverEnv?: Record<string, string> | undefined;
  /**
   * Overridden in tests: REPLACES the entire by-name strip below — both
   * {@link savedCredentialEnvKeys} and the `configDir` disk lookup. Left
   * absent, the default is their union; see the function doc comment.
   */
  readonly savedCredentialKeys?: ReadonlySet<string> | undefined;
  /**
   * The config directory {@link declaredCredentialEnvKeys} reads, when
   * `savedCredentialKeys` above is not overridden. `undefined` is the
   * operator's real config dir — the production default every real launch
   * surface gets by threading its own already-resolved `configDir` here
   * (`defaultConnect`'s own `configDir` parameter). A test exercising the
   * disk half in isolation passes a temp directory here and leaves
   * `savedCredentialKeys` unset.
   */
  readonly configDir?: string | undefined;
};

/**
 * The parent environment minus everything {@link isDeniedForMcpChild} names
 * and minus every variable keryx's saved credential config names, plus
 * whatever the server's own `env` declares.
 *
 * THE ONE PLACE a launched MCP server's environment is built — `keryx shell`
 * (via `createMcpRuntime` → `defaultConnect`), `keryx mcp doctor`, and an
 * ACP client's own servers (`startAcpSessionMcp` → `defaultConnect`) all
 * funnel through this function rather than each carrying its own copy.
 *
 * Two independent strips, for two independent reasons:
 *
 *   - {@link isDeniedForMcpChild} strips by SHAPE: a name or value that
 *     LOOKS like a credential (`*_KEY`, `*_TOKEN`, `://user:pass@`, …),
 *     whoever set it and however it got into the parent environment.
 *   - the saved-credential strip removes by NAME: a custom provider's key
 *     may live under a name with none of KEY/TOKEN/SECRET in it (an
 *     `apiKeys` entry a "add custom provider" wizard saved under whatever
 *     name it was given), which survives the shape strip untouched.
 *
 * The by-name strip is the UNION of two sources, because either alone was
 * found (flow 296's review) to protect by coincidence rather than by
 * construction:
 *
 *   - {@link savedCredentialEnvKeys}, the live record of what THIS process
 *     has actually loaded into its own `process.env` so far
 *     (`applySavedApiKeys`/`noteSavedCredentialEnv`) — populated by TUI
 *     startup, `serve-runner.ts` and `keryx acp`, but NOT by the `keryx
 *     shell` readline surface (`--no-tui`/`--print`/non-TTY), which never
 *     calls `applySavedApiKeys`, and not by `keryx mcp doctor`, which
 *     resolves no provider at all. On those paths this record stays empty
 *     even though the saved config on disk is exactly the same file.
 *   - {@link declaredCredentialEnvKeys}, the same names read straight off
 *     `auth.json` — what the saved config DECLARES, independent of whether
 *     anything has loaded it into this process yet. This is what makes the
 *     strip hold on every surface BY CONSTRUCTION rather than by whichever
 *     one happens to have called `applySavedApiKeys` first.
 *
 * Never throws: `declaredCredentialEnvKeys` already fails closed (an
 * unreadable/malformed `auth.json` contributes no names, not an error), so
 * a config problem only ever means the disk half of the union is empty —
 * the singleton and the shape strip still run.
 *
 * The server's block is applied AFTER both strips, deliberately: an
 * operator who writes `"env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}` has asked
 * for that key to go to that server, by name, in a file they wrote. The
 * strips are about what leaks by default, not about overruling an explicit
 * instruction — even when the name is one keryx's saved config declares.
 */
export function buildMcpChildEnv(input: McpChildEnvInput): Record<string, string> {
  const saved =
    input.savedCredentialKeys ??
    new Set([...savedCredentialEnvKeys(), ...declaredCredentialEnvKeys(input.configDir)]);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.parent)) {
    if (value === undefined) continue;
    if (saved.has(key)) continue;
    if (isDeniedForMcpChild(key, value)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(input.serverEnv ?? {})) {
    env[key] = value;
  }

  return env;
}
