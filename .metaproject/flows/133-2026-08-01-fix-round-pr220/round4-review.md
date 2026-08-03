# Round four — the review of the round that closed round three

Five reviewers, distinct lenses. Verdict: **REQUEST_CHANGES**. 1 blocker, ~12 majors,
~12 minors.

Three reviewers were killed mid-run by an account rate limit and were relaunched
from scratch on an unchanged tree; the two that survived the first attempt were
not re-run. One reviewer briefly wrote a probe file into the shared tree despite
the constraint — it was removed before the round ended and the tree is clean, but
it is recorded because the whole point of the constraint is that concurrent
readers see a stable tree.

---

## The trend

| round | blockers | majors |
|---|---|---|
| one | 2 | 8 |
| two | 4 | 8 |
| three | 1 | 9 |
| four | 1 | ~12 |

The blocker is again inside the fix written to close the previous round's
blocker-adjacent finding — the fifth consecutive round. But the shape has
changed, and the change is the important part.

---

## The pattern this round exposes, which is not a code defect

Round three's findings against me were **defects in code**. Round four's are
overwhelmingly **claims stronger than the evidence behind them**, and they are
all mine:

| claim I made | what was true |
|---|---|
| "closed by construction … removes the entire class of evasion-by-respelling" | 12 ordinary spellings defeat it, verified directly |
| "One point, not an interval" (the `BAN_VALUE` sweep) | the suite pins `(0.4, 0.5)`; my ten-value grid had one sample inside it |
| "letting an attacker run 1500 guesses" | the attacker is never refused; 1500 was my probe's loop cap |
| "saturating with cooldowns buys only the early expiry of a cooldown that was about to lapse" | a pinned table clears a cooldown with the full 60s remaining |
| stdout table control row `173B` | 222B — and my own "was 349B" in the same table proves it, since 349 = 222 + 127. The two rows the fix was about were instrumented; the control row was filled in from memory |
| "memoizeResolved had no pinned caller — now it does" | one of its two callers is pinned; the other is the HMAC load the file is about |
| "every self-check now plants what defeated the previous version" | all four plant exactly the implementation's own branch list |

Every one of these is the defect I have spent four rounds filing against other
people's work. The mechanism is consistent: I measure something real, then state
a conclusion one step stronger than the measurement supports, and the stronger
sentence is the one that gets copied forward.

---

## F-022 (blocker) — the AST guards are an enumeration, and I called them a closure

`src/lib/config-dir.ast.ts`, and the four guards built on it.

A reviewer planted ten working production modules in a sandbox. Every one
compiles, every one does the forbidden thing at runtime, and the suite stays at
136 pass / 0 fail. I re-ran the twelve evasions directly against the real module:

```
MISS  specifier built by concatenation          MISS  Object.assign split profile
MISS  createRequire bound to another name       MISS  spread profile
MISS  template WITH a substitution              MISS  Object.defineProperty seam
MISS  row table [{mode,rank}]                   MISS  computed key from an identifier
MISS  named-constant values                     MISS  Object.fromEntries
MISS  static class fields                       MISS  chained Map .set()
```

Twelve for twelve. And worse — three **false positives**:

```
FIRES  two unrelated helpers, one comparison each
FIRES  a validation set: ["deny","ask","allow"]
FIRES  projecting a profile into an evidence record
```

The comparison counter is file-wide, so two independent functions each holding
one `if (x === "deny") return 1` read as an ordering chain. False positives are
worse than misses: a guard that cries wolf gets switched off, which the module's
own docstring says.

`SupplyForm` declares a `"spread-unknown"` variant that nothing produces. I saw
the spread hole, wrote it into the type, and did not close it.

**The honest conclusion.** Matching the AST is better than matching text — a
declaration cannot be confused with a construction, and a destructuring read
cannot be confused with a supply, and both of those are real. But it is still an
enumeration of node shapes, and I sold it as a closure. "Text has spellings;
structure does not" is a good sentence and a false one: `Object.assign`,
`fromEntries`, a class field and a spread are four structures for one semantic
act.

A reviewer enumerated **fifteen** places where the closure claim now appears —
two source modules, three test files, two memory documents, one flow record and
three commit messages. It propagated faster than the regex-widening claim it
replaced.

---

## F-023 (major) — the throttle's price table is false, for the third round running

`src/lib/serve-throttle.ts:242-253`

Measured, driving the real sequence the route uses:

```
[route4]   A guesses=500 refused=50   A still tracked? false
[decoys@4] A guesses=500 refused=491        <- control, decoys one below the crossover
[victim ban] before={"throttled":true,"retryAfterSeconds":60} after={"throttled":false}
```

With decoys parked at exactly `LIMIT/2` (value 0.5 against `BAN_VALUE` 0.45),
every one of them outranks a cooldown, so *any* cooldown is the unique minimum
and the soonest-expiring tie-break never runs. The victim's ban had the full 60
seconds left, not "about to lapse".

