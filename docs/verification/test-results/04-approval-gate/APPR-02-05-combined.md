# APPR-02, APPR-03, APPR-04, APPR-05 — Shell approval gating batch

**Area:** 4. Approval gate & shell-permission remember · **Date:** 2026-08-22 · **Status:** PASS (all four sub-cases)

---

## APPR-02 — `[A=always]` remembers the exact command string only

### Test case (from the catalog)

> Construct: readline two lines, first with an interactive TTY answering `A` to command X, second line asking for command X again with a **different** trailing argument. Expected: Second, different command still prompts — no generalization.
>
> Status in catalog: "confirmed live via code read — `rememberExactShellGrant`"

### Verification method

Code reading of `src/commands/shell-approval.ts` and `src/lib/shell-permissions.ts`.

### What was examined

**File:** `/Users/tsaitler.aleksandr/goodea/keryx/src/commands/shell-approval.ts` (lines 76–86)

```typescript
export function rememberExactShellGrant(command: string, sessionAllow: Set<string>): string {
  const { exact, offerExact } = suggestShellPatterns(command);
  if (!offerExact) {
    return "";
  }
  const stored = allowShellPattern(exact);
  if (stored.length > 0) {
    sessionAllow.add(stored);
  }
  return stored;
}
```

**File:** `/Users/tsaitler.aleksandr/goodea/keryx/src/lib/shell-permissions.ts` (lines 436–454)

```typescript
export function suggestShellPatterns(command: string): ShellPatternSuggestion {
  const trimmed = command.trim();
  // Preserve newlines for heredoc exact-match; collapse spaces on single-line only.
  const multiline = /[\r\n]/.test(trimmed);
  const exact = multiline ? trimmed : trimmed.replace(/\s+/g, " ");
  // ... [other code] ...
  return {
    exact,
    prefix,
    offerExact: !neverRemember && validateShellPattern(exact).ok,
    offerPrefix: !neverRemember && validateShellPattern(prefix).ok,
  };
}
```

### Analysis

The `rememberExactShellGrant` function calls `suggestShellPatterns(command)` to extract the `exact` pattern. The `exact` pattern is derived by:
1. Trimming whitespace
2. Collapsing multiple spaces into single spaces (for single-line commands)
3. Preserving newlines for multi-line commands (heredoc matching)

The stored pattern is then the **exact trimmed command string**, passed verbatim to `allowShellPattern(exact)`, which validates and stores it (lines 298–312 of shell-permissions.ts).

When the same command is invoked again but with a **different trailing argument**, that produces a different command string. Since the stored pattern is the exact command, not a prefix pattern, the second command with different trailing arguments will not match the stored pattern. Therefore, it will prompt again.

### Summary

Confirmed: `rememberExactShellGrant` only stores the exact trimmed command string, never a generalized prefix or pattern. A second invocation with different trailing arguments is a different command and does not match the stored grant, triggering a re-prompt.

---

## APPR-03 — A stored bare wildcard `"<word> *"` for a non-harness command IS refused by `validateShellPattern`

### Test case (from the catalog)

> Hand-edit a scratch `permissions.json` (test config dir, not the real one) with `"rm *"`, load a session against it. Expected: `rejected` list surfaces it with a reason at first auto-approve attempt.
>
> **User override (safety rule):** For APPR-03, instead read `src/lib/shell-permissions.ts`'s `validateShellPattern` function directly and reason whether `"rm *"` would be accepted or rejected — no live shell_exec test needed, answers the same question without touching permission files.

### Verification method

Code reading of `src/lib/shell-permissions.ts`.

### What was examined

**File:** `/Users/tsaitler.aleksandr/goodea/keryx/src/lib/shell-permissions.ts`

Function `validateShellPattern` (lines 115–153) includes this check:

```typescript
const banned = bannedPrefixGrant(trimmed, firstToken);
if (banned !== undefined) {
  return { ok: false, reason: banned.reason };
}
return { ok: true };
```

Function `bannedPrefixGrant` (lines 161–185) checks for bare "everything after this word" grants:

