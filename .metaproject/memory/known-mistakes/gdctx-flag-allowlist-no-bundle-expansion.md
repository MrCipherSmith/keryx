# gdctx-flag-allowlist-no-bundle-expansion

Version: 0.1.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

A per-flag string allowlist that doesn't expand POSIX-bundled short flags rejects the idiomatic form of a tool's own CLI habits (`-il` vs `-i -l`); expand-then-check, not check-then-reject, for any allowlisted boolean-flag set.

## Details

`keryx ctx rg` rejects bundled POSIX short flags (`-il`) even though each individual flag (`-i -l`) passes the allowlist check. An agent accustomed to ripgrep's own CLI habits must either split the flags or use `# keryx:raw` to escape the guard — pure friction from flag-syntax parsing, not from any real security concern.

**Reproduction:** 
- `keryx ctx rg -il "todo" src` → rejected with `unsupported ripgrep option -il`
- `keryx ctx rg -i -l "todo" src` → accepted, produces identical ripgrep output

**Root cause:** `buildRgCommand` (`src/commands/ctx.ts:961-963`) splits each arg only on `=` (inline-value form: `-e=pattern`) before checking `RG_SAFE_FLAGS` and `RG_SAFE_VALUE_FLAGS` (defined `ctx.ts:875-917`). A bundled short-flag token like `-il` is never expanded into `-i`, `-l` before the allowlist check at `ctx.ts:996-1008`, so it fails the exact-string match `RG_SAFE_FLAGS.has(name)` that would pass either flag individually.

**Impact:** Low-Medium severity. Pure friction: pushes an agent toward raw `rg` or a `# keryx:raw` escape marker purely from habit-driven flag syntax, not from any real need for an unreviewed option.

**Fix shape:**
- In `buildRgCommand`, before the per-arg allowlist check: when a token matches `/^-[a-zA-Z]{2,}$/` (single dash, 2+ letters, no `=`), split it into constituent single-letter flags
- Accept the expansion only when every resulting flag is in `RG_SAFE_FLAGS` (boolean-only set, never value-flag letters)
- A bundle containing any value-flag letter (from `RG_SAFE_VALUE_FLAGS`, e.g. `-e`, `-g`, `-A`) or any unknown letter is refused whole with a message naming which letter broke the bundle
- This is additive parser-only: existing per-flag allowlist and mandatory `--` separator are unchanged, so the "fails closed on unknown option" guarantee is preserved
- Regression fixture: `keryx ctx rg -il "pattern" src` must produce identical output and exit code as `keryx ctx rg -i -l "pattern" src`

## Provenance

- Source: flow 304 (W7 gdgraph/gdctx correctness)
- Link: docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-3)
- Confirmed-By: Reproduced this session via `keryx ctx rg -il "todo" src`
- Created: 2026-09-24
- Updated: 2026-09-24

## Related Scopes

- Module: ctx, ripgrep, flag-parsing
- Entity: buildRgCommand, RG_SAFE_FLAGS, RG_SAFE_VALUE_FLAGS
- Files:
  - `src/commands/ctx.ts` (buildRgCommand, flag definitions)
- Skills:

## Tags

gdctx, flag-parsing, cli, ripgrep, posix, bundle-expansion, friction

## Changelog

- 0.1.0 - Initial version documenting GDCTX-3 defect from W7 correctness investigation.
