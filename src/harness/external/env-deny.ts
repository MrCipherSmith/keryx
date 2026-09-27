// Environment names an external agent child never inherits. A leaf module:
// `env.ts` and `mcp-servers/spawn-env.ts` both read these lists.

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
