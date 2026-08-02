# Round three — the review of the round that closed round two

Five reviewers, distinct lenses, run concurrently against `169537b8..HEAD`.
Verdict: **REQUEST_CHANGES**. 1 blocker, 9 majors, ~20 minors.

Methodological note first, because it is the reason this round is trustworthy
where round two's was not: every reviewer was forbidden from writing to the tree.
Round two was contaminated by the orchestrator running mutations while four
reviewers read, and one reviewer's run failed six tests for a reason unrelated to
their work. This round, one reviewer copied the tree to a sandbox and ran real
mutations there; the rest described mutations and the orchestrator ran them after
collection. Nothing in the repository was modified during the read.

---

## The trend, stated plainly

| round | blockers | majors |
|---|---|---|
| one | 2 | 8 |
| two | 4 | 8 |
| three | 1 | 9 |

Round three found a blocker **in the fix round that closed round two**, and it is
in the same control — the authentication throttle — that round two filed a major
against. That is the fourth consecutive round in which the code written to close
a finding contained the next one.

---

## F-013 (blocker) — the throttle is switched off by a table of stale decoys

`src/lib/serve-throttle.ts:67` (`BAN_VALUE`), `:225-226` (`valueOf`)

Two facts introduced by this round's own fix combine:

1. `valueOf` scores a ban at a flat `0.5` and an unbanned record at
   `failures.length / AUTH_FAILURE_LIMIT`. Any record at 6+ failures **outranks a
   ban**.
2. `valueOf` reads `failures.length` **raw**. The sliding window is pruned only
   inside `recordFailure`, and only for the peer being recorded. A record parked
   at 6 failures an hour ago still scores `0.6` forever.

So an attacker fills the table with 1023 addresses at 6 failures each — once,
~6100 requests — and from then on their own ban is always the cheapest record in
the table. One request from a throw-away address evicts it.

Reproduced (`scratchpad/pin.ts`, real module, fake clock advanced a full hour
after setup so no decoy can be argued to be fresh):

```
pinned : {"guesses":500,"refused":0,"throttledNow":false}
control: {"control_guesses":10,"control_refused":490}
```

The module states the opposite as its conclusion, at `:216-217`:

> *"What they cannot do is push out the record of the address they are currently
> guessing from."*

They can, for one request per ten guesses.

**Two more angles on the same design, found independently:**

- On a table of **only** bans the minimum is a ban, so a flood clears the
  flooder's own ban at a cost of one request — no decoys needed.
- `BAN_VALUE` is pinned only at the extremes. Every value in `[0.1, 0.9)` passes
  all 17 tests, because the flood test plants peers at 1 failure and the
  interleave test plants an attacker at 9. At `0.85`, all green, an attacker
  interleaving **8** guesses per address is never throttled. And the shipped
  `0.5` ties with a peer at exactly 5 of 10, loses the tie-break, and lets that
  attacker run 1500 guesses — so the docstring's "a peer more than halfway is not
  cheaper to lose" is off by one at exactly halfway, untested.

**The conclusion is that the shape is wrong, not the constant.** A cooldown is a
decision already taken, not a cost estimate, and putting it on the same scale as
an accumulation invites exactly this. The fix direction: a ban is not evictable
while it is being served; `MAX_TRACKED_PEERS` bounds *unbanned* records; a
separate, smaller cap bounds concurrent bans; and `valueOf` prunes the window
before measuring.

Honest bound on impact: the bearer token is 32 CSPRNG bytes, so this does not
make credential guessing feasible. What it means is that the control
`security-policy.md` requires does not exist in practice, and the module
documents a guarantee it does not provide.

---

## F-014 (major) — on Cursor the refusal still does not refuse

`src/commands/security.ts:401-411` vs `:694-710`

`handleCheck` prints the human report to stdout, then `applyRuntimeRefusal`
appends the decision document to the same stream. Cursor decides from stdout
JSON. Reproduced:

