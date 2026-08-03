# Round five — the review of the round that closed round four

Five reviewers. Verdict: **REQUEST_CHANGES**. 2 blockers, ~8 majors, ~10 minors.

> **This said "All closed" and F-034 was not.** The commit immediately after this
> record opens "Finishing the round-five blocker": the parser still crashed on
> `--outdir=`, which the record's own F-034 body does not mention. Closed by
> `889558ec`, and the entry-point half again by `e3bf6478` in round six after a
> reviewer shipped the scanner through three build-step spellings the parser
> skipped.
>
> Writing the disposition before the work is finished is the same substitution
> the round is about, applied to the record of the round.

Two reviewers were killed mid-run by an account rate limit and were relaunched
on an unchanged tree. No reviewer wrote into the shared tree this time.

| round | blockers | majors |
|---|---|---|
| one | 2 | 8 |
| two | 4 | 8 |
| three | 1 | 9 |
| four | 1 | ~12 |
| five | 2 | ~8 |

Both blockers were inside code written one round earlier to close a round-four
finding. Sixth consecutive round.

---

## F-033 — a mode that does not refuse became a machine approval

severity: blocker

class_scope:
- sites: `src/commands/security.ts:applyRuntimeDecision` — one call site, serving both `check-input` and `check-output`; `exitCodeFor` is the only producer of the code it read.
- enumeration_method: enumerate every `(mode, gate)` pair `exitCodeFor` maps to 0, then run the real CLI for each against every runtime.

`src/commands/security.ts` · closed by `03a1a7fe`

Round four added the allow document because a passing check was handing
stdout-JSON runtimes zero bytes. The fix keyed on `code === 0`, and that returns
0 for two different reasons: "the decision was clean", and "this mode does not
refuse on that gate". `advisory` — the shipped default — returns 0 for **every**
gate including `fail`. Reproduced on a default install with a live AWS key:

```
stderr  gate: FAIL   ✗ secret/secrets.aws-access-key → block
stdout  {"permission":"allow"}                          exit 0
```

Strictly worse than the bug it replaced. Before, the allow path wrote zero bytes
and the runtime fell back to its OWN default, which for a permission gate is to
ask the operator. An approval suppresses that prompt for exactly the inputs
keryx flagged as blocking. The `ci` + `needs-approval` case is the sharpest:
`require-approval` means *ask a human*, answered by a machine approval.

There were always three outcomes and the code had two. Silence is the third, and
it is a statement: keryx has a finding, the operator's mode does not refuse on
it, and the decision stays where the mode setting left it.

## F-034 — the bundler guard read one entry point of however many

severity: blocker

class_scope:
- sites: `production-graph.test.ts` — `releaseCommands` (`tokens[2]`), `entryOf`, and the constructed `mapFile`; three derivations of one entry point.
- enumeration_method: read every place the entry point is derived; then add a second positional to the real build command and run both the suite and `bun run build`.

`src/lib/production-graph.test.ts` · closed by `e17ecc0a`

`releaseCommands` took `tokens[2]` as *the* entry point; `bun build` accepts any
number of positionals. A reviewer added a second one to the same command,
shipped `dist/tools/report.js` with the source scanner inside it — `dist` is in
`package.json` `files` — and the suite stayed green, **including the test named
"every entry point in the release script is asked"**, which only checked that
some graphs existed.

Every positional is an entry point now, every emitted `.js.map` is read rather
than one filename constructed, and the counts are asserted against each other.

That was not the whole of it. `--outdir=./dist` still crashed the parser
(`889558ec`), and a build step not spelled literally `bun build` — an env-var
prefix, `bun --bun build`, `bun run <sub-script>` — was still silently skipped
and shipped the scanner (`e3bf6478`, round six). Three fixes for one finding.

While rewriting it I broke it in a new way and the numerator caught me:
resolving sourcemap paths from the map's own directory instead of the outdir
root silently missed every nested artifact. Second time this guard's numerator
has caught a wrong-base bug, both times a `path.resolve`.

## F-035 — the commit about honest evidence shipped eight fixes and tested one

severity: major

class_scope:
- sites: every predicate branch `6a0cdd19` added to `config-dir.ast.ts` — three false-positive fixes and five closed gaps.
- enumeration_method: delete or disable each branch one at a time and run the guard suite.

