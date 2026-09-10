// The environment a third-party MCP server is spawned with.
//
// An MCP server is code the operator installed with one `npx` line, from a
// registry, running with their user account. It gets a filtered environment,
// and the filter is built for THIS job — not borrowed from one built for
// another.
//
// The first version of this module reused `EXTERNAL_ENV_DENY` alone. That was
// a mistake found in review, and the list's own docstring says why:
// `ANTHROPIC_API_KEY` is stripped there "to make the SUBSCRIPTION work, NOT
// for secrecy". Inheriting that list inherits its scope, not its intent — so
// `OPENAI_API_KEY`, `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY` and, worst,
// `SSH_AUTH_SOCK` (a live agent socket: the server can sign with the
// operator's keys and push to their repositories) all went straight through.
//
// Still copy-then-strip rather than allow-list, for the reason `env.ts`
// gives: an allow-list has to enumerate everything a build toolchain needs
// and fails in ways that look like the server being broken. The strip is
// three layers — the shared external list, an MCP-specific name list, and a
// pattern sweep for secret-SHAPED names, because the specific names are the
// ones we thought of and the shape is the ones we did not.
//
// Pure: the parent environment is a parameter, never read from a global.

import { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "../harness/external/env";

/**
 * Names stripped for this surface specifically, each for its own reason.
 *
 * Not alphabetised — grouped by what it prevents.
 */
export const MCP_ENV_DENY: readonly string[] = [
  // A live ssh-agent socket. Inheriting it lets a server sign commits and
  // authenticate to every host the operator's keys reach, with no file to
  // steal and nothing in the process list to notice.
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  // Model-provider credentials keryx itself reads. `ANTHROPIC_*` is already
  // on the shared list; these are the ones that list was never about.
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  // Forge and cloud credentials. A server with these can push code, publish
  // packages, or reach infrastructure.
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "NPM_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AZURE_CLIENT_SECRET",
  "DOCKER_AUTH_CONFIG",
];

/** Namespaces swept whole, in addition to the shared ones. */
export const MCP_ENV_PREFIX_SWEEPS: readonly string[] = ["AWS_", "AZURE_", "GCP_", "GOOGLE_CLOUD_"];

/**
 * Secret-SHAPED names, swept whatever they are called.
 *
 * The lists above are the variables someone thought of. This is the class:
 * anything whose name says it holds a token, a key, a password or a
 * credential. It will strip some things that are not secrets — a
 * `HOMEBREW_NO_ANALYTICS`-style false positive costs a server one explicit
 * `-e`, and that is the right side to be wrong on when the alternative is
 * handing an unknown binary a credential nobody enumerated.
 *
 * `_KEY` is matched only as a whole word segment, so `KEYBOARD_LAYOUT` and
 * `MONKEY_PATCH` survive.
 */
export const MCP_ENV_SECRET_SHAPE =
  /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASS|CREDENTIAL|CREDENTIALS|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|SIGNING_KEY|CLIENT_SECRET|AUTH_TOKEN|SESSION_TOKEN)($|_)/;

/** True when this variable must not reach a third-party MCP server by default. */
export function isDeniedForMcpChild(name: string): boolean {
  if (EXTERNAL_ENV_DENY.includes(name)) return true;
  if (MCP_ENV_DENY.includes(name)) return true;
  const upper = name.toUpperCase();
  if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => name.startsWith(prefix))) return true;
  if (MCP_ENV_PREFIX_SWEEPS.some((prefix) => upper.startsWith(prefix))) return true;
  return MCP_ENV_SECRET_SHAPE.test(upper);
}

export type McpChildEnvInput = {
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** The server's own `env` block, already variable-expanded. Applied last. */
  readonly serverEnv?: Record<string, string> | undefined;
};

/**
 * The parent environment minus everything {@link isDeniedForMcpChild} names,
 * plus whatever the server's own `env` declares.
 *
 * The server's block is applied AFTER the strip, deliberately: an operator who
 * writes `"env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}` has asked for that key
 * to go to that server, by name, in a file they wrote. The strip is about what
 * leaks by default, not about overruling an explicit instruction.
 */
export function buildMcpChildEnv(input: McpChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.parent)) {
    if (value === undefined) continue;
    if (isDeniedForMcpChild(key)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(input.serverEnv ?? {})) {
    env[key] = value;
  }

  return env;
}