```
$ printf 'AKIA…' | keryx security check-input --source untrusted-external --runtime cursor
EXIT=0
stdout: 349 bytes, of which the last line is {"permission":"deny",…}
JSON.parse(stdout) -> FAILS: Unexpected token 'k'
```

The owner module gets it right — `src/ctx/hook.ts:49` writes `action.stdout` and
nothing else. Two callers of one shared helper, one on a polluted stream: the
same asymmetry commit `ae1211ea` claims to have removed. It copied the *document*
and not the *contract*, and the contract is "stdout is exactly this one JSON
document".

The test was written around the defect. `security.check-input.test.ts:221` reads
`.split("\n").at(-1)` — an admission that the stream carries other lines. Nothing
asserts stdout parses as a whole, which is what a consumer does.

Found by three reviewers independently and reproduced by the orchestrator.

---

## F-015 (major) — the four source guards this round widened are all still defeated

Every one proven by planting a real production module in a sandbox copy and
observing the suite stay green.

| guard | the spelling it cannot see |
|---|---|
| scanner-importer (`config-dir.readers.test.ts:665`) | `from "./config-dir.scan.ts"` — **the extension**, which is this very file's own idiom at lines 88/94/100/107 |
| rank table (`profiles.test.ts:332`) | `{ ["read-only"]: 0 }`, `new Map([["deny",0],…])`, an if-chain, a ternary chain |
| profile literal (`profiles.test.ts:303`) | quoted keys, `requiredControls: buildControls()` — **the exact case the widening was added for** — and `trustMode :` with a space |
| weakening seam (`serve-server.test.ts:428`) | `opts.containmentAvailable = () => true` — a property assignment |

Planted `src/lib/scanner-user.ts` importing the scanner with a `.ts` extension:
60 pass, 0 fail. Planted `src/harness/policy/ranks-duplicate.ts` with a computed-key
object and a `Map`: 60 pass, 0 fail.

**This is the recorded lesson, violated in the act of recording it.**
`.metaproject/memory/constraints/code-blanks-string-literals.md` says a
self-check must plant the spelling *production uses*, not one the guard already
knows. All four rewritten self-checks plant only shapes the new regex already
matched.

The structural conclusion: **regex over source text is the wrong tool.** Each
widening buys one spelling and the next reviewer finds another. TypeScript is
already a dependency; these guards should match the AST — an object literal whose
keys are the policy vocabulary and whose values are numeric, an import
declaration whose specifier resolves to the scanner module, a property assignment
or initialiser naming the seam. Structure has no spellings.

---

## F-016 (major) — `isServerFault` owns one site of the five it documents

`src/lib/serve-turn-store.ts:149`, `src/lib/serve-turn.ts:861`

The docstring: *"The single owner of a split that five call sites were each
making for themselves."* It has exactly one caller. `serve-turn.ts:861` still
reads `held.reason !== "absent"`, and the two predicates **disagree on
`malformed`**. Driven end to end, one corrupt `turn.json`:

```
GET  /v1/turns/<id>                  -> 404 not-found
POST /v1/turns (dup key naming it)   -> 500 record-unreadable
```

Same file, same read, same reason, two contradictory answers on one surface.
That is the defect the commit's own prose describes — the reason has changed from
`not-regular` to `malformed` and the sites have swapped roles.

The compile-time guarantee is also half-delivered: a seventh member of
`TurnReadFailure` is a compile error in `isServerFault` and a **silent `true`** at
`serve-turn.ts:861`.

Found by three reviewers independently.

---

## F-017 (major) — idempotency keys are global, so one project's key answers another's submission

`src/lib/serve-turn-store.ts:136`, `src/lib/serve-turn.ts:941`

`keyPath` hashes the caller-supplied key and nothing else. `claimTurnKey` never
receives `project`.

```
claim for project /a: {"existing":null}
claim for project /b: {"existing":"1111…1111"}
```

`POST /v1/turns {project:"/b", idempotencyKey:"daily"}` is answered
`200 {duplicate:true, turnId:<the /a turn>}`, and `GET /v1/turns/<that id>`
returns `/a`'s result text. Project `/b`'s prompt never runs.