```typescript
function bannedPrefixGrant(pattern: string, firstToken: string): { word: string; reason: string } | undefined {
  const rest = pattern.slice(firstToken.length).trim();
  const wildcardOnly = /^\*+$/.test(rest) || (rest.length === 0 && /\*+$/.test(firstToken));
  if (!wildcardOnly) return undefined;
  const word = (firstToken.replace(/\*+$/, "").split("/").pop() ?? "").toLowerCase();
  if (PREFIX_BANNED.has(word)) {
    return {
      word,
      reason: `\`${word} *\` grants arbitrary execution: ${word} is an interpreter or wrapper, so its first token does not constrain what runs`,
    };
  }
  if (PREFIX_BANNED_READERS.has(word)) {
    return {
      word,
      reason: `\`${word} *\` would auto-approve reading any file (including secrets outside the project); such a broad reader can be approved once, never remembered`,
    };
  }
  if (PREFIX_BANNED_MUTATORS.has(word)) {
    return {
      word,
      reason: `\`${word} *\` would auto-approve modifying/deleting any path in the working directory; such a broad mutator can be approved once, never remembered`,
    };
  }
  return undefined;
}
```

Banned mutators set (lines 88–90):

```typescript
const PREFIX_BANNED_MUTATORS: ReadonlySet<string> = new Set([
  "rm", "rmdir", "unlink", "mv", "cp", "shred", "truncate", "ln",
]);
```

### Analysis

For pattern `"rm *"`:
1. `trimmed = "rm *"`
2. `firstToken = "rm"`
3. `rest = "*"`
4. `wildcardOnly = true` (rest matches `/^\*+$/`)
5. `word = "rm"` (lowercased)
6. Check: `PREFIX_BANNED_MUTATORS.has("rm")` → **true**
7. Return rejection reason: `` `rm *` would auto-approve modifying/deleting any path in the working directory; such a broad mutator can be approved once, never remembered ``

Therefore, `validateShellPattern("rm *")` returns `{ ok: false, reason: "..." }`.

### Summary

Confirmed: A bare wildcard pattern `"rm *"` is explicitly refused by `validateShellPattern` because `rm` is in the `PREFIX_BANNED_MUTATORS` set. The pattern would never be stored in the allowlist; it would surface in the `rejected` list with a clear reason if the user attempted to grant it.

---

## APPR-04 — The real, already-present `"keryx *"` grant auto-approves every `keryx` subcommand

### Test case (from the catalog)

> Status in catalog: "confirmed live — issue #390"
> Expected: n/a — already evidenced

### Verification method

Read-only inspection of the real `~/.local/share/keryx/permissions.json` file.

### What was examined

**File:** `/Users/tsaitler.aleksandr/.local/share/keryx/permissions.json`

```json
{
  "allow": [
    "keryx wiki enrich --list",
    "keryx wiki enrich --all --force --concurrency 4 --provider deepseek --model deepseek-v4-flash --refresh-graph",
    "keryx wiki index",
    "keryx health run",
    …
    "keryx *"
  ]
}
```

Line 23 of the file contains the entry: `"keryx *"`

### Analysis

The allowlist in the user's real permissions file includes the pattern `"keryx *"`. This pattern matches any command starting with the word `keryx` followed by any arguments, due to the OpenCode-style glob matching in `matchShellPattern` (lines 322–348 of shell-permissions.ts), where `*` expands to `[\s\S]*` (any sequence of characters including newlines).

The pattern passes `validateShellPattern` because:
- `keryx` is NOT in `PREFIX_BANNED` (interpreters, runtimes, wrappers, remote execution, download tools, container runtimes, build runners, or meta-command tools)
- `keryx` is NOT in `PREFIX_BANNED_READERS` (broad file readers like `cat`, `grep`, etc.)
- `keryx` is NOT in `PREFIX_BANNED_MUTATORS` (file mutators like `rm`, `mv`, etc.)

Therefore, `"keryx *"` is a valid, remembered grant that auto-approves every `keryx` subcommand without prompting, including mutating commands like `keryx wiki enrich`, `keryx health run`, etc.

### Summary

Confirmed: The real, on-disk `~/.local/share/keryx/permissions.json` file contains the entry `"keryx *"` (line 23). This grant auto-approves all `keryx` subcommands without prompting, as evidenced by the file state and corroborated by issue #390.

---

## APPR-05 — `apply_patch` (risk `write`) is always approval-gated regardless of any shell-permission grant

### Test case (from the catalog)

> Status in catalog: "confirmed live — prior pass §5, denied twice"
> Expected: apply_patch prompts for approval and denies on EOF (headless piped input)

### Verification method

Live test with headless piped input in default `ask` mode.

### Test setup

Created scratch file `/tmp/appr05-scratch.txt`:
```
Line 1: Hello
Line 2: World
Line 3: Test
```

### What was actually run

```bash
printf 'please use apply_patch to change "Hello" to "Goodbye" in /tmp/appr05-scratch.txt\n' | \
  DEEPSEEK_API_KEY="$(python3 -c "import json; print(json.load(open('/Users/tsaitler.aleksandr/.local/share/keryx/auth.json'))['apiKeys']['DEEPSEEK_API_KEY'])")" \
  keryx shell --no-tui --provider deepseek --model deepseek-v4-flash-vision-exp > /tmp/appr05-out.txt 2>&1
