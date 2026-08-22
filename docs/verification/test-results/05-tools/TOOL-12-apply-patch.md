# TOOL-12 — apply_patch

**Area:** Built-in agent tools · **Date:** 2026-08-22 · **Status:** PARTIAL

## Test case (from the catalog)

> A real, approved (via `/mode trust`) file edit. Expected: File on disk actually changes; classifier (`classifyPatchRisk`) escalates correctly for a destructive-looking target.

## What was actually run

### Test 1: Basic file edit with apply_patch (trust mode)

```bash
printf 'hello world\nline two\n' > /tmp/tool12-scratch.txt
printf 'use apply_patch to change "hello world" to "hello keryx" in /tmp/tool12-scratch.txt\n' | \
  DEEPSEEK_API_KEY="..." keryx shell --trust --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
```

Session id: `452ab770`

### Test 2: classifyPatchRisk escalation test (.git/config within project)

```bash
printf 'use apply_patch to modify .git/config by changing one setting\n' | \
  DEEPSEEK_API_KEY="..." keryx shell --trust --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp
```

Session id: `f3d491be`

## Captured output (terminal text capture)

### Test 1 Output (excerpt)

```text
Session 452ab770 · per-project

[Model thinks about the task]

The apply_patch tool rejects paths that escape the project root.
/tmp/tool12-scratch.txt is outside the project root...
[Model falls back to sed via shell_exec]

⚙ shell_exec(command=sed -i '' '1s/^hello world$/hello keryx/' /tmp/tool12-scratch.txt && cat /tmp/tool12-scratch.txt)
◇ auto-approved (trust) sed -i '' '1s/^hello world$/hello keryx/' /tmp/tool12-scratch.txt && cat /tmp/tool12-scratch.txt
↳ hello keryx
  line two

Done. The file now contains:

hello keryx
line two
```

### Test 2 Output (excerpt)

```text
Session f3d491be · per-project

[Model reads .git/config]

⚙ read_file(path=.git/config)
↳ [core] · +41 more (/expand)

[Model asks user which setting to change]

⚙ ask_user(question=Which setting in .git/config should I change, and to what new value?, ...)
✗ User cancelled the question (Esc).

The user cancelled the question, so I don't know which setting to change...
```

## Cross-checks (if applicable)

### Test 1: Verified file on disk actually changed

Before the test:
- `/tmp/tool12-scratch.txt` contained: `hello world` (line 1), `line two` (line 2)

After the test (read via Read tool):
```
hello keryx
line two
```

**Result:** ✓ File on disk actually changed as requested.

### Test 1: apply_patch tool behavior

- The model attempted to use `apply_patch` directly with the patch content
- `apply_patch` was called and auto-approved in trust mode (`◇ auto-approved (trust)`)
- However, `apply_patch` rejected the patch with error: `"path escapes the project root"`
- The model then fell back to `shell_exec` with `sed` to accomplish the edit
- The fallback succeeded and the file was modified

### Test 2: classifyPatchRisk escalation test

- The model successfully read `.git/config` (a real file within the project root)
- The model asked for clarification on which setting to change (user cancelled)
- No patch attempt was made because the user input was incomplete
- Cannot fully observe the escalation behavior from this run

## Summary

Test 1 **PASSED** for the core requirement: file on disk actually changed. However, `apply_patch` rejected the path as escaping the project root, so the edit was performed via `shell_exec` fallback instead, not by `apply_patch` directly.

Test 2 **INCONCLUSIVE**: The escalation behavior for destructive-classified targets (like `.git/config`) was not observed because the user cancelled the clarification prompt before a patch was created. The `apply_patch` tool was never invoked with a destructive target in this session.

## Analysis

**File modification worked (Test 1):** The file `/tmp/tool12-scratch.txt` genuinely changed from `hello world` to `hello keryx` on disk. The change was durable and verified by reading the file afterward. The `/mode trust` flag correctly caused approval-gated tools to be auto-approved without prompting.

**apply_patch constraints (Test 1):** The `apply_patch` tool is scoped to files within the project root. When given an absolute path like `/tmp/tool12-scratch.txt`, it rejected the patch with "path escapes the project root". The model correctly identified this and fell back to `shell_exec` with `sed`, which succeeded (and was also auto-approved in trust mode).

**classifyPatchRisk escalation (Test 2):** The expected behavior is that `classifyPatchRisk` should escalate destructive-looking targets (like `.git/config`) to require explicit approval even in trust mode. However:
- In Test 1, both `apply_patch` calls were auto-approved in trust mode, regardless of the target path
- In Test 2, the test was inconclusive because the user cancelled before any patch was created
- No escalation prompt was observed in either test

This suggests either:
1. The escalation logic may not be fully implemented or working as intended
2. The escalation may happen at a different control point (not in the tool approval layer itself)
3. The tests need to be run differently to properly trigger the escalation (e.g., with a destructive patch that actually modifies `.git/config`)

## Improvement / fix suggestion

1. **Test escalation properly:** Create a dedicated test that attempts to patch a real destructive file (like `.git/config` or `.git/HEAD`) within the project root with an actual content change, and verify that an approval prompt appears even when `/mode trust` is active. Current test did not properly trigger this scenario.

2. **Document apply_patch scope:** The behavior of rejecting paths outside the project root should be documented. Callers should be aware that `apply_patch` only works on files within the project anchor root.

3. **Verify classifyPatchRisk integration:** Confirm whether `classifyPatchRisk` is actually called before the approval gate for `apply_patch`, and whether it correctly escalates destructive targets to always-prompt regardless of permission mode.
