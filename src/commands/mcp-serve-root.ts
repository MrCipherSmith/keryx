/**
 * Which project root `keryx mcp serve` exposes.
 *
 * The problem this exists for: `keryx mcp install` wrote the ABSOLUTE path of
 * the installing machine into `.mcp.json`. Committed, that file is correct on
 * exactly one machine — ours carried a macOS path from 2026-08-13 and the server
 * silently failed to start on Linux until 2026-09-02. #446 untracked the file,
 * which fixes the symptom by making every developer re-run the installer.
 *
 * The documented alternative was `${CLAUDE_PROJECT_DIR}` inside `args`. Measured
 * against Claude Code 2.1.220 rather than trusted, that does NOT hold:
 *
 * - `"--cwd", "${CLAUDE_PROJECT_DIR}"` arrives at the server VERBATIM — the
 *   server was handed the literal seven-character-plus string, not a path.
 * - `"--cwd", "${CLAUDE_PROJECT_DIR:-.}"` expands, but to the FALLBACK `.`,
 *   meaning the variable read as unset during argv expansion.
 * - The variable is nevertheless present and correct in the spawned server's
 *   ENVIRONMENT, and the process cwd is the project root too.
 *
 * So the runtime does provide the project root; it just does not provide it
 * through argv. Reading the environment is therefore the fix, and it lets the
 * generated config drop `--cwd` altogether — nothing machine-specific is written
 * at all, which is a stronger property than a portable placeholder.
 *
 * Precedence, and why: an explicit `--cwd` always wins, because a human or a
 * script that named a root meant it. `CLAUDE_PROJECT_DIR` comes next, because
 * when it is set the runtime is telling us which project this session is about.
 * The process cwd is last, unchanged from before, so nothing that worked before
 * behaves differently now.
 *
 * An empty or whitespace-only environment value is ignored rather than treated
 * as a root: `path.resolve("")` is the process cwd, so honouring it would look
 * like the fallback while claiming to be the runtime's answer.
 */
export function resolveServeRoot(
  explicitCwd: string | undefined,
  processCwd: string,
  env: Record<string, string | undefined>,
): string {
  if (explicitCwd !== undefined && explicitCwd.trim().length > 0) {
    return explicitCwd;
  }
  const fromRuntime = env.CLAUDE_PROJECT_DIR;
  if (fromRuntime !== undefined && fromRuntime.trim().length > 0) {
    return fromRuntime;
  }
  return processCwd;
}