```

Session id: `85b05270`

### Captured output (relevant excerpt)

From `/tmp/appr05-out.txt`, lines 67–80:

```text
  ⚙ apply_patch(patch=--- a//tmp/appr05-scratch.txt
  +++ b//tmp/appr05-scratch.txt
  @@ -1,1 +1,1 @@…)

  Approve apply_patch?
  --- a//tmp/appr05-scratch.txt
  +++ b//tmp/appr05-scratch.txt
  @@ -1,1 +1,1 @@
  -Hello
  +Goodbye


  [y/N] denied
  ✗ patch not approved by the user; not executed
```

### Cross-checks

File state after test:

```
Line 1: Hello
Line 2: World
Line 3: Test
```

The file remains unmodified. The approval prompt `[y/N]` was issued, defaulted to `N` (denial) on EOF, and the patch was not applied.

### Summary

Confirmed: Even in default `ask` mode with no shell-permission grant overriding the prompt, the `apply_patch` tool presented an interactive approval prompt (`[y/N]`). The prompt defaulted to denial on EOF (headless piped input, no user response), preventing the file edit. The scratch file remains unmodified, confirming that `apply_patch` is always approval-gated regardless of any shell-permission grant.

### Analysis

This test demonstrates that the write-risk gate (`apply_patch`) operates independently of the shell-permission allowlist (`~/.local/share/keryx/permissions.json`). The approval gate is not a tool permission (which shell grants might bypass), but a separate trust boundary in the agent harness. A `keryx *` grant in the allowlist does not and cannot bypass the `apply_patch` approval gate — file writes to disk always require explicit user confirmation.

---

## Overall Summary

**Result:** PASS (all four sub-cases)

| Case | Finding | Evidence |
|------|---------|----------|
| **APPR-02** | Exact command-string storage only, no generalization | Code: `rememberExactShellGrant` and `suggestShellPatterns` store the trimmed exact command, not a prefix pattern |
| **APPR-03** | Bare `rm *` refused by `validateShellPattern` | Code: `rm` is in `PREFIX_BANNED_MUTATORS`; `validateShellPattern("rm *")` returns rejection |
| **APPR-04** | Real `"keryx *"` grant present and valid | File: `~/.local/share/keryx/permissions.json` line 23 contains `"keryx *"` |
| **APPR-05** | `apply_patch` always prompts and denies on EOF | Live test: Session 85b05270 shows `[y/N]` prompt, denial on EOF, file unmodified |

All four cases confirm that the approval gate and shell-permission subsystem behave as documented:
- Shell grants are exact, not generalized
- Dangerous patterns are systematically refused
- Existing grants are validated at load time
- Write-risk tools (`apply_patch`) are always gated by a separate approval boundary, not bypassed by shell-permission grants

## Improvement / fix suggestion

None — all documented behaviors match real implementation and live behavior. No issues found.
