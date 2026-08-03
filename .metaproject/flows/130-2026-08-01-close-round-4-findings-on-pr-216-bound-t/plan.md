# Implementation Plan

Status: formalized

## Approach

Build the guard first, watch it fail, then fix what it reports (D1).

The alternative — patch `src/session/store.ts` and add the guard afterwards —
was rejected for the reason `config-dir.writers.test.ts` states in its own
header: a guard that is never observed failing is decorative, and this flow's
subject is a guard that was decorative. The order is the control.

The construction is deliberately a copy of the writers guard's shape, not a new
idea. That file already survived a review that planted twelve writer shapes and
caught one, and its current form is what came out of that. Reusing the shape
means reusing the `code()` stripper (string literals and comments blanked before
scanning), the exemptions-with-reasons table, the `offenders()` seam that the
mutation test drives, and the both-directions assertion (reports every planted
shape / reports nothing clean). Where the two guards share machinery, extract it
rather than fork it — a second copy of the stripper is the third-copy mistake
`config-dir.ts` was extracted to stop.

## Steps

1. **Extract the shared source-scanner.** Pull `code()`, the tree walk and the
   exemption-with-reason structure out of `config-dir.writers.test.ts` into one
   helper both guards import. Confirm the writers suite stays green and its
   twelve-shape mutation test still reports all twelve.
2. **Write `config-dir.readers.test.ts`'s source-level guard** over that helper:
   `CONFIG_PATH_RESOLVERS` (already listed in the writers guard) plus a
   `RAW_READ_CALLS` set — `readFileSync`, `readFile`, `Bun.file`,
   `createReadStream`, `readSync`, `openSync`. Sanctioned readers are
   `readConfigFile` and the transcript reader from step 5.
3. **Observe it red.** Run it before touching `store.ts`; it must report
   `src/session/store.ts` twice. Record the output in the journal (AC4).
4. **Mutation-test the guard** — `offenders()` body replaced with `return []`
   against a planted raw reader, suite must go red. Record (AC3).
5. **Declare `MAX_TRANSCRIPT_FILE_BYTES`** in `config-dir.ts` beside
   `MAX_CONFIG_FILE_BYTES`, with its own reason, and a `readTranscriptFile`
   that shares the stat/refuse path and differs only in the bound (D2).
6. **Add the regular-file requirement** to the shared read path:
   `statSync(file).isFile()`, refusing otherwise with a distinct
   `ConfigReadFailure` member so a caller can say why (D3). Extend the existing
   `readConfigFile` unit tests.
7. **Repoint `store.ts:189` and `:251`** at the bounded helpers. The guard from
   step 2 goes green as a consequence, not as a separate edit.
8. **Behavioural probes** (AC5, AC6): extend the existing subprocess-probe
   harness in `config-dir.readers.test.ts` with the two session entry points
   against a 3 GiB sparse file, and add the FIFO matrix over every reader with a
   per-test timeout (D4). Keep the existing "the probe harness itself can
   observe an abort" control.
9. **Remove the `<addr>` substitution** from `serve.recovery.test.ts:481` and
   make `serve-server.ts:155` / `serve.ts:229` print the configured address
   instead of a placeholder; assert that no executed instruction still contains
   a `<placeholder>` (AC8).
10. **Correct the three comments** (AC9), each to what the code does after the
    steps above, naming the test that enforces it.
11. **Gates and journal** (AC10, AC11): `bunx tsc --noEmit`, full `bun test`,
    `keryx health run`, the mutation table, and a check that the real
    `~/.local/share/keryx` is untouched by the suite.

## Risks

- **The transcript bound is a behaviour change on resume.** Whatever step 5
  chooses at the limit — refuse, or truncate and report — changes what an
  operator with a very long session sees. AC7's positive control exists so the
  ordinary case is proven unaffected before the limit case is argued about.
- **The extraction in step 1 touches a guard that four review rounds produced.**
  If the writers suite goes red or its twelve-shape test starts missing a shape,
  stop and revert the extraction rather than adjusting the test — that suite's
  green is load-bearing evidence for a security control, not a convenience.
- **A FIFO test that hangs the runner.** Mitigated by D4's per-test timeout, but
  the timeout has to be on the test rather than on the whole file, or one hang
  hides behind another's budget.
- **`readdirSync` is in `RAW_READ_CALLS`' neighbourhood but is not a read of a
  file.** Including it risks noise from legitimate directory listings in
  `store.ts`; excluding it risks a reader that lists and then reads. Step 2
  should include it and use the exemptions table with reasons rather than
  silently dropping it from the list.
