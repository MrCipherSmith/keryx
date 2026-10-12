# PR #805 review round 2

Round-1 fixes 1-3, 5 and 7 hold; the TUI change in fix 1/6 introduced a regression (multi-line patch collapses to one line in the review modal), and two flagged-path gaps plus one unsanitized CLI print remain.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow370-pr805-review",
  "severity": "major",
  "problem": "The fix swapped the modal's `clean` from a regex that preserved \\n to `terminalSafe`, which escapes every \\p{Cc} code point including \\n (and the file's own header says so). `bodyLines` then does `clean(patch).split(\"\\n\")`, so the split never finds a newline: the whole patch is rendered as ONE line with literal `\\x0a` between diff lines. The CLI path correctly uses terminalSafeBlock; the modal did not.",
  "impact": "In `/external-diff` the operator, whose review is the only landing gate, sees `Patch (redacted, 1 line(s)):` followed by `diff --git a/a b/a\\x0a--- a/a\\x0a+++ b/a\\x0a@@ -1 +1 @@\\x0a-x\\x0a+y\\x0a` wrapped as a single blob. Hunks cannot be read or scrolled line by line, so the modal review is effectively unusable and the operator is pushed to apply blind or leave the TUI. The unit test still passes because it only asserts `toContain(\"+added line\")`.",
  "suggested_fix": "Sanitize the patch with terminalSafeBlock (keeps \\n, escapes ESC and bare \\r) after expanding tabs, e.g. `terminalSafeBlock(patch.replace(/\\t/g, \"  \")).text.split(\"\\n\")`; keep `clean` (single-line terminalSafe) for paths and ids only. Add a test asserting the rendered patch has one row per diff line (`Patch (redacted, 6 line(s))` for a 6-line patch) and that ESC is still escaped.",
  "evidence": "ran a bun script against createExternalDiffController with patch \"diff --git a/a b/a\\n--- a/a\\n+++ b/a\\n@@ -1 +1 @@\\n-x\\n+y\\n\": output was `Patch (redacted, 1 line(s)):` then a single line `diff --git a/a b/a\\x0a--- a/a\\x0a+++ b/a\\x0a@@ -1 +1 @@\\x0a-x\\x0a+y\\x0a`; bun test src/tui/external-diff-modal.test.ts: 40 pass (test does not catch it)",
  "confidence": "high",
  "file": "src/tui/external-diff-modal.ts",
  "line": 248,
  "quote": "    const patchLines = clean(patch).split(\"\\n\");",
  "class_scope": {
   "sites": [
    "src/tui/external-diff-modal.ts"
   ],
   "enumeration_method": "read the fix diff; static review; ran the controller with a multi-line patch"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow370-pr805-review",
  "severity": "minor",
  "problem": "flaggedPathsOf only matches a directory prefix followed by `/` (or a nested `/<prefix>`), so a changed entry whose path is the bare directory name is never flagged: a symlink or file named `.claude`, `.github`, `.husky`, `.githooks`, `.metaproject` or `.circleci` (FLAGGED_BASENAMES only has `.git`). A symlink that stays inside the worktree is not refused by symlinkEscapes either.",
  "impact": "An agent creates `agent-cfg/settings.json` (unflagged) and a symlink `.claude -> agent-cfg` (path `.claude`, unflagged). The run lands on `external/<id>` with no FLAGGED PATHS block and no `--allow-flagged` gate, and after checkout Claude Code reads hooks through the symlink. Same for `.github -> ci` where the repo has no `.github` yet. This is the trailing-slash/normalization false negative of the case-insensitive rewrite.",
  "suggested_fix": "Also test `${normalized}/` against the prefixes, and the nested form `normalized.endsWith(`/${prefix.slice(0, -1)}`)`, so `.claude`, `pkg/.github` etc. are flagged as entries themselves.",
  "evidence": "bun -e import flaggedPathsOf: input [\".claude\",\".github\",\"a/.claude\",\".Claude/settings.json\",\".GIT/hooks/x\"] returned only [\".Claude/settings.json\",\".GIT/hooks/x\"]",
  "confidence": "high",
  "file": "src/harness/external/write-run.ts",
  "line": 128,
  "quote": "    if (FLAGGED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;",
  "class_scope": {
   "sites": [
    "src/harness/external/write-run.ts"
   ],
   "enumeration_method": "read the fix diff; static review; ran flaggedPathsOf on bare directory names"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow370-pr805-review",
  "severity": "minor",
  "problem": "Round-1 finding F-004 asked for the agent-instruction and other tool-config paths `AGENTS.md`, `CLAUDE.md`, `.cursor/`, `.codex/`, `.gemini/`, `.idea/`; the fix added `.mcp.json`, `.envrc`, `.gitattributes`, `.gitmodules` and three `.vscode` files but none of those, and gives no reason for leaving them out.",
  "impact": "A write run that adds `CLAUDE.md`/`AGENTS.md` instructions (for example 'run this script before any task') or `.codex/config.toml` / `.gemini/settings.json` / `.cursor/rules/x.mdc` lands with no flag and no `--allow-flagged` prompt, and the next agent session opened on the branch obeys them. These are exactly the 'agent config' the flagged block claims to cover.",
  "suggested_fix": "Add `.cursor/`, `.codex/`, `.gemini/`, `.idea/` to FLAGGED_PREFIXES and `claude.md`, `agents.md`, `gemini.md` to FLAGGED_BASENAMES (lower case), with a test; or document in the guide that instruction files are intentionally not flagged.",
  "evidence": "bun -e import flaggedPathsOf: [\"CLAUDE.md\",\".cursor/rules/x.mdc\",\".codex/config.toml\"] returned no flagged path",
  "confidence": "medium",
  "file": "src/harness/external/write-run.ts",
  "line": 115,
  "quote": "  \".mcp.json\",",
  "class_scope": {
   "sites": [
    "src/harness/external/write-run.ts"
   ],
   "enumeration_method": "read the fix diff and the round-1 finding list; static review; ran flaggedPathsOf"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow370-pr805-review",
  "severity": "minor",
  "problem": "The CLI sanitizing stops at the write-run section. `run --write` prints `renderRunOutcome(result.outcome)` immediately before it, and renderRunOutcome prints the agent's final message and partial output raw (`outcome.output`, `outcome.partial`, plus sessionRef and ACP agentInfo name). Also the `warning: ...` lines from onWarning go to stderr unfiltered.",
  "impact": "A write agent (prompt-injected from repo content) ends its reply with `\\x1b[2J\\x1b[H` plus a forged summary such as 'no changes; nothing to review'. The operator's screen is cleared and shows the forged text above the real `run:` / `review with:` lines, contradicting the escaped section that follows. The apply gate still re-renders escaped, so this does not land anything, but it leaves the 'every agent-derived string is escaped' claim in ESCAPED_NOTE untrue for the run report.",
  "suggested_fix": "Pass the outcome lines through terminalSafeBlock in renderRunOutcome (and `plain` for sessionRef, agent name and the onWarning text), keeping the JSON output byte-exact.",
  "evidence": "static review, not run",
  "confidence": "medium",
  "file": "src/commands/agents-external.ts",
  "line": 837,
  "quote": "  lines.push(\"\", outcome.output);",
  "class_scope": {
   "sites": [
    "src/commands/agents-external.ts"
   ],
   "enumeration_method": "read the fix diff and the print sites of runCommand; static review"
  }
 }
]
```