`6a0cdd19` · closed by `e17ecc0a`

Three false-positive fixes and five closed gaps. **Seven of the eight could be
deleted with the guard suite green.** A reviewer verified each individually.
The commit's subject was "a real closure where one exists, and an honest gap
list where none does"; it described eight fixes and proved one.

Each now has a test with a control, and each mutation fails exactly one test.

> **The numbers this section originally quoted — "138 guard tests", "baseline
> 145 pass" — named no runnable set.** No command in the repository produced
> either. I ran a specific group of files and never wrote down which, so the one
> figure offered as EVIDENCE was the one figure a reader could not re-derive.
> There is now a `test:guards` script; quote its output or quote nothing.

## F-036 — the "ten times" traversal is 1.95x

severity: major

class_scope:
- sites: `config-dir.ast.ts:walk` and both places the figure is quoted — the COST block and the function docstring — plus the commit subject.
- enumeration_method: measure both arms with ONE harness (the recursive generator `walk` actually is) over the same file set.

`755882af` · closed by `6c5a4041`

Re-measured with ONE harness for both arms — the recursive generator `walk`
actually is — over 626 files:

```
forEachChild    653,949 nodes    225ms / 343ms
getChildren   1,278,189 nodes    619ms / 451ms
```

The 10x came from timing the two arms with different harnesses: an explicit
stack for one, the generator for the other. The file count was wrong too — 341,
not 351.

## F-037 — the COST header described the code it had replaced

severity: major

class_scope:
- sites: the COST block at the top of `config-dir.ast.ts` against `walk`'s own docstring 15 lines below it.
- enumeration_method: `git log -p --follow src/lib/config-dir.ast.ts` across the round, reading each comment against the code as it stood after that commit.

Present tense, saying `walk` USES `getChildren()` and "it stays for now", seven
hours after the same round reversed that. The commit updated the function's
docstring and left the file header. A correction over an uncorrected body, in
the header of the file the blocker was filed against.

## F-038 — the gap list advertised a caught case

severity: major

class_scope:
- sites: the KNOWN GAPS list in `config-dir.ast.ts`; every entry is a claim about a predicate this file exports.
- enumeration_method: call the exported predicate directly on each declared gap and on its nearest supported neighbour.

"A builder function returning the object" was listed as an open gap. Measured:
it is CAUGHT. Wrong in the direction that matters — a gap list that names a safe
shape invites someone to write it. Only the class form is a gap.

## F-039 — the declared gaps and the tested gaps were different sets

severity: major

class_scope:
- sites: the KNOWN GAPS list in `config-dir.ast.ts` against the executable gap tests in `config-dir.ast.test.ts`.
- enumeration_method: plant every declared gap and confirm it is still a gap; plant every tested gap and confirm it is declared.

Same count, seven; different memberships. The prose named a builder (caught) and
prebuilt options (untested) and omitted `createRequire` (tested). Now one set,
including the gap this round CREATED: scoping the comparison counter per
function made a ranking split across two functions invisible, and nothing
declared it.

## Minors

The `§Bounds` citation in `serve-throttle.ts` attributed to api-protocol.md a
sentence that lives in specification.md, over a section that has no row about
request rate · round four's disposition table dropped F-028 and F-031 under a
heading that says "closed" · `03a1a7fe` named the wrong test as the survivor of
its mutation (two reviewers found this independently) · the memory note's body
still carried the sentence its own correction section condemns.

---

## Where a reviewer was wrong

One reported that `d2fb14e4`'s `§Bounds` fix "did not happen", with an empty
grep as evidence. The diff carries it. Their supporting observation — that the
remaining citation attributes the sentence to the wrong document — was correct
and is fixed. Recorded because a headline can be false while the finding under
it is true, and both halves need separate treatment.

## What this round says about the previous one

Round four's lesson was "every finding was a claim stronger than its evidence".
Round five found the same thing in the commits written to fix it: an eight-fix
commit with one test, a 10x measured with two instruments, a gap list that
advertised a caught case, a header in the wrong tense. The habit is not fixed by
noticing it once.

The one that transfers: **a fix without a test is a claim.** Seven of eight is
not a slip in wording, it is the same substitution of description for evidence,
and it happened in the commit whose subject was that distinction.
