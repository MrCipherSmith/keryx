# Implementation Plan

Status: formalized

## Approach

Four PRs, in order, each independently green. This flow is the first.

| PR | Flow | What lands |
|----|------|------------|
| P1 | 276 (this) | The inventory document, and a guard test that keeps it honest. No production code touched. |
| P2 | (init when it starts) | Every audit in the inventory converted to a behavioural test, plus the seams that conversion needs. Zero production behaviour change. |
| P3 | (init when it starts) | `src/tui/tui-shell.ts` split into `src/tui/shell/`, `tui-shell.ts` kept as the public entry point. Pure movement. |
| P4 | (init when it starts) | `src/commands/shell.ts` split the same way. Pure movement. |

Later flows are **not** pre-created: ids are minted on `main`, and a package
created now inside an open PR branch takes an id another session will also
take. Each is `keryx flow init`-ed when it starts.

The ordering is the whole point. P3 and P4 are mechanical moves whose only
honest safety net is a test suite that fails when behaviour changes and stays
green when code merely moves. Today the suite does the opposite. P2 buys that
net; P1 writes down precisely what the net has to catch, because the audits do
not say — a substring assertion records a *string*, and the behaviour it stands
for lives only in the comment above it, if anywhere.

### Why a document, and not just "go convert them"

Each audit has to be read twice: once to see what it asserts, once to work out
what it was *for*. That second reading is the expensive part and it is not
recoverable from the assertion — `expect(source).toContain("setReasoningOverride")`
does not say that a `/reasoning` level must survive a later `/model` rebuild.
The conversion PR needs that answer for every one of them, and needs it before
it starts, or it will reimplement the same string check through a different
door.

The document also makes the two genuinely-structural audits visible. Not every
one of these is a behavioural test wearing the wrong clothes: "this file must
never import the Track B wrap-up composer"
(`tui-shell.test.ts:2464`) is a real statement about source structure, and the
right move there is to keep it as a text audit and make it survive the split —
by asserting over the module folder rather than over one file — not to convert
it into something it is not.

## Steps

1. **Enumerate.** Scan `src/**/*.test.ts` for every read of the two files'
   source text. Direct `readFileSync(join(import.meta.dir, "tui-shell.ts"))`
   is the common form, but not the only one: `shell-bus.test.ts` reads
   `"shell.ts"` relative, `shell-lease.test.ts:568` reaches across into
   `../tui/tui-shell.ts`, and `approval-wiring.test.ts` and `invariants.test.ts`
   both go through a local `source(relative)` helper. Sweep for `Bun.file`,
   `import.meta.dir` joins, glob scans over `src/**`, and any line-count or
   file-size budget that a split would move.
2. **Classify.** One row per `test(...)`, not per `describe`. Record technique,
   literal, behaviour protected, observability today, proposed conversion, and
   the cosmetic edit that breaks it.
3. **Decide the conversion for each.** Three outcomes only: *behavioural*
   (drive an existing exported function or injected dep), *seam* (name the
   module to extract — the pattern is `src/tui/bus-wake.ts` and
   `src/tui/bus-command.ts`, both lifted out of `tui-shell.ts` during flow 274
   for exactly this reason), or *stays structural* (with the reason, and how it
   is rewritten to survive a folder split).
4. **Write the document** to `docs/requirements/keryx-shell-split/`, alongside
   a README that states the four-PR shape, so the package is findable from the
   roadmap rather than only from this flow.
5. **Guard it.** A test that re-runs the step-1 scan and fails when the set of
   source-text-reading test files does not match the set the inventory records.
   Without this the document is accurate exactly once.
6. **Record the backlog discrepancy.** The task description cites a backlog
   entry "Split the shell god-files, and convert their source-text audits
   first"; `docs/requirements/backlog.md` has ten entries and none of them is
   it. Add it, in the file's own house format (measured, with the file:line
   that shows it) — or, since this flow supersedes it, add the package to the
   roadmap and note there that the backlog entry was never written.

## Risks

- **The inventory is wrong in the direction that matters.** An audit recorded
  as "protects X" when it really protects Y sends P2 to write the wrong test,
  and P3 then moves code with a net full of holes. Mitigation: every row cites
  the file:line it read, and the "behaviour protected" column is taken from the
  production code, not only from the test's own comment — the comments are long
  and good here, but they describe the defect at the time of writing.
- **Scope creep into P2.** The temptation while reading an audit is to fix it
  on the spot. This flow changes no test behaviour and no production code; the
  guard test in step 5 is the only test it adds.
- **The scan misses a form.** A source-text dependency that does not look like
  one — a snapshot, a generated manifest, a health check — would surface for
  the first time as a red CI run in P3. Step 1 sweeps beyond `readFileSync`
  specifically for this, and the guard test in step 5 encodes the scan so the
  miss is at least reproducible.
- **`launchTuiAgentShell` does not split by movement.** It is one ~3,940-line
  closure over ~two dozen mutable locals; the first 2,909 lines of the file are
  separable helpers, the rest is not. P3 can honestly move the helper half into
  modules and relocate the closure whole into its own file, but decomposing the
  closure is behaviour-risk work, not movement. This is a finding for P3's
  plan, recorded here so P3 is not scoped as if the whole file were tractable
  by moving it.