**Honest bound, and the reviewer supplied it unprompted:** an attacker with 1024
source addresses can already take 9 guesses from each — 9216 per window, free,
because the throttle is per-peer and 9 < 10. This route costs 85 req/s of decoy
traffic to get a *worse* rate from one address. The capability is unchanged and
the 32-byte token is untouched.

It is filed major anyway because it is the same defect class the file produced
last round — a docstring asserting a bound the code does not hold — recurring in
the sentence written to replace it.

## F-024 (major) — rule 2 of the same docstring still says `0.5`, and still contains the sentence the file condemns

`src/lib/serve-throttle.ts:191-194` says a cooldown is worth `0.5` (it is 0.45)
and closes with *"a peer more than halfway is not [cheaper to lose]"* — which is
verbatim the sentence `:73-75` of the same file quotes as the defect it fixed. The
file ships the fix, documents the fix, and restates the defect as its rule.

## F-025 (major) — `keyPath` invalidates every on-disk idempotency claim

No migration, no note, no sweep. An install that upgrades sees every existing
claim as unclaimed, so a client retry runs a second billed provider call — the
at-most-once → at-least-once conversion this flow's own catch-block comment says
was measured at "one idempotency key bought two provider calls". Orphaned files
are never read and never removed.

## F-026 (major) — the ALLOW half of the `--runtime` contract is not implemented

`applyRuntimeRefusal` returns at `code === 0` having written nothing, while
`src/ctx/runtimes.ts` defines `{"permission":"allow"}` / `{"allow_tool":true}` and
`src/ctx/hook.ts` writes them. I copied the refusal document and not the
contract — the same sentence I wrote about the previous round's fix.

**Bound:** the security installer's cursor entries live under `securityHooks`,
which the module itself documents as read by no runtime, so this is reachable
only by hand-wiring; the guard that actually runs on Cursor is `keryx ctx hook
cursor`, which does write allow documents. Materially deflated, still wrong.

## F-027 (major) — the legacy hook migration is one-sided

`dropLegacyEntries` is careful on the security side. `src/ctx/runtimes.ts`'s
`hooksObject` still turns a `hooks` array into `{}`, destroying both the legacy
managed entries and any user entry beside them. The coexistence test drives four
combinations and never drives legacy → `ctx.merge`.

## F-028 (major) — `constructsWith` NARROWED the guard it replaced

The old regex reported `const base = {profileId, trustMode}; const clone = {...base, requiredControls: c}`.
The AST version requires both fields in one literal and is silent. A rewrite sold
as strictly better is weaker on the most natural way to clone a profile.

## F-029 (major) — `memoizeResolved` is pinned at one of two callers

`configFor` is pinned; `hashOnce` is not. Replacing `hashOnce` with a bare thunk
leaves `src/security/` at 85 pass. `hashOnce` is the HMAC key load — the thing
the test file's own opening docstring is about.

## F-030 (major) — three mutations to the hook code have no test

`flatStrip`'s call to `dropLegacyEntries` can be deleted (85 pass); the
`...userGroups` spread can be removed (85 pass); and two of the four
install/uninstall orders are never driven — including stripping the installer
that ran *first*, which is the asymmetric case the file exists for.

## F-031 (major) — self-checks restate the implementation's branch list

Third round running. Every positive case in all four self-checks corresponds 1:1
to a written branch of the predicate. The `INVISIBLE` markers all refer to what
the *regex* could not see; not one marks a form the *current* implementation was
not explicitly written for.

## F-032 (major) — inherited numbers, again

- "1500 guesses unrefused" — the attacker is never refused; 1500 was a loop cap.
  Inherited verbatim from the reviewer's own F-013 text into a commit and a
  docstring that both open by insisting every number was re-derived.
- The stdout table's control row `173B` should be `222B`.
- The memory note says "four of the **five** policy words"; there are **eleven**.
  I fixed `three`→`four` and left the denominator, which is the same operation
  that produced "8 000 events gave 1 302 890 bytes".
- The note's closing section still argues about "all four" after reducing itself
  to two.
- F-020 was reported closed while two of the four restatement sites the review
  named are untouched (`plan.md:170`, `:174`).

## Minors

`flatValidate` uses `.find` where every other validator in both registries uses
`.some`, so a user entry with the same `on` shadows the managed one ·
`--runtime=cursor` (equals form) silently disables the whole contract, because
`optionValue` knows only the space form · `hooks install` reports success without
saying the guard is inert in advisory mode · `walk` used `getChildren()` and
cost ~2x `forEachChild` for identical behaviour (653,949 vs 1,278,189 nodes over
626 files; the "10x" and "351 files" this line carried until round six were an
artifact of timing the two arms with different harnesses, and a `sourceFiles()`
count that excludes tests) ·
`config-dir.ast.ts` sits in `src/lib/` and imports `typescript`, a
devDependency, with no production-importer guard — unlike `config-dir.scan.ts`,
which has exactly that guard · dead code: `SupplyForm.spread-unknown`, an
unreachable `isNoSubstitutionTemplateLiteral` branch, unused `code` and
`statSync` imports · a dangling `§Bounds` that lost its document ·
"`await import(…/shell-config.ts)` in four places" — it appears once; four
different modules are imported that way.

