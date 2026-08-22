# SESSCLI-01 — `keryx sessions path` prints the real on-disk store root

**Area:** Sessions CLI (cross-check surface) · **Date:** 2026-08-22 · **Status:** PASS

## Test case (from the catalog)

> `keryx sessions path` — Prints the real on-disk store root. Expected: prints the real on-disk store root. Verify: (no specific step given).

## What was actually run

```bash
keryx sessions path
```

## Captured output (terminal text capture)

```text
/Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx
```

## Cross-checks (on-disk verification)

1. **Directory exists:** The printed path is a real, existing directory.
   ```bash
   ls -la "/Users/tsaitler.aleksandr/.local/share/keryx/sessions/%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx"
   ```
   Result: Directory contains 92 session subdirectories (UUID-named folders like `0234bba2-51ca-48cb-96e6-80f39cce7487/`, etc.) and one `.project.json` file.

2. **Session directories contain expected data:** Examined one sample session directory (`2e479f4a-d4f8-445a-a19f-6df71a86e9bb/`) and confirmed it contains all expected session store files:
   - `archive.jsonl` (299.7K)
   - `context.jsonl` (299.7K)
   - `summary.json` (528B)
   - `transcript.jsonl` (299.7K)

3. **Path format:** The printed path is URL-encoded (project path `/Users/tsaitler.aleksandr/goodea/keryx` becomes `%2FUsers%2Ftsaitler.aleksandr%2Fgoodea%2Fkeryx`), which matches the documented behavior in the HOWTO that states: "Session JSONL lives under `~/.local/share/keryx/sessions/<url-encoded-project-path>/<full-session-id>/`".

## Summary

The `keryx sessions path` command correctly prints the real, on-disk store root directory containing all sessions for the current project. The printed path is accessible, contains 92 historical session directories with proper UUID naming and expected data files, and follows the documented URL-encoding convention for project paths. Behaves exactly as expected.

## Analysis

The command works as documented. It returns the base directory under which all per-project sessions are stored, keyed by URL-encoded project path. This is the exact location referenced in the HOWTO section 3 ("Cross-check on disk") as the root under which individual session JSONL files can be found. The presence of 92 session directories with full data files (archive.jsonl, context.jsonl, summary.json, transcript.jsonl) confirms the directory is actively used for storing session state and is accessible to the CLI.

## Improvement / fix suggestion

None — behaves as documented.
