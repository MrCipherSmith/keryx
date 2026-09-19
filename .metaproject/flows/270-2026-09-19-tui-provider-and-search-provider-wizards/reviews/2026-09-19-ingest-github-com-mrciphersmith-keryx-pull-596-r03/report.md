# Review round 3 — flow 270 / PR #596 (`c9a8a9b2`)

Target: `pr` · https://github.com/MrCipherSmith/keryx/pull/596 · head `c9a8a9b2be797181425d63a49ab02034d5fff7e6`
Scope: `c9a8a9b2` = fix commit `360543ca` plus one commit that moves the sidebar mode line (src/tui/tui-shell.ts only) so Status stays on a 24-row terminal (the macOS pty CI leg failed on it).
Reviewers: no new panel. Round 1's four findings are carried forward with `review-verifier` verdicts re-obtained against `c9a8a9b2` by an agent that raised none of them.
Model: `claude-opus-5`, current session.
External PR comments: collected against `360543ca` — zero.

## What this round is

All four are `refuted` — none reproduces at `c9a8a9b2`. `refuted` is the post-fix reading, not a claim that round 1 was wrong; every disposition is `acted-on`. All four verdicts are by execution, each regression test also run on `55f8923b` where it fails exactly as the finding described (composer focused mid-wizard; TextBuffer is destroyed after select(); 82 lines painted into a 20-row window; the literal-quoted header not refused).

## Findings carried forward

```json keryx:findings
[
  {
    "id": "F-001",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "line": 1500,
    "problem": "openStepSurface's close() calls handle.close(), which runs ModalHost closeHost with restoreFocus:true and focuses the composer between wizard steps while the wizard still awaits network work.",
    "impact": "Text typed during the gap (models fetch, key step, device login) lands in the composer and Enter submits it as a turn while the wizard is still running; main's overlay steps never refocused the composer.",
    "suggested_fix": "Close step dialogs without restoring focus and refocus the composer once the whole wizard resolves.",
    "evidence": "Scratch test with createShellChrome + selectProviderModelInTui(core, chrome, [deepseek with baseUrl], {env:{DEEPSEEK_API_KEY:'k'}, fetch: never-resolving}): after Enter on provider and on the endpoint step, currentFocusedRenderable.id === 'prompt', backdrop hidden, typing 'hello' + Enter made chrome.onSubmit receive ['hello'] while the wizard was pending.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:1500 openStepSurface close()", "src/tui/modal-host.ts:337 closeHost focusComposer", "every openStepSurface caller (11 wizard steps)"],
      "enumeration_method": "Every openStepSurface caller in the tui-shell.ts diff, plus closeHost in modal-host.ts, which always focuses the composer when restoreFocus is true."
    }
  },
  {
    "id": "F-002",
    "severity": "major",
    "file": "src/tui/tui-shell.ts",
    "line": 1845,
    "problem": "In the dialog form of runSearchProviderTestStep, Esc while the test is pending resolves 'retry' but the async block keeps running, calls controller.select() when the toggle was Yes, and writes status.content on a destroyed TextRenderable.",
    "impact": "The search provider is silently set active after the operator backed out, and an unhandled 'TextBuffer is destroyed' rejection is thrown; on main Esc was ignored until the test settled.",
    "suggested_fix": "Set a cancelled flag in onEscape and check it after await controller.test() and before select() and every status write.",
    "evidence": "Scratch test: fake controller whose test() returns a pending promise; Enter provider, Enter Yes, Esc while 'Testing' shown, then resolve test({ok:true}) -> bun reports 'TextBuffer is destroyed' at the status write after await controller.select(), proving select() ran.",
    "confidence": "high",
    "reviewer": "review-logic",
    "class_scope": {
      "sites": ["src/tui/tui-shell.ts:1845-1848 onEscape", "src/tui/tui-shell.ts:1874-1892 configure/test/select block"],
      "enumeration_method": "Every async continuation in the diff that outlives a step surface; runDeviceLoginInTui is guarded by controller.signal.aborted, runSearchProviderTestStep was not."
    }
  },
  {
    "id": "F-003",
    "severity": "minor",
    "file": "src/tui/mcp-inspector.ts",
    "line": 373,
    "problem": "Tools and MCP tabs page by item count (clampScroll over bodyRows items) while rows are now multi-line hanging-indent wraps plus an extra header line.",
    "impact": "Only a fraction of a page fits and keyboard scrolling stops at tools.length - bodyRows, so the last tools cannot be reached with ↑/↓.",
    "suggested_fix": "Page by rendered line count, summing formatToolRowLines(...).length.",
    "evidence": "Scratch test: presentMcpTools with 40 tools of ~200-char descriptions in a 120x40 renderer; each wrapped to 5 lines, ~6 visible; after 60 down presses the frame topped at tool_number_7..12 and tool_number_30/39 never appeared.",
    "confidence": "medium",
    "reviewer": "review-logic"
  },
  {
    "id": "F-004",
    "severity": "info",
    "file": "src/mcp-servers/compat.ts",
    "line": 268,
    "problem": "The array-of-tables branch strips only double quotes, so [['mcp_servers'.x]] is skipped silently instead of refused.",
    "impact": "No keys leak (current is cleared); only the config-problem line is missing, matching pre-existing single-bracket behaviour.",
    "suggested_fix": "Strip single quotes as well when computing the first key.",
    "evidence": "parseGrokToml on 9 crafted headers: [[ mcp_servers.x ]], [[\"mcp_servers\"]], [[mcp_servers]] refused; [['mcp_servers'.x]], [[__proto__]], [[marketplace.sources]] give no problem and no leakage; Object.prototype.command undefined.",
    "confidence": "high",
    "reviewer": "review-logic"
  }
]
```