---

## What the reviewers got right that I would have got wrong

Two reviewers volunteered bounds that reduced the severity of their own
findings — the throttle route that costs more than the free baseline, and the
allow-path gap that is unreachable through the installed configuration. A third
verified twelve of my mutation claims and confirmed them exact, then filed the
two that were not. That is the difference between a review and an attack, and it
is worth naming because the previous round's most useful correction was also a
reviewer being wrong in a way I had to prove.

---

## Direction, not yet a plan

1. **Stop asserting closure.** All fifteen sites. What is true: the AST predicates
   are an enumeration of node shapes, strictly better than the text enumeration
   they replaced, with a stated and incomplete gap list.
2. **Fix the false positives first.** A guard that fires on a validation set will
   be deleted by the next person who trips on it, and then it protects nothing.
3. **For the importer guard there IS a real closure available** — ask the
   bundler. `bun build` resolves the actual production module graph, which is
   ground truth regardless of how the specifier was spelled. That closes one of
   the four for real; the other three have no such oracle and should say so.
4. The concrete defects: the idempotency index, the allow path, the one-sided
   migration, `.find`→`.some`, the equals-form flag, `hashOnce`, the three
   untested hook mutations.
5. Every number, re-derived — including the ones in this document.

---

# Disposition — closed (2026-08-02)

| id | closed by | how |
|---|---|---|
| F-022 blocker | `6a0cdd19` | false positives first; a real closure via the bundler for the one question that has one; five gaps closed, seven written down as executable "still missed" tests |
| F-023, F-024, F-032 | `d2fb14e4` | price table re-derived; rule 2's stale constant and restated defect; "1500" was a loop cap; every count re-measured |
| F-025 | `f6413ad3` | legacy claims adopted, but only their owner's — a blind migration would have been F-017 again |
| F-026 | `f5cf65a2` | `allowAction` beside `refusalAction`; `--runtime=<id>` reaches the same contract |
| F-027, `.find`, 3 untested branches | `7197e0c7` | ctx preserves foreign arrays; validation is about the MANAGED entry |
| F-029 | `7ee87f05` | the HMAC memo — the caller the file is actually about |
| F-028 | `6a0cdd19` | `constructsWith` had NARROWED the guard it replaced; spread and `Object.assign` restored it |
| F-030 | `6a0cdd19` | the three untested branches |
| F-031 | `6a0cdd19` | self-checks inverted — they now plant what the predicate is known NOT to catch |
| minors | `755882af` | dead code, the traversal change, the advisory caveat install never printed |

> **Corrected after round five.** This table was published with F-028 and F-031
> missing and F-030 unlabelled, under a heading that says "closed" — a closure
> table silently dropping two of its majors is the same operation as correcting
> a number where the fixer happens to be reading, which is habit 3 below.
>
> Two figures were also wrong, and the first version of this banner pointed at
> the wrong places for both — it said "the rows above" when the same commit had
> already scrubbed the row, and named a figure that is below it.
>
> `755882af`'s "10x traversal" is 1.95x by nodes and roughly 1.3-2.8x by time,
> re-measured with one harness for both arms; the original compared an explicit
> stack against a recursive generator. The live copy of that claim was in the
> **Minors prose**, in the present tense, and is corrected there.
>
> The suite figure below was correct when written and is stale: **2962 pass, 14
> skip, 0 fail** at the time of this correction.

Suite: **2937 pass, 14 skip, 0 fail** across 291 files.

## What I changed about how I work, not just what I fixed

Every finding this round was a claim stronger than its evidence. Three concrete
habits came out of it, and they are the durable part:

1. **A grid of ten samples is not a proof of uniqueness.** "One point, not an
   interval" was true of my sampling and false of the code. When a claim is about
   a boundary, sweep the boundary.
2. **A loop cap is not a measurement.** "1500 guesses" was `300 × 5`. If a probe
   stops because I told it to, the number is my bound, not the system's.
3. **Correct a claim everywhere it was copied, not where I happen to be
   reading.** `plan.md` carried a retired count through two rounds because each
   fix touched the file the fixer had open.

And one about scope: I now go looking for the **oracle** before writing a
matcher. For "does this module ship" the bundler is one, and it made a guard that
three rounds of pattern-widening could not. For the other three properties there
is none, so they say "heuristic" and carry a gap list.

## Found while fixing, not by the review

- Below the eviction crossover an attacker at 4 guesses per address is never
  refused — 4000 and counting. Inherent to any threshold, worth less than the
  free per-peer allowance of 9, documented and pinned rather than left.
- `pii: { action: "allow" }` still redacts (carried from round three, still not
  chased — a question about the resolver, outside this flow).

## Method note

Three of the five reviewers were killed mid-run by an account rate limit and
were relaunched on an unchanged tree. One reviewer wrote a probe file into the
shared tree despite the constraint. Both are recorded because the value of these
rounds depends on the tree being stable while it is read, and on knowing when it
was not.
