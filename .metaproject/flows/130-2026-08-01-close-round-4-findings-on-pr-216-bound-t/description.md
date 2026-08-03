# Close round-4 findings on PR #216: bound the session-store reads, guard the reader class, refuse non-regular config files

Status: formalized
Source: round 4 of review on PR #216 (flow 128), deferred out of flow 129 by name

## Provenance of the finding set — read this first

Flow 129's `description.md` deferred "the nine findings from round 4 on PR #216
(unbounded session-store reads, the FIFO hang, the `<addr>` placeholder, three
inaccurate comments)" to this flow, so that fixing the pipeline and fixing what
the pipeline found could be attributed separately.

**The round-4 report itself is not on disk.** It was the first report written in
the new format, `keryx review ingest` refused it over the finding-heading defect
fixed in `9d4d3b84`, and no package was ever created. `.metaproject/reviews/`
holds only the two flow-129 packages. PR #216 carries zero review comments.

So the eight findings below were **re-derived from the current source on `main`
and each one verified against a file and a line**, rather than reproduced from
the lost report. Where the count differs from the recorded "nine", the missing
one is not reconstructed and not invented — a padded finding would be worse than
an absent one, and the recorded count is preserved here so the gap stays visible.

## Problem

`05a9a8e3` (R4b) landed the `keryx serve` skeleton with nothing behind the door,
precisely so the containment around it could be finished before anything could
execute. Round 4 found that the containment is not finished, and that the reason
is structural rather than incidental: the guard that is supposed to hold the
*class* of "a reader of the shared user-global directory" is a hand-written list.

### F-001 — the readers guard is a hand-written list, not a source-level guard

`src/lib/config-dir.readers.test.ts:36` declares `READERS` as a literal array of
six entries and its own comment calls the list "the point". Nothing derives the
denominator from the source, so a reader that nobody remembered to add is
invisible to it. This is the root: F-002 is what the gap already let through.

The correct construction exists in this same directory.
`src/lib/config-dir.writers.test.ts` scans the tree, blanks string literals and
comments, reports every file that names a config-path resolver and makes a raw
write, carries exemptions with stated reasons, and is itself mutation-tested
against twelve planted writer shapes. It was built after four rounds of exactly
this failure on the writer side. The reader side never got it.

### F-002 — two unbounded reads under the shared directory

`src/session/store.ts:189` (`readSummaryFile`) and `src/session/store.ts:251`
(`readJsonl`) call `readFileSync` directly on files under
`<configDir>/sessions/`. Neither appears in `READERS`. Both sit inside a
`try/catch`, which cannot catch what actually happens: Bun aborts inside
`readFileSync` on an oversized file, so the process dies with SIGABRT (exit 134)
and nothing on stdout or stderr — the exact symptom `config-dir.ts:62-74`
describes and claims to have closed.

`src/lib/config-dir.ts:17-20` lists `sessions/` among the files this directory
resolves, which is true of the *path* and false of the *read*.

### F-003 — the bound is by size only, so a non-regular file hangs instead of failing

`readConfigFile` (`src/lib/config-dir.ts:93`) decides on `statSync(file).size`.
A FIFO stats as size 0, passes the bound, and `readFileSync` on a FIFO with no
writer blocks forever. `keryx serve status` against a `serve.json` replaced by a
FIFO produces no output, no refusal and no timeout. A hang is not a safer
failure than an abort; it is a less legible one.

### F-004 — a transcript is not a config file and needs its own bound

`MAX_CONFIG_FILE_BYTES` is 1 MB, chosen because "every file in this directory is
a few hundred bytes of JSON". `context.jsonl` and `archive.jsonl` are neither.
Routing F-002's two readers through `readConfigFile` unchanged would refuse
every genuinely long session and turn F-002 into a resume regression. The
transcript readers need a separate, larger bound with stated behaviour at the
limit.

