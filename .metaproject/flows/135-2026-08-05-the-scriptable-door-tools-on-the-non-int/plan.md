# Implementation Plan

Status: planned

## Approach

Reuse, do not duplicate. Every piece this needs already exists and has no
production consumer on the non-interactive path:

- `toToolDefinitions(METAPROJECT_OPERATIONS)` already projects the operation
  descriptors into `ToolRegistry`-ready `ToolDefinition[]`.
- `createMetaprojectAdapter(cwd)` already backs those operations in-process.
- `OPENAI_COMPAT_PROVIDERS` is already the single source of truth for provider
  name, base URL and credential env var.
- `redactForPersistence` already turns tool output into something safe to emit.

So `src/commands/harness.ts` composes them; `src/commands/providers.ts` exports
the provider predicate and the credential lookup the composition needs. Neither
list is retyped anywhere.

Rejected alternative: a literal provider list in `harness.ts` extended by hand
with the eight gateway names. That is the defect, restated — the next provider
added to the registry would be refused by the CLI again, and the reference would
drift a second time.

## Steps

1. T5 (dispatch T1) — register the read-only metaproject tools on `harness run`
   and back them with a real executor over `MetaprojectPort`; print each tool's
   result in the structured blob.
2. T6 (dispatch T2) — validate `--provider` against the registry via a
   `providers.ts` export; generalize the fail-closed credential abort so every
   accepted provider that needs a key aborts before any network call.
3. T7 (dispatch T3) — declared model ids only: the DeepSeek entry names the ids
   the API lists, and each entry records what its curated list was verified
   against, because an offline test cannot re-check the upstream list.
4. T8 (dispatch T4) — one test per acceptance criterion.
5. T9 (dispatch T5) — correct `docs/docs/cli-reference.md` in the same PR; open
   the draft PR against `docs/benchmark-run-report`.

## Risks

- **Widening the accepted provider set could widen the credential hole.** It
  must not: the abort has to cover every newly accepted provider, not just the
  one it covered before. AC6 exists for exactly this and is tested per provider,
  enumerated from the registry.
- **`runOffline` never puts the registry on the wire.** `NormalizedRequest.tools`
  exists and both live providers serialize it, but the run loop does not set it,
  so a registered tool is one a live model is never told about. One guarded line
  in `src/harness/run/run.ts` closes it; `run.ts` is outside the dispatch's file
  table, so the change is kept minimal, comment-justified, and called out in the
  pull request.
- **Tool output on stdout.** `search_code` can return file contents, so the
  printed output goes through the same `redactForPersistence` scan the run loop
  uses before persistence rather than straight to the terminal.
