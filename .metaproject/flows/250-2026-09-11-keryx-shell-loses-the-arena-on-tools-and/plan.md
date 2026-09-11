# Implementation Plan

Status: ready

## Approach

Five independent, small changes, each with its own tests, landed as one PR because
they share one motivation and one verification (the arena rerun). No shared
abstraction is introduced; each fix stays inside the file that owns the behaviour.

Rejected alternatives:

- **Real per-provider identity for K-005** (own `providerId`, `providerRevision`).
  Correct eventually, but `make-provider.test.ts` pins `providerId === "ollama"`
  and anything keyed on the id (sessions, descriptors) would move with it. The
  label alone fixes what an operator reads.
- **Hide tools by probing each backend at startup for K-009.** Honest but slow and
  racy; the presence of `.metaproject/` is the fact every one of those tools
  depends on and is one `existsSync`.
- **Byte offsets for S-1.** Simpler, but the model navigates by the line numbers
  `search_code` prints; a byte offset would have to be translated by the model.

## Steps

1. **K-005 — compat errors** (`src/harness/provider/make-provider.ts`,
   `src/harness/provider/compat/openai-compat-provider.ts`):
   - construct each registry provider with `providerLabel: compat.label`, keeping
     `providerId` / `providerRevision` / defaults from `OLLAMA_COMPAT_IDENTITY`;
   - `classifyHttpError(status, headers)`: 401/403 → `authentication`, 429 →
     `rate_limit` with `retryAfterMs` from `Retry-After`, ≥500 → `unavailable`,
     other 4xx → `invalid_request` (mirrors `openai-provider.ts`);
   - message = `<Label> API returned HTTP <status>` plus `: <reason>` when the body
     yields one — JSON `error.message`, JSON `error` as a string, top-level
     `message`, else the text body — collapsed, passed through
     `redactSensitiveText`, truncated to 300 chars.
2. **K-008 — search output** (`src/harness/tool/metaproject-adapter.ts`
   `searchCode`): pass the confined path to ripgrep RELATIVE to the project root;
   add `--max-columns=400 --max-columns-preview`; when `boundOutput` clips, say
   `showing <n> of <m> lines`.
3. **K-009 — roster** (`src/commands/interactive-agent-tools.ts`): when
   `<cwd>/.metaproject` does not exist, drop the operations whose backend reads
   `.metaproject/` artifacts. The dropped set is an explicit, tested list; every
   other tool is unchanged. With `.metaproject/` the roster equals today's.
4. **S-1 — read_file ranges** (`src/harness/tool/builtin/interactive-tools.ts`):
   optional `start_line` (1-based). Stream the file, skip to the line, collect up
   to `MAX_READ_BYTES`; the truncation notice names the next `start_line`. No
   `start_line` and a file under the cap → identical output to today.
5. **K-004 — self runner** (`src/harness/tool/builtin/metaproject-tools.ts`):
   `makeKeryxRunner` spawns the running keryx — `[process.execPath, Bun.main]` when
   the entry script exists on disk, `[process.execPath]` for a compiled binary —
   and falls back to PATH `keryx` only when neither applies.
6. Changelog entry, then typecheck, related tests, full suite.

## Risks

- Roster tests pin the full tool list in a temp dir with no `.metaproject/`; that
  test must create one to keep asserting today's list, and a new test must pin the
  reduced list — otherwise the change is invisible to the suite.
- Tests may pin the exact detail-only error text for JSON bodies; the new format
  prefixes status. Update them deliberately, not by loosening assertions.
- `redactSensitiveText` on an error body must not mangle ordinary prose (it was
  hardened for that in #524; rely on its existing tests).
- The system prompt still lists tools by name (out of scope; follow-up).
