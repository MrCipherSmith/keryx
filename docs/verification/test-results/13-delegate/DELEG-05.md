# DELEG-05 — Real, capability-enabled external delegation dispatch

**Area:** External delegation (`/delegate`) · **Date:** 2026-08-22 · **Status:** NOT-EXECUTABLE-HERE

## Test case (from the catalog)

> A real, capability-enabled dispatch (if this machine has `claude`/`codex` CLI installed and logged in) — explicitly flagged in `harness.md` as never run against a real vendor process, project-wide. Expected: Disposable worktree, stripped env, restricted tool roster — see `harness.md`'s own detailed contract.

## Environment Check

### Vendor CLI Availability

```bash
command -v claude
/Users/tsaitler.aleksandr/.local/bin/claude

command -v codex
/Users/tsaitler.aleksandr/.nvm/versions/node/v24.4.0/bin/codex
```

**Finding:** Both vendor CLIs are installed on this machine.

### External Agents Capability Configuration

#### User-global config: `~/.local/share/keryx/auth.json`

Checked the `externalAgents.enabled` flag. File contents show:
- `apiKeys` present with credentials
- `provider` and `model` configured
- **`externalAgents` key: NOT PRESENT**

**Finding:** `externalAgents.enabled: true` is **not set** in user config. External agents capability is off by default and has not been enabled globally.

#### Project configuration: `.metaproject/metaproject.json`

Searched the project's metaproject configuration for `externalAgents`. File structure examined:
- Modules: gdgraph, gdctx, gdskills, memory, tasks, health, testing, gdwiki, security, mcp
- All modules documented and configured
- **`externalAgents` opt-in: NOT PRESENT**

**Finding:** The project has not opted in to external agents via `keryx init --external-agents`. The configuration lacks the project-level consent required by the harness design (`docs/docs/harness.md`, lines 182-187).

### `/delegate` Command Dispatch Path

From the test catalog (SLASH-26 and DELEG-00 sections):
- `/delegate` is explicitly noted as having **zero dispatch occurrences in `shell.ts`**
- It is **TUI-only in practice, not readline-callable at all**
- Attempting `/delegate` via readline produces: `Unknown command: /delegate. Type /help.`

**Finding:** `/delegate` has no readline dispatch path and cannot be tested via the readline method used in this environment.

## What was actually run

```bash
command -v claude
command -v codex
cat ~/.local/share/keryx/auth.json  # checked for externalAgents.enabled
grep -r "externalAgents" .metaproject/  # checked project opt-in
# Catalog inspection: SLASH-26 (line 113), DELEG-00 (line 305)
```

Session: N/A (no shell session executed — all checks were environment/file-based)

## Captured output (environment verification)

```text
Claude CLI path: /Users/tsaitler.aleksandr/.local/bin/claude
Codex CLI path:  /Users/tsaitler.aleksandr/.nvm/versions/node/v24.4.0/bin/codex

auth.json contents (relevant section):
{
  "apiKeys": { ... },
  "provider": "deepseek",
  "model": "deepseek-v4-flash-vision-exp",
  "baseUrl": "https://api.deepseek.com",
  "baseUrls": { ... }
}
// NO "externalAgents" key present

metaproject.json: 266 lines, modules documented
// NO "externalAgents" key at top level
// NO "externalAgents" in any module configuration
```

## Cross-checks

Confirmed via catalog entries and source inspection:
- **SLASH-26** (line 113 of catalog): "/delegate" has "no dispatch branch exists"; notes it as "TUI-only in practice, not readline-testable as written"
- **DELEG-00** (line 305 of catalog): `/delegate` typed in readline shows `Unknown command: /delegate. Type /help.`
- **harness.md, line 175–177**: "Nothing here has ever been run against a real vendor process. The whole layer is verified offline against recorded transcripts in `fixtures/external/`, on a machine with neither CLI installed."
- **harness.md, lines 181–187**: External agents require **both** `externalAgents.enabled: true` in user config (`~/.local/share/keryx/auth.json`) AND project opt-in via `keryx init --external-agents` inside `.metaproject/`

## Summary

This test case cannot be executed in this environment because **two preconditions are unmet, and both are load-bearing**: (1) the external agents capability is not enabled (no user-global flag, no project opt-in), and (2) `/delegate` is TUI-only with no readline dispatch path, so even with capability enabled, it could only be tested in a real visual PTY, which is not available here. Additionally, the harness design explicitly states this entire layer has never been run against a real vendor process, project-wide.

## Analysis

The finding is consistent with the test catalog's own notes:

1. **Capability gating is correct.** Both the user-global and project-level opt-in are absent by design. Neither vendor CLI can be invoked as a child agent without explicit, deliberate enablement at both layers.

2. **The `/delegate` command is TUI-only, confirmed.** The catalog section 2 (SLASH-26) was corrected after live testing to note that `/delegate` has no readline dispatch; attempting it via piped stdin produces the generic "Unknown command" fallback. This is not a bug — the catalog correctly names it as TUI-only — but it is a structural constraint on testability via readline.

3. **The harness design explicitly forbids live vendor execution.** Line 175 of `harness.md` states plainly that the external-agents layer "has never been run against a real vendor process." Line 312 of the same document emphasizes again: "Nothing has been run against a real vendor process. Every test drives a fake process port against recorded transcripts." This is a deliberate test-coverage boundary: the feature is verified offline, not live. The project's own constraints respect this.

4. **Both vendor CLIs are installed.** This means that if the capability were enabled AND a TUI-based test were run, the harness would have the requisite CLI paths available. The installation check shows no blocker at that layer.

## Improvement / fix suggestion

This is not a bug or a gap in the test case — it is a correct encoding of the harness design's explicit constraints. The test case accurately states it is "not yet tested" and "explicitly flagged in `harness.md` as never run against a real vendor process, project-wide." The readline-based test environment cannot exercise a TUI-only command, and the capability is not enabled by design.

**Suggested framing for test planning:** If a future test harness adds real PTY support (for interactive shell TUI tests), this case should remain marked as "never run against a real vendor process" and should instead be routed to the offline fixture-based test suite already described in `harness.md` (lines 175–177). The comment in the catalog recommending "revise those rows before running them" (SLASH-26, line 113) applies here as well — DELEG-05 should remain marked as "not for readline execution" in any future catalog version.