This is the failure `resolveProject`'s own docstring says the identity-first
design exists to prevent — *"a bug whose symptom is one project's prompt running
under another project's profile."* The binding is enforced on the `project` field
and bypassed by the `idempotencyKey` field in the same request. Every idempotency
test uses a single project.

---

## F-018 (major) — the two hook installers destroy each other's config

`src/security/agent-hooks/runtimes.ts:174-185` vs `src/ctx/runtimes.ts:277-312`

Both write `.cursor/hooks.json` and `.windsurf/hooks.json`, with **incompatible
types** for `settings.hooks` — security an array of `{on, command}`, ctx an object
keyed by the runtime's real event name. Each strip helper recognises only its own
type and replaces the other wholesale.

```
ctx-then-sec  ctx.validate: ["cursor: missing beforeShellExecution guard"]
sec-then-ctx  sec.validate: ["cursor: missing input hook routing to check-input", …]
              _keryxManaged: ["ctx-agent-hooks","security-agent-hooks"]   <- claims both
```

The sentinel keeps claiming the destroyed guard is installed. Separately,
`src/ctx/runtimes.ts` marks the real Cursor (`beforeShellExecution`) and Windsurf
(`pre_run_command`) contracts `confidence: "verified"`; the security installer's
flat shape matches neither, so on those two runtimes the hook is in a shape the
runtime does not read. Pre-existing, but it is what makes this round's "blocking
on every runtime keryx installs into" claim untestable.

---

## F-019 (major) — the `startup-blocked` arm cannot be reached by a startup refusal

`src/lib/serve-turn.ts:741,747`

`run.ts:543-586` `earlyTermination` — the function that handles *"Startup blocked:
missing required provider precondition(s)"* — emits `status: "failed"`, not
`"blocked"`. `status: "blocked"` comes only from `resolveStatus`: unresolved
risks, or a completion gate that refused. So a stock install lands on
`run-failed:blocker:startup` and never on the arm labelled `startup-blocked`,
while that arm fires for a completion-gate refusal. The docstring and the
operator-visible label describe two different causes.

---

## F-020 (major) — the round's own durable memory note is 2× wrong

`.metaproject/memory/constraints/code-blanks-string-literals.md`

Headline: *"Four occurrences."* Two of the four rows are false, verified against
the pre-round blob:

- **The scanner-importer guard never used `code()`.** `git show
  2b2e7fc2:src/lib/config-dir.readers.test.ts` carries the docstring *"NOT through
  `code()`, and that is the interesting part… Comments are stripped locally
  instead"* and a local `withoutComments`. Its real defect was knowing only
  `from "…"`. Nothing to do with blanking.
- **The switch-label rank guard is not an occurrence, it is the mitigation.**
  `RANK_SWITCH` was written structurally *because of* the blanking.

Only two rows are genuine. The note is the round's one durable artifact and its
headline count is twice reality, with two files misattributed. The same wrong
count is restated in `plan.md:174`, in commit `2fe267d1`, in commit `8652e4e9`
("Fourth guard in this tree"), and in `serve-server.test.ts:1146`.

Also false in the same note and in `profiles.test.ts:321-324`: *"three of the five
words… cannot be written as bare identifiers"* — it says three and then names
**four**. And *"a verbatim copy of the tables in `ranks.ts` was invisible by
construction"* is wrong for two of the four tables: `OUTCOME_RANK` and
`INPUT_TRUST_RANK` are all bare identifiers, and the guard's own pre-round
self-check planted `{deny: 0, ask: 1, allow: 2}` and expected it as an offender,
thirty lines below the sentence claiming it was invisible.

---

## F-021 (major) — the pipeline docstring states the release policy this round inverted

`src/lib/serve-turn.ts:831`

> *"And every step after the claim RELEASES it on failure… `createTurnRecord`,
> both event appends and `finishTurn`…"*

F-003 made the release conditional on `!effected`, and `onEffect` fires before
`runOffline`. Of the four writers this sentence enumerates, only
`createTurnRecord` is on the near side. The catch comment 60 lines below says the
opposite in the same file. A reader who takes the docstring gets the at-least-once
behaviour the round removed.

