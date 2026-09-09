# T44 implementation — the persistence materializer now carries its redaction outcome

Spec written before coding: `T44-spec.md`. This is the follow-up T41 reported it could not do
inside its own ownership (`T41-implementation.md` §"Defect 3"), and the exact change comes from that
report's section 3, re-verified against the current file rather than trusted verbatim.

## 1. Callers enumerated (method + full list)

Method: `bun src/cli.ts ctx rg "prepareOutputForPersistence" src` (raw
`.metaproject/data/gdctx/raw/2026-09-06T14-53-05-621Z_rg.log`), then every production call site read
in full with `Read` (small, exact-line excerpts — not routed through `ctx run`, since each read is a
single bounded file section), then a second `ctx rg` sweep over the field-access patterns
(`.allowed`/`.content`/`.reason`/…) across the ten production files to confirm what each destructures
(raw `.metaproject/data/gdctx/raw/2026-09-06T14-53-16-864Z_rg.log`).

Ten production callers, all reading only `.allowed` / `.content` / `.reason` (no destructuring, no
exact-shape comparison against the whole result), so the additive shape change is safe for all of
them:

`src/memory/write.ts:101-103`, `src/wiki/service.ts:829-841`, `src/wiki/enrich.ts:856-880,1133`,
`src/sac/wiki-owner-writer.ts:129-132`, `src/sac/session-wrap-up.ts:140-153`,
`src/gdskills/project-skills.ts:269-277`, `src/testing/service.ts:162-171`,
`src/testing/coverage-map.ts:239-247`, `src/commands/workspace.ts:113-120`,
`src/harness/tool/builtin/workspace-lifecycle-tool.ts:220-229`.

Two test callers found by the same sweep:

- `src/security/persistence-sinks.test.ts` — owned by this task; two exact-shape `toEqual`
  assertions on the whole result object (lines 24, 39 in the pre-change file) widened, see §3.
- `src/security/detect/exfil.test.ts:339` — **not owned by this task**, and actively being edited by
  a concurrent worker (`git status` shows it modified, 272-line diff in progress, alongside
  `src/commands/security.ts` — the two files the dispatch names as off-limits). This is the one
  caller this task cannot make safe without touching a file outside its grant. See §5.

## 2. The change

