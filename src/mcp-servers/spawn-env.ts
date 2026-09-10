// The environment a third-party MCP server is spawned with.
//
// Copy-then-strip, reusing `EXTERNAL_ENV_DENY` and `EXTERNAL_ENV_PREFIX_SWEEPS`
// rather than restating them. Those lists exist because a spawned child that
// inherits `ANTHROPIC_API_KEY` is a credential handed to code the operator
// installed with one `npx` line, and because a child inheriting `KERYX_*`
// registered itself as its parent's session in a measured incident. Both
// hazards apply here identically: an MCP server is a subprocess keryx starts
// and does not control.
//
// What is NOT reused is `buildExternalChildEnv` itself. That function also
// writes `KERYX_EXTERNAL_DEPTH`, `FORCE_COLOR` and `NO_COLOR` — a contract
// with external agent CLIs about delegation depth and machine-readable
// output. An MCP server is not an agent CLI, and stamping it with a depth
// marker it will never honour would be a claim about a protocol that does not
// exist. The security lists are shared; the agent-CLI contract is not.
//
// Pure: the parent environment is a parameter, never read from a global.

import { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "../harness/external/env";

export type McpChildEnvInput = {
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** The server's own `env` block, already variable-expanded. Applied last. */
  readonly serverEnv?: Record<string, string> | undefined;
};

/**
 * The parent environment, minus every denied name and swept namespace, plus
 * whatever the server's own `env` declares.
 *
 * The server's block is applied AFTER the strip, deliberately: an operator who
 * writes `"env": {"ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}"}` has asked for
 * that key to go to that server, by name, in a file they wrote. The strip is
 * about what leaks by default, not about overruling an explicit instruction.
 */
export function buildMcpChildEnv(input: McpChildEnvInput): Record<string, string> {
  const denied = new Set(EXTERNAL_ENV_DENY);
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.parent)) {
    if (value === undefined) continue;
    if (denied.has(key)) continue;
    if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(input.serverEnv ?? {})) {
    env[key] = value;
  }

  return env;
}