---

## Minors — the ones that are numbers I wrote and did not re-derive

- *"1800 consecutive guesses"* (`serve-throttle.ts:201`, `.test.ts:242`, commit
  `246dfa43`). The probe as committed is `round < 50` × 9 guesses = **450**. 1800
  needs 200 rounds.
- *"8 000 events gave 1 302 890 bytes"* (`config-dir.ts:152`). Arithmetically
  impossible for any shape yielding 1 418 890 at 10 000: that is 162.9 B/event
  against 141.9. The two figures the paragraph was rewritten to fix both
  reproduce exactly; the third is new.
- *"the other fourteen"* (`serve-server.ts:656`). There are 19 other
  `errorResponse` call sites, or 13 other distinct codes. Neither is fourteen.
- *"3.3% of this repository's own prose"* (`security.ts:660`). Does not reproduce
  for any natural population: docs 4.22%, src 1.93%, both 2.41%, all tracked
  0.91%. And **`README.md` produces zero injection matches**, so the sentence
  naming it as a refusal is false. Inherited verbatim from the round-two report
  and restated without re-measuring.
- *"Three rules"* (`serve-throttle.ts:159`). This round deleted rule 3 and folded
  it into the tie-break; there are two.
- *"Every one carries a mutation"* (`plan.md:170`). Two of the eight commits state
  none — `64a949bc` and `839aba24`, and F-015 is about `839aba24`.
- `runOffline` *"catches its own provider failures"* (`serve-turn.ts:620`). It does
  not; `runRemoteTurn`'s own catch does. The conclusion still holds, the credited
  module does not do the thing.
- `ctx` *"uses `trusted-project` for command output"* (`types.ts:19`). It tags
  command output `tool-output`; the one `trusted-project` use is a file read.
  In a docstring whose purpose is telling a caller which of five kinds to pick.
- The `--runtime` help lists `claude|codex|windsurf|cursor|antigravity` as
  *"written by `hooks install`"*. `hooks install` writes four, including
  `generic-mcp` which is absent; `codex` and `antigravity` are never written.
- *"`hooks install` writes `check-output` into `PreToolUse` for every runtime"* —
  only Claude uses those event names; the other three write a flat array.
- The EISDIR test cannot distinguish propagated from retried-and-threw-again;
  deleting the errno discrimination leaves 30 tests green. The commit's "pinned in
  both directions" is false for that direction.
- `memoizeResolved` is exhaustively tested and its **use** is not: replacing both
  `memoizeResolved(...)` wrappers with bare thunks leaves `src/security/` at 78
  pass, and the 80µs/event regression returns silently.
- The check-output §7a test has no proof the content was read; its check-input
  sibling has one and is honest.
- `expect(result?.outcome).toBeDefined()` is satisfied by `"completed"` — the
  value it was written to exclude. Redeemed by two siblings, holds nothing itself.
- The internal-error emitter count is defeated by spelling the log line through a
  template, and it is the only guard in the tree with no numerator self-check.

---

## Verified sound — named because each could plausibly have been a defect