`src/security/guard.ts:57` (`prepareOutputForPersistence`), starting from the exact snippet
`T41-implementation.md` §"Defect 3" wrote, with one deviation decided and recorded in `T44-spec.md`
§2 before coding: the `redaction` field is typed with the same `Extract<OutputRedaction, {state:
…}>` narrowing `OutputValidationResult` already uses at the call site, instead of the wider
`OutputRedaction` the proposal wrote — a type-only tightening, not a behavior change, and it is what
"reads naturally against the surrounding code" (`OutputValidationResult` in `output-validation.ts`)
turned out to mean once checked. The refused branch's `redaction` field stays optional and is
populated only when `validateSerializedOutput` itself is what refused (`format-unsafe`); a refusal
from `!guard.allowed` (the security engine's own gate decision) has no `OutputRedaction` to attach
and the key is left absent rather than fabricated — `reason` already names that outcome.

`guard.ts` also gained a genuine local `import type { OutputRedaction } from "./output-validation"`
(previously the name was only re-exported, `export type { OutputRedaction } from
"./output-validation"`, which does not bind a local name usable in this file's own type
annotations); the re-export is preserved so no external importer of `type { OutputRedaction } from
"./guard"` is affected.

No change to `GuardResult`, `src/security/service.ts`, `src/security/types.ts`, or
`src/security/output-validation.ts` — none was needed. `validateSerializedOutput` already returns
the `redaction` this task threads through; `GuardResult` is untouched because `prepareOutputForPersistence`'s
*return* type is what needed widening, not its *input* type.

## 3. Existing assertions widened (owned file only)

`src/security/persistence-sinks.test.ts`:

- "materializer preserves allowed output when no redaction is supplied" (was line 24) — `"token=raw"`
  is not valid JSON, takes the text branch, nothing matches → widened to also expect
  `redaction: { state: "none", reasons: [] }`, `bytesPreserved: true`.
- "materializer uses the guard's redacted output and refuses blocked writes" (was line 39, first
  assertion) — `guard.redacted` is `"token=[REDACTED]"`, itself clean on a second pass
  (`state:"none"`) but not equal to `original` (`"token=raw"`) → widened to also expect
  `redaction: { state: "none", reasons: [] }`, `bytesPreserved: false`. The second assertion in the
  same test (the `!guard.allowed` blocked branch) is untouched and now additionally asserted to carry
  **no** `redaction` key at all (`"redaction" in blocked` is `false`) — proving the "fabricate nothing
  when there is no outcome to report" half of the design.

No other assertion in the file compares the whole result object by exact shape; every other
assertion reads individual fields or uses `toMatchObject`, which already ignores extra keys, so
nothing else needed widening.

## 4. Regressions added, distinguishing the three outcomes (RED before GREEN)

All three outcomes are demonstrated with a genuinely new assertion, not merely with the widened
`toEqual`s above:

1. **Bytes preserved unchanged** — the widened "preserves allowed output" assertion above IS this
   regression: before the change, `redaction`/`bytesPreserved` do not exist on the result at all, so
   the widened `toEqual` fails; after, `bytesPreserved: true`, `redaction.state: "none"`.
2. **Content masked** — extended "materializer applies the secret floor even when a guard omitted
   redaction" to assert `output.redaction.state === "redacted"`,
   `output.redaction.reasons` contains `"secrets.aws-access-key"`, `output.bytesPreserved === false`,
   and `output.content !== serialized`. The same test now also asserts the **refused** branch's
   outcome for a numeric value under a credential key:
   `numericRefusal.redaction` equals `{ state: "format-unsafe", reasons: ["sensitive-numeric-field"] }`
   — the "the refused branch also carries its outcome" half of the acceptance criterion.
3. **Duplicate member dropped** — extended the five-shape `DUPLICATE_MEMBER_SHAPES` loop to assert
   `output.redaction.state === "redacted"`, `output.redaction.reasons` contains
   `"serialized-content-normalized"`, and `output.bytesPreserved === false` for every shape — the
   exact scenario the dispatch named.
4. **End-to-end, in `src/security/guard.test.ts`** — a new test drives the real `guardOutput()`
   (advisory mode, so it never blocks) rather than a hand-built `GuardResult`, feeding its result into
   `prepareOutputForPersistence`, and proves `bytesPreserved` distinguishes a masked write
   (`bytesPreserved:false`, secret absent from content) from a clean one (`bytesPreserved:true`,
   `content` byte-identical, `redaction.state:"none"`).

### A real finding surfaced by regression 4, worth recording

The end-to-end test initially asserted `redaction.state === "redacted"` for the masked case — the
naive expectation. It failed (`Received: "none"`), and the reason is architectural, not a bug: the
mandatory deterministic floor already runs once *inside* `guardOutput` itself (`src/security/guard.ts`
line ~171, on the caller's true original bytes) and sets `guard.redacted` to the already-masked text.
`prepareOutputForPersistence` then runs the *same* `validateSerializedOutput` a second time, but over
`guard.redacted ?? original` — i.e., over text that is already clean — so that second pass correctly
reports `state:"none"`: there is nothing left for it to find. `bytesPreserved` still correctly reads
`false`, because it compares the final bytes against `original`, the caller's true starting point, not
against `guard.redacted`. Every production caller goes through `guardOutput()` first (confirmed in
§1), so in the real, fully-integrated flow `bytesPreserved` is the signal that is always reliable;
`redaction.state:"redacted"` on the *allowed* branch is reachable in practice mainly through the
`pass`-fixture "guard omitted redaction" safety-net path (regression 2, and the five duplicate-member
shapes in regression 3, both of which construct a `GuardResult` with `redacted` left unset — the
scenario the existing test's own name already flags: "even when a guard omitted redaction"). The test
was corrected to assert what is actually true end-to-end (`bytesPreserved`) rather than a shape that
does not occur on this path, and a comment was added at the test explaining why, so the next reader
does not have to re-derive it.

## 5. The disclosed, unowned side effect

`src/security/detect/exfil.test.ts:339` — `expect(prepareOutputForPersistence(GUARD_PASS,
clean)).toEqual({ allowed: true, content: clean })` — fails after this change, both at runtime and at
typecheck, because `toEqual`'s expected literal no longer has the `redaction`/`bytesPreserved` keys
the widened return type now requires:

```
error TS2769: No overload matches this call.
  Type '{ allowed: true; content: string; }' is missing the following properties from type
  '{ allowed: true; content: string; redaction: {...}; bytesPreserved: boolean; }': redaction, bytesPreserved
```

This file is not in this task's ownership grant (`src/security/guard.ts`,
`src/security/guard.test.ts`, `src/security/persistence-sinks.test.ts`, and additive `types.ts` only
— "nothing else"), and `git status` shows it under active concurrent edit (272-line diff, alongside
`src/commands/security.ts` — the exfil worker's named files). This is disclosed rather than
worked around: the fix, when its owner is free to apply it, is the same one-line widening this task
applied twice already —

```diff
- expect(prepareOutputForPersistence(GUARD_PASS, clean)).toEqual({
-   allowed: true,
-   content: clean,
- });
+ expect(prepareOutputForPersistence(GUARD_PASS, clean)).toEqual({
+   allowed: true,
+   content: clean,
+   redaction: { state: "none", reasons: [] },
+   bytesPreserved: true,
+ });
```

Confirmed to be the **only** fallout anywhere in the tree: the full `src/security` suite (217 tests,
22 files) shows exactly 1 failure, at exactly this line (§6 evidence); `bun run typecheck` shows
exactly 1 error, at exactly this line and no other file.

## 6. Evidence — exact counts, before and after, with raw log paths

All commands ran through `bun src/cli.ts ctx run`.

### Mandated suite (`guard.test.ts`, `persistence-sinks.test.ts`, `output-validation.test.ts`,
`structural-redaction.test.ts`, `service.memo.test.ts`)

- **Before** (baseline, prior to any edit): **88 pass, 0 fail, 498 assertions**. Raw:
  `2026-09-06T14-57-47-966Z_run.log`.
- **RED** (widened assertions + new regressions written, `guard.ts` still unchanged): **46 pass, 9
  fail** — every failure is exactly one of the new/widened assertions
  (`output.redaction` / `masked.bytesPreserved` / the widened `toEqual`s), nothing else moved. Raw:
  `2026-09-06T14-58-27-603Z_run.log`.
- **GREEN** (after the `guard.ts` change, with the one end-to-end test corrected per §4's finding):
  **89 pass, 0 fail, 530 assertions**. Raw: `2026-09-06T15-00-19-503Z_run.log`.

### Typecheck and lint

- `bun run typecheck` → **1 error, isolated to `src/security/detect/exfil.test.ts:339`** (§5) — no
  other file. Raw: `2026-09-06T15-00-43-772Z_run.log`.
- `bunx eslint src/security/guard.ts src/security/guard.test.ts
  src/security/persistence-sinks.test.ts` → exit 0, no output. Raw: `2026-09-06T15-01-07-706Z_run.log`.

### Wider safety net

- `bun test src/memory src/wiki src/gdctx src/metrics src/sac src/testing
  src/commands/workspace.test.ts src/harness` → **2594 pass, 9 skip, 2 fail**. Both failures are in
  `src/harness/tool/metaproject-adapter.test.ts` ("readWiki rejects a path that escapes the wiki
  root…" and "skillsCatalog falls back to catalog.md's one-line summary…"), neither referencing
  `prepareOutputForPersistence`/`GuardResult` (confirmed via `ctx rg`, 0 matches in that file); the
  underlying `src/harness/tool/metaproject-adapter.ts` shows as concurrently modified in `git status`
  — pre-existing, unrelated to this change. Raw: `2026-09-06T15-01-59-907Z_run.log`.
- `bun test src/security` → **216 pass, 1 fail** — the disclosed §5 failure, nothing else. Raw:
  `2026-09-06T15-02-20-074Z_run.log`.
- `bun test src/mcp` → **189 pass, 3 skip, 0 fail**. Raw: `2026-09-06T15-02-29-417Z_run.log`.

## 7. Files changed

- `src/security/guard.ts` — widened `prepareOutputForPersistence`'s return type additively
  (`redaction`, `bytesPreserved` on the allowed branch; optional `redaction` on the refused branch);
  added a local type-only import of `OutputRedaction` alongside the existing re-export; extended the
  function's doc comment to explain the two-pass architecture and why the refused branch's
  `redaction` is conditional.
- `src/security/guard.test.ts` — one new end-to-end regression proving the signal survives the real
  `guardOutput()` → `prepareOutputForPersistence()` seam, plus the `prepareOutputForPersistence`
  import.
- `src/security/persistence-sinks.test.ts` — widened the two exact-shape `toEqual` assertions;
  extended two existing tests (the secret-floor test and the five-shape duplicate-member loop) with
  the new distinguishing assertions.

Not touched: `src/security/service.ts`, `src/security/types.ts`, `src/security/output-validation.ts`
and its test, `src/security/detect/exfil.ts` and `.test.ts`, `src/commands/security.ts`, every
production caller (additive shape confirmed safe for all ten, §1), every other test file.

## 8. Routing audit

- `graph_used: no (not-relevant)` — the dispatch and `T41-implementation.md` §"Defect 3" already
  named the exact file and line; the one cross-file enumeration needed (every caller of
  `prepareOutputForPersistence`) came from `ctx rg` over the current tree, which answers from the
  working tree rather than the last `gdgraph build` and so stays current through a large uncommitted
  multi-worker change set that a graph answer could not be.
- `wiki_used: no (not-relevant)` — the governing texts are `T41-implementation.md`, `T41-spec.md`,
  and `T24-recheck2.md`'s `T24R2#F-002`, all read directly as instructed by the dispatch.
- `ctx_used: yes` — every command, code search, and test run went through `bun src/cli.ts ctx run` /
  `ctx rg`; small, exact-line file excerpts used `Read` directly rather than `ctx run`, since gdctx
  routes commands/search/logs, not plain file reads.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find` over project code. `sed -n` was attempted per
  the dispatch's stated fallback but is also blocked by the same routing hook in this environment;
  `Read` with `offset`/`limit` was used instead for the two bounded excerpts that needed it
  (`src/commands/workspace.ts:95-140`, `src/harness/tool/builtin/workspace-lifecycle-tool.ts:195-240`),
  which is not a `# keryx:raw` escape and produces no raw, uncompressed command output. One `Read` of
  a `.metaproject/data/gdctx/raw/*.log` file was used per gdctx run to get the full, unelided error
  text where the tail-truncated inline summary cut it off (`2026-09-06T15-00-43-772Z_run.log`) —
  reading a file is not the `rg`/`grep`/`cat`/`find` escape this rule governs, and no reason marker
  was needed for it.
