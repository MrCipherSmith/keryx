# Round six — the review of the round that closed round five

Four reviewers, not five: the scope was four commits, and a fifth lens would
have duplicated rather than covered. Verdict: **REQUEST_CHANGES**. 2 blockers,
~13 majors. All closed.

| round | blockers | majors |
|---|---|---|
| one | 2 | 8 |
| two | 4 | 8 |
| three | 1 | 9 |
| four | 1 | ~12 |
| five | 2 | ~8 |
| six | 2 | ~13 |

Seventh consecutive round in which a blocker sat inside code written the round
before to close the previous finding.

---

## F-040 (blocker) — an approval for content the policy said to redact

`src/commands/security.ts` · closed by `d4ae57db`

`computeGate` returns `pass` for anything not `block`-actioned and not over
`failOn` severity — which includes findings the policy asked us to REDACT. The
shipped default is `pii: redact`. Reproduced on a stock install:

```
stderr  gate: PASS  action: redact  findings: 2   (email, ssn)
stdout  {"permission":"allow"}                     exit 0
```

The hook has no channel to redact anything; `decision.redacted` is text on
stderr. So keryx's answer to "there is an SSN here and my policy says redact it"
was a machine-readable approval to proceed with the unredacted content. Live on
`PreToolUse` too — an agent writing a file with PII got an approval for a write
the policy flagged.

This is round four's blocker one precedence level down, in the same function,
two rounds running. An approval is now emitted only when every finding is
`allow` or `warn`.

**And the justification I wrote for the fix was false.** I claimed silence made
a runtime "fall back to its OWN default, which for a permission gate is to ask
the operator". Measured:

```
claude       allow=[]  silence=[]   IDENTICAL
windsurf     allow=[]  silence=[]   IDENTICAL
generic-mcp  allow=[]  silence=[]   IDENTICAL
cursor       allow=[{"permission":"allow"}]  silence=[]   distinct
```

On three of the four runtimes the installer installs into, silence and approval
are the same bytes; there is no third signal to fall back to. For cursor there
is no citation anywhere in this repository for what an empty response means. So
the three-way contract is three-way on **one** runtime, and the honest statement
of what this function does is that it never AFFIRMS a decision the policy was
unhappy with. Tracked as OQ-4.

**A third path, from the same reviewer.** The config is never validated on the
enforcement path — `validateSecurityConfig` is called only by `policy validate`.
`{"gate":{"failOn":"nope","minConfidence":5}}` puts every detector below the
floor, so a `block` finding becomes `warn`, and a live AWS key was answered with
an approval. An unknown policy is not a permissive one; it now suppresses the
approval and says why, without manufacturing a refusal.

That check validates the LOADED config. The first version validated the file,
the schema describes a fully populated policy, and partials are merged over
defaults — so it rejected every ordinary config and turned eight passing tests
red. That is how it was caught.

## F-041 (blocker) — a build step not spelled `bun build` was silently skipped

`src/lib/production-graph.test.ts` · closed by `e3bf6478`

The parser skipped anything whose first two tokens were not `bun build`, so a
step it did not RECOGNISE was indistinguishable from a step that does not build.
Its own comment named "a sub-script" as safely skippable; a sub-script is a
build step wearing a different hat. Three ordinary spellings shipped
`config-dir.scan.ts` into `dist/` with the suite green:

```
NODE_ENV=production bun build ./src/tools/report.ts …    SHIPPED
bun --bun build ./src/tools/report.ts …                  SHIPPED
bun run build:tools                                      SHIPPED
```

Rounds one to three lost the import guard to respellings; this is the same
defect one level up, at the build step. Fixed by inversion: an allowlist of
commands that cannot emit a module, env prefixes stripped, runner flags skipped,
`bun run <name>` resolved. Anything else is refused loudly, because "I do not
recognise this" and "this is harmless" are different answers.

## F-042 to F-045 (majors) — the guard predicate was inverted on the two shapes it separates

Closed by `91247681`. The reviewer's framing, which is the right one:

- **`as const` defeated the array form.** `readsAPosition` read only the
  literal's immediate parent, and `as const` inserts an `AsExpression`. A second
  `trustMode` ranking — F-004 — was reintroducible by two keywords, and `as
  const` is this repository's dominant idiom for exactly this kind of table.
- **`indexOf(x) !== -1` was reported as an ordering.** It is the pre-`.includes`
  spelling of a membership test. The previous fix separated a rank from a set by
  METHOD NAME when what separates them is whether the index is used as a value.
- **A method or getter did not count as supplying a seam** — and both guarded
  seams are function-valued, so `{ containmentAvailable() { … } }` is the most
  natural spelling.
- **A projection with ONE shorthand property** was reported as constructing a
  profile.

So the ordering was invisible and the validation set was reported: both of the
shapes the predicate exists to distinguish, backwards.

Fixing the last one reversed an assertion I wrote in round five — that reading
off two different objects makes it a construction. That was an artifact of how
the first fix happened to be written, not a decision.

## F-046 to F-049 (majors) — what I said about my own evidence

Closed by `acc79e47`.

- `e17ecc0a` **claimed a fix it did not make**: "`--outdir=` … no longer throws"
  while the parser was still space-form only. `889558ec` corrected it three
  commits later and framed it as "what was left" rather than as a retraction.
- `round5-review.md` said **"All closed"** and F-034 was not — the next commit
  opens "Finishing the round-five blocker".
- `round4-review.md`'s correction banner **pointed at the wrong places**: it
  corrected a row the same commit had already scrubbed, while the live copy of
  the 10x claim stood in the Minors prose, present tense, 56 lines earlier.
- **"138 guard tests", "baseline 145 pass" named no runnable set.** The one
  figure offered as evidence was the one a reader could not re-derive. There is
  now a `test:guards` script — 161 pass across 5 files.
- My comment claimed **"the numerator assertion below is what caught it"** for
  the sourcemap resolution base. True of the afternoon I wrote it, false of the
  committed suite. `resolveSources` is extracted and the nested case is tested.
- `isFlagValue` treated any preceding flag as taking a value, so
  `bun build --minify ./a.ts ./b.ts` silently dropped an entry point.

---

## The trend, and what to do about it

Six rounds, 12 blockers, ~58 majors. Blockers per round: 2, 4, 1, 1, 2, 2. It is
not converging, and the composition has changed: rounds one and two found
defects in code, rounds four to six increasingly find **claims stronger than
their evidence** — mine.

Three things are now clear enough to act on:

1. **The guards cost more than they return.** Six rounds, every round a finding,
   and their value is defence-in-depth against accidental duplication — not a
   security control. The one with a real oracle (`production-graph`) is worth
   keeping; the pattern-matching three should be capped: no more widening
   without a planted, executed counter-example, and a standing acceptance that
   they are heuristics.
2. **A claim in a commit message is unreviewable after the fact.** Three rounds
   running found a commit whose message overstated its evidence, and the
   correction always has to be made somewhere a reader will actually look — the
   code, not the commit. That is now the habit: retractions go in the file.
3. **A number without a runnable command is not evidence.** `test:guards` exists
   for that reason.

The remaining open item from round three is unchanged and still out of scope:
`pii: { action: "allow" }` still redacts.
