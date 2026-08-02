# Round five — the review of the round that closed round four

Five reviewers. Verdict: **REQUEST_CHANGES**. 2 blockers, ~8 majors, ~10 minors.
All closed.

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

## F-033 (blocker) — a mode that does not refuse became a machine approval

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

## F-034 (blocker) — the bundler guard read one entry point of however many

`src/lib/production-graph.test.ts` · closed by `e17ecc0a`

`releaseCommands` took `tokens[2]` as *the* entry point; `bun build` accepts any
number of positionals. A reviewer added a second one to the same command,
shipped `dist/tools/report.js` with the source scanner inside it — `dist` is in
`package.json` `files` — and the suite stayed green, **including the test named
"every entry point in the release script is asked"**, which only checked that
some graphs existed.

Every positional is an entry point now, every emitted `.js.map` is read rather
than one filename constructed, and the counts are asserted against each other.

While rewriting it I broke it in a new way and the numerator caught me:
resolving sourcemap paths from the map's own directory instead of the outdir
root silently missed every nested artifact. Second time this guard's numerator
has caught a wrong-base bug, both times a `path.resolve`.

## F-035 (major) — the commit about honest evidence shipped eight fixes and tested one

`6a0cdd19` · closed by `e17ecc0a`

Three false-positive fixes and five closed gaps. **Seven of the eight could be
deleted with all 138 guard tests green.** A reviewer verified each individually.
The commit's subject was "a real closure where one exists, and an honest gap
list where none does"; it described eight fixes and proved one.

Each now has a test with a control, and each mutation fails exactly one test:
baseline 145 pass, each mutation 144 pass / 1 fail.

## F-036 (major) — the "ten times" traversal is 1.95x

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

## F-037 (major) — the COST header described the code it had replaced

Present tense, saying `walk` USES `getChildren()` and "it stays for now", seven
hours after the same round reversed that. The commit updated the function's
docstring and left the file header. A correction over an uncorrected body, in
the header of the file the blocker was filed against.

## F-038 (major) — the gap list advertised a caught case

"A builder function returning the object" was listed as an open gap. Measured:
it is CAUGHT. Wrong in the direction that matters — a gap list that names a safe
shape invites someone to write it. Only the class form is a gap.

## F-039 (major) — the declared gaps and the tested gaps were different sets

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
