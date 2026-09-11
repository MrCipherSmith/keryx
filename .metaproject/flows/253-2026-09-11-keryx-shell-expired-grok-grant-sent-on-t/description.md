# keryx shell: expired grok grant sent on the readline path (K-013), saved provider keys leak into shell_exec (K-015), memory_search miss prints the absolute path (K-016)

Status: formalized
Source: arena defect log `arena/keryx-shell-defects.md` (branch `arena/measurement`), runs of 2026-09-11

## Problem

Three defects the arena read off keryx-shell's own transcripts:

- **K-013.** Both keryx arms of the 0.2.96 smoke failed on their first call with
  `HTTP 403: The OAuth2 access token could not be validated`. The grok grant had
  expired hours earlier and was refreshable — a refresh by hand succeeded at once.
  `refreshProviderGrant` is called only from `resolveTuiStartup`, inside
  `if (surface !== "readline")`, with failures swallowed; the arena runs the
  readline surface (`--no-tui -p`), which builds its provider straight from the
  stored grant.
- **K-015.** An agent ran `env` in a keryx arm and printed the operator's DeepSeek,
  OpenRouter and xAI keys. The arena started keryx with none of them;
  `resolveShellEnv` calls `applySavedApiKeys()` and copies all of `process.env` into
  every `shell_exec` command.
- **K-016.** In a project with no deletion trail, every `memory_search` miss carried
  the journal's absolute path and a ~700-character caveat. In all three keryx
  context arms of `/tmp/arena-batch1` it was the first place the agent saw its own
  absolute location, the step before it walked out of its tree.

## Expected Outcome

- Every shell surface refreshes stored grants before building a provider; a failed
  refresh is reported on stderr with the way out.
- `shell_exec` commands do not receive credentials keryx loaded from its saved
  config, unless the operator opts in with `KERYX_SHELL_PASS_SAVED_KEYS=1`; the
  restricted-network sandbox still injects real values at its proxy.
- A `trail-absent` miss reaches the model as one short line with no path; other
  verdicts keep their prose with project-relative paths.

## Out of Scope

- Retrying a request once on a 403 from a grant-backed provider.
- The CLI's own `keryx memory search` / `keryx forgetting` output for humans.
- Arena changes (prompt framing, isolation) — tracked on `arena/measurement`.