### F-005 — the printed refusal instruction is not executable verbatim

`src/lib/serve-server.ts:155` and `src/commands/serve.ts:229` print
`keryx serve config set --bind <addr> --acknowledge-non-loopback`.
`src/commands/serve.recovery.test.ts:481` substitutes `<addr>` for a real address
before executing it. The suite's guarantee — every printed instruction is
executed and must exit 0 — therefore holds for an instruction the test wrote,
not the one the operator is handed.

### F-006, F-007, F-008 — three comments asserting enforcement that does not exist

The class the recorded lesson names: *a comment asserted a control that did not
exist*.

- `src/lib/config-dir.ts:70-73` — "so the bound lives here and every reader uses
  it." False while F-002 stands.
- `src/lib/config-dir.readers.test.ts:31-35` — "`config-dir.writers.test.ts` is
  the source-level guard that fails when a new WRITER appears — between them,
  adding a file to this directory without bounding its read takes deliberate
  effort." The writers guard inspects writes and has never looked at a read. The
  `sessions/` readers took no effort at all to get past it.
- `src/lib/config-dir.ts:17-20` — lists `sessions/` alongside the bounded files
  with no note that its reads bypass `readConfigFile`, so the header reads as
  coverage it does not have.

## Expected Outcome

No reader of the shared user-global directory can abort or hang the process, and
that property is held by a guard derived from the source rather than from
someone's memory of the reader set.

- A source-level readers guard with the shape of `config-dir.writers.test.ts`:
  denominator derived from the tree, exemptions with reasons, mutation-tested
  against planted reader shapes.
- The two `src/session/store.ts` reads go through a bounded path.
- A non-regular file is refused, not read.
- Transcripts have a bound of their own, with stated behaviour at the limit.
- Every printed operator instruction is executable verbatim, placeholders
  included.
- The three comments say what the code does.

## Decisions

### D1 — the guard is the deliverable; the two reads are a consequence

F-002 is fixed because F-001's guard reports it, not beside it. If the reads are
patched first and the guard is added afterwards, the guard is never observed
finding anything, which is the decorative shape `config-dir.writers.test.ts`
warns about in its own header. Build the guard first, watch it report both
`store.ts` lines, then fix them.

### D2 — a separate transcript bound, not a raised config bound

Raising `MAX_CONFIG_FILE_BYTES` to fit a transcript would loosen the bound on
`auth.json`, `serve-credentials.json` and the registry to no purpose. Two bounds
with two reasons, each stated where it is declared.

### D3 — refuse non-regular, do not special-case FIFOs

`statSync().isFile()` is the check. Enumerating the non-regular types that are
known to hang is the per-site shape this flow exists to stop; the regular-file
requirement is the class.

### D4 — a hang must fail the suite, not pass it

Every new negative test carries a timeout that fails on expiry. A test that
hangs and is killed by the runner reads as infrastructure noise; F-003 is
precisely a hang, and a suite that cannot distinguish one from a pass cannot
hold it.

## Out of Scope — with reasons

- **R4c and anything behind the door.** Turn submission, streaming and the
  non-weakening profile are a separate slice with its own launch prompt
  (`docs/requirements/keryx-remote-entry/launch-prompts/R4c-flow-orchestrator.md`).
  This flow closes the containment R4b left open; it adds no route.
- **The `KERYX_DATA_DIR` divergence** between `src/lib/config-dir.ts` and
  `src/session/paths.ts`. Recorded as deliberate at `config-dir.ts:22-29`:
  teaching the resolver about the variable would relocate the `auth.json` of any
  install that sets it. That is a migration, not a cleanup.
- **A directory-mode fail-closed check.** Named as missing at
  `config-dir.ts:205-207` and genuinely worth having. It is a permission
  control, not a read bound, and mixing it in would make it impossible to say
  which change closed which finding.
- **Reconstructing the ninth round-4 finding.** See the provenance note above.
