/**
 * Git env vars that OVERRIDE repository discovery from `cwd`.
 *
 * Git exports `GIT_DIR` (and, depending on the hook and worktree layout, the
 * rest of these) to every hook it runs. A child that inherits them operates on
 * the repository they name and silently ignores its own `cwd`.
 *
 * Measured, not theorised: the keryx pre-push hook runs `keryx test run
 * --changed --strict`, the tests inherited the hook's `GIT_DIR`, and fixture
 * helpers that do `git init && git config user.name … ` "in a temp dir" wrote
 * into the developer's real `.git/config`. Every later commit in that checkout
 * was authored `Test <test@example.com>` (246 reflog entries), which GitHub
 * cannot link to any account.
 */
export const GIT_DISCOVERY_OVERRIDE_VARS: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

/** `env` minus every var that could redirect git away from a child's `cwd`. */
export function withoutGitDiscoveryOverrides(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !GIT_DISCOVERY_OVERRIDE_VARS.includes(key)) {
      clean[key] = value;
    }
  }
  return clean;
}
