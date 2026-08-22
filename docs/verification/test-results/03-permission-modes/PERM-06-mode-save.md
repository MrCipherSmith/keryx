# PERM-06 — `/mode <mode> save` persists a per-project default

**Area:** Permission modes · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> readline: `/mode trust save` — `permission-mode.json` gets an entry for this project's resolved path

## What was actually run

```bash
# Step 1: Record initial state of permission-mode.json
# Result: FILE_DOES_NOT_EXIST

# Step 2: Run the test
printf '/mode trust save\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/PERM-06-out.txt 2>&1

# Step 3: Verify file was created with the entry
# Result: File created at ~/.local/share/keryx/permission-mode.json with entry:
# {
#   "schemaVersion": 1,
#   "projects": {
#     "/Users/tsaitler.aleksandr/goodea/keryx": "trust"
#   }
# }

# Step 4: Run /mode clear to restore prior state
printf '/mode clear\n' | DEEPSEEK_API_KEY="$DS_KEY" keryx shell --no-tui --provider deepseek > /tmp/PERM-06-clear-out.txt 2>&1

# Step 5: Verify file was cleaned up
# Result: File restored to original non-existent state
```

Session ids:
- `/mode trust save` session: `709a232e`
- `/mode clear` session: `5078ab3f`

## Captured output (terminal text capture)

### First invocation — `/mode trust save`

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 709a232e · per-project (keryx shell -c to continue)
  [22m  [2mPermission mode: trust
  [22m  [2mSaved as this project's default.
  [22m  ❯ 
```

### Second invocation — `/mode clear`

```text
  keryx — deepseek/deepseek-chat · agent · ~/goodea/keryx
  Type a message, or /help for commands.

  ❯   [2mSession 5078ab3f · per-project (keryx shell -c to continue)
  [22m  [2mCleared the stored project default. This session stays on: trust
  [22m  ❯ 
```

## Cross-checks (if applicable)

### After `/mode trust save`

Permission mode file state:
```json
{
  "schemaVersion": 1,
  "projects": {
    "/Users/tsaitler.aleksandr/goodea/keryx": "trust"
  }
}
```

**Confirmed:** The file contains an entry for this project's resolved path with value `"trust"`.

### After `/mode clear`

Final verification of file state:
```bash
test -f ~/.local/share/keryx/permission-mode.json && echo "FILE_EXISTS" || echo "FILE_DOES_NOT_EXIST"
```

**Result:** `FILE_DOES_NOT_EXIST` (restored to original state after cleanup)

## Summary

The test passed completely. The `/mode trust save` command correctly persisted the permission mode setting to `~/.local/share/keryx/permission-mode.json` with the project's resolved path as the key. The `/mode clear` command correctly removed the stored default while keeping the current session in trust mode. The file was successfully cleaned up, restoring it to its original non-existent state.

## Analysis

The behavior matches the documented specification exactly:

1. **Save behavior:** `/mode trust save` created the permission-mode.json file (if it didn't exist) with a schema and projects object, then added an entry for the current project's resolved path (`/Users/tsaitler.aleksandr/goodea/keryx`) with the value `"trust"`.

2. **Clear behavior:** `/mode clear` removed the project's entry from the stored defaults while maintaining the current session's permission mode at `trust` (confirming that the session-level setting is independent from the stored default).

3. **State management:** The file structure was properly managed — created on first save, entry removed on clear. This confirms that the permission-mode system correctly stores per-project defaults separate from the active session state.

## Improvement / fix suggestion

None — behaves as documented.