The optimistic-append fast path cannot lose an event (`appendFileSync` raises
ENOENT from `open()` before any bytes are written, so the retry cannot
double-append), and no production path reaches `appendTurnEvent` before
`createTurnRecord`. The chmod inference in "the fast path leaves the parent
directory untouched" is sound and has a positive control. `internalErrorResponse`
discloses nothing and the two boundaries cannot drift because they are one
function; its Bun signature is correct. The perf figures reproduce (25.95/26.93 →
9.73/9.54 µs; the memo's 80µs reproduces at 81.9). The `not-regular` → 500 change
is not a new oracle: authentication runs before the URL is parsed. Path
containment holds — `isTurnId` gates both URL entry points, `matchRoute` matches
by segment, `idempotencyKey` reaches a path only as a digest, and `deps.newId` is
not supplied in production. `serve-turn.outcome.test.ts` is total over the union.
The PATH-planted `bwrap` test is the strongest construction in the round: it moves
what the detector sees rather than deriving the expectation from it. The
`authority` → `trustMode.authority` rename broke no contract — nothing serialises
`widened`. `2878 pass / 14 skip / 0 fail` reproduces exactly.

---

## What this round changes about how the next one is done

1. **Stop widening regexes.** Four guards, four rounds, four new spellings. Move
   the source guards to AST matching or delete them and hold the property another
   way. A guard that can be defeated by a file extension is worse than no guard,
   because it reads as coverage.
2. **Re-derive every number before restating it.** Five of this round's false
   claims are figures carried verbatim out of a previous report. The round-two
   lesson said exactly this and it happened again.
3. **A self-check must plant what the current guard MISSES.** Written down,
   violated four times in the commit that wrote it down.
4. **The reviewers must not share a mutable tree with the orchestrator.** This
   round worked; keep it.

---

# Disposition — all nine closed (2026-08-02)

| id | closed by | mutation that proves it |
|---|---|---|
| F-013 blocker | `5be13fbf` | reverting the prune fails the decoy-pin test; the constant sweep collapses from `[0.1, 0.9)` to the single point `0.45` |
| F-014 | `75053543` | returning the report to stdout fails four tests |
| F-015 | `1d5ad83e` | the reviewer's three planted production modules now fail six tests across all three guards; under the regexes they left sixty green |
| F-016 | `c625be7f` | routing `serve-turn.ts` through `isServerFault` — the reviewers' own proposal — fails a test |
| F-017 | `e2afde74` | dropping the project from the digest fails two tests; plain concatenation fails the injectivity test alone |
| F-018 | `14857b5a` | pointing the key back at `hooks` fails five of six; removing the legacy migration fails two |
| F-019 | `267f1983` | the listener now pins the exact reason code, which `toContain("blocker")` could not |
| F-020, F-021 | `267f1983` | corrected against the pre-round blob and re-derived measurements |
| minors | `ff1ffb93`, `267f1983` | five assertions that could not fail, each with its surviving mutation now red |

Suite: **2910 pass, 14 skip, 0 fail** across 290 files.

## Where a reviewer was wrong, and why it mattered

Three reviewers independently said `isServerFault` had one caller while
claiming five, and recommended routing the other four through it. The count was
right; the recommendation was not. Two questions were being conflated — how a
route answers (404/500) and whether a definite answer exists at all — and they
disagree on `malformed` on purpose. Running their proposal as a mutation failed
a test, which is how it was settled rather than argued.

Recorded because a review's diagnosis and its prescription are separate claims,
and this round would have introduced a defect by accepting the second along with
the first.

## Two things found while fixing, not by the review

- `pii: { action: "allow" }` still redacts. Measured while looking for a config
  knob that changes `redact()` output: `redact`, `warn` and `allow` all mask the
  span, and only `enabled: false` does not. A question about the resolver, out of
  this round's scope, noted in `service.memo.test.ts` rather than chased.
- Adding a fourth string parameter to `claimIdempotencyKey` left every stale
  three-argument call site TYPECHECKING while silently shifting each argument one
  position. `tsc` reported nothing. Every call site was found by grep and
  re-checked by hand.

## What changed about method

1. **Reviewers must not share a mutable tree with the orchestrator.** Round two
   was contaminated by exactly that. This round forbade writes, one reviewer
   sandboxed a copy to run real mutations, and the results were trustworthy.
2. **Regex source guards are gone.** Four guards, three rounds, one spelling per
   widening. They match the AST now — see
   `.metaproject/memory/lessons/regex-guards-lose-to-spellings.md`.

   > **Round four disproved this.** Two things were wrong: the internal-error
   > emitter count is still a regex, and the AST rewrite was defeated by twelve
   > ordinary spellings within one round. Matching the AST is better; it is not
   > a closure. Corrected in `round4-review.md` and in the lesson.
3. **Re-derive every number.** Five false claims this round were figures carried
   verbatim out of a previous report. Two of them were in the memory note written
   to stop exactly that.
