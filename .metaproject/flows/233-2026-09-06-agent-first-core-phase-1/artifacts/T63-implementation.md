STATUS: DONE

# T63 — closing T53's four findings against the auto-fetch floor

Fifth round on this floor's `<base>`/extraction repair. Files owned and changed:
`src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts` — nothing else.

Full spec, reasoning, and pre-implementation verification of each finding against the current code:
`T63-spec.md` in this directory. This report records what was actually changed and the after-numbers.

## Per-item disposition

### 1. Minor — `<base>` blast radius and non-element-context over-approximation (T53#F-001)

**Reproduced: yes**, both halves. The `tag === "base"` branch had no comment stating the
whole-document consequence of a false positive, and the shared `remediation` string was generic
across `<img>`/`<base>`. `HTML_START_TAG` matched `<base` anywhere in the raw content with no
awareness of comment/fenced-code context, so `T53-base.ts` `g07.cdnBaseInFence` and
`g08.cdnBaseInComment` were flagged — confirmed by re-running the reviewer's own unmodified probe
before touching the code.

**What changed:**
- **Disclosure.** The `<base>` branch's comment (`exfil.ts:726-741`) now states the asymmetry
  explicitly: a masked `<img src>` breaks one image, a masked `<base href>` re-points every relative
  URL in the document. The header comment (`:17-26`) carries a one-line pointer to the same fact. The
  internal `UrlHit` type gained an optional `remediation` field (default: the existing generic text,
  renamed `IMAGE_REMEDIATION`); the `<base>` callsite now passes a dedicated `BASE_REMEDIATION` string
  that names the whole-document consequence in the finding itself, not only in a comment a maintainer
  might not read.
- **Behaviour change, decided and bounded.** A `<base href>` finding is now suppressed when the tag
  falls inside a span this fragment shows is CLOSED — both delimiters present — as an HTML comment
  (`<!-- … -->`) or a CommonMark fenced code block (``` ``` ``` / `~~~`, matching-length closer
  required). Reasoning (full version in `T63-spec.md`): the asymmetry makes a `<base>` false positive
  categorically worse than an `<img>` one, both span kinds are inert under the SAME
  markdown-with-HTML-passthrough renderer model this file already assumes for every other extraction
  decision, the check is bounded to closed-only spans so a fragment with an unterminated `<!--`/fence
  is left eager (not suppressed) — the same fragment-eager principle `readStartTag` already applies to
  EOF-in-tag — and the change is confined to `<base>`; `<img>`/`<image>` keep their existing, cheaper
  non-element-context gap, which stays the deferred surfaces task's problem, not this one's.
  Implementation: `fencedCodeBlockSpans` (single linear pass pairing CommonMark opener/closer lines,
  no nested backtracking), `nonRenderedSpans` (adds closed-comment spans via a lazy literal-terminator
  scan), `isInNonRenderedSpan`, gated behind a per-call, lazily-memoized cache so content with no
  `<base>` tag pays nothing extra.
- Masking offsets are untouched — the new check only gates whether `considerUrl` is called at all; it
  never reads or writes `attribute.valueStart`.

**Measured:** `T53-base.ts` (unmodified) `benignFlaggedIds` shrank from T53's recorded
`[g05.twoBasesRelativeFirst, g06.cdnBaseDoc, g07.cdnBaseInFence, g08.cdnBaseInComment]` to
`[g05.twoBasesRelativeFirst, g06.cdnBaseDoc]` — exactly the two comment/fence cases, and only those,
stopped firing; `hostileNotNeutralizedIds` stayed `[]` (0/15, unchanged). `T53-corpus.ts` (unmodified)
part B: `codeFenceBaseExample` no longer in `flaggedIds` (was the one class-specific finding T53
reported); part A repo sweep: no benign file gained a `base-href-exfil` finding. A RED/GREEN probe
(temporarily inverting the new guard, then restoring it — file hash identical before and after,
`4ec5a924…` — no git operation used) confirmed the three new comment/fence regression tests fail
without the fix and pass with it.

### 2. Info, most consequential — the sufficiency argument names one branch; the parser has three (T53#F-002)

**Reproduced: yes.** The `SYNTHETIC_BASE_PAIRS` comment stated "a third base scheme could only repeat
one of those two branches" without ever naming `resolvedHost`'s `http:`/`https:` filter as the fact
that makes the FILE state and the opaque-path branch harmless.

**What changed:** comment only (`exfil.ts:229-254`). The corrected argument states both halves: the
two pairs are sufficient for the scheme-equality predicate; that predicate is not the only
base-dependent branch (the FILE state, reachable when the BASE's own scheme is `file:`; the
OPAQUE-PATH branch, a parse failure); neither pair realises either, and what actually closes the gap
is `resolvedHost`'s protocol filter, not a third base pair. The consequence is stated explicitly:
widening `resolvedHost` past http(s) — the named candidates are `ws:`/`wss:` and `file:` — would
resurrect exactly the branches the paragraph says are closed and would require a third base scheme
realising the FILE branch.

**No code change**: `SYNTHETIC_BASE_PAIRS`, `resolvedHost`, `agreedHost`, `exfilHost` are byte-identical
to before. Two new regression tests pin the corrected fact directly rather than leaving it as prose:
a destination resolving only to `file:`/`ws:`/`wss:`/`ftp:` under either pair is not a finding.
`T53-resolve.ts` (unmodified) re-run: `{destinations: 41, rendererBases: 15, bypasses: 0,
falsePositives: 0}` — identical to T53.

### 3. Info — the EOF-in-tag justification is one-directional (T53#F-003)

**Reproduced: yes.** `readStartTag`'s doc comment stated only the eager half (unterminated tag →
still classified) and said nothing about the unterminated-quoted-value half, which swallows the rest
of the fragment (`close === -1 → valueEnd = content.length`).

**What changed:** comment only (`exfil.ts:433-449`). Both halves are now stated: the eager half
(unchanged prose) and the conservative half, with the reviewer's own measurement cited as the reason
it is acceptable — a conformant tokenizer emits no element there either, so the fragment-may-hold-the-
terminator premise does not apply symmetrically to the closing quote.

**No behaviour change.** One new regression test pins the conservative half directly in this file's
own suite (previously only pinned in the reviewer's read-only probe): an unterminated quoted value
swallows a later real `<img>` in the same fragment. `T53-extract.ts` (unmodified) re-run: 88 cases, 0
bypasses, identical `overApproximationIds` (14, same set) to T53's recorded run — `y01`/`y02` still
`renderer=false detector=false`.

### 4. Info, needs a decision — markup inside a quoted value is released unmasked (T53#F-004)

**Reproduced: yes.** `HTML_START_TAG.lastIndex = Math.max(end, nameEnd);` carried no comment; the
decision it encodes (resume past the tag's own `>`, so markup inside a quoted attribute value is text,
not a second element) was, as the finding said, "an incidental consequence of the `lastIndex` line"
rather than a recorded decision.

**Decision: keep the behaviour, record it as deliberate.** Reasoning, now stated in the code
(`exfil.ts:708-721`): this is one of two places in the file (with the new `<base>` inert-span check)
that trusts the reader's own HTML tokenizer rather than assuming the worst of it — every other
extraction decision in this file errs toward flagging instead. The trade is accepted because it is
scoped to the same threat model this file already commits to elsewhere: a markdown-auto-render client
with raw-HTML passthrough, tokenizing conformantly. A renderer that does not tokenize conformantly (a
regex-based markdown-to-HTML pass, a sanitizer that strips tags and re-emits their contents as text)
is outside that model, and closing that gap — trusting nothing about the reader's parser — is a
larger, structural change (effectively: stop trusting `>` to end a quoted value at all) that this
task's file-scoped, comment-and-<base>-only mandate does not extend to. No test changed; the existing
`tokenizer-faithful attribute scanning adds no false positives` test already pins this behaviour.

## Files changed

- `src/security/detect/exfil.ts` — comments only for items 2–4; item 1 also adds `BASE_REMEDIATION`,
  `IMAGE_REMEDIATION`, `HTML_COMMENT_SPAN`, `FENCE_LINE`, `fencedCodeBlockSpans`, `nonRenderedSpans`,
  `isInNonRenderedSpan`, the lazily-memoized `getNonRenderedBaseSpans` inside `detectExfil`, and the
  guard on the `<base>` branch. SHA-256 at end: `4ec5a9244fc7b6998ebf60b5c04da957785f3b23e457eebb0ee59b299f5b1691`.
- `src/security/detect/exfil.test.ts` — 12 new tests appended (F-001 ×7, F-002 ×1, F-003 ×1, plus the
  remediation-disclosure and cheaper-class controls counted in the F-001 group). No existing test
  modified or removed. SHA-256 at end: `6732d06d6063e9ba67e82984c4fe99f0b9af983da7ab02789ebc6ba3517d3339`.

## Verification — exact counts and raw log paths

All raw logs under `.metaproject/data/gdctx/raw/` (copied there from the direct `bun` runs the T53/T52
dispatches also used, since `ctx run`'s compaction drops the per-case rows that are the evidence — the
same disclosed reason). "Before" = T53-review.md's own recorded numbers, since the detector file's
SHA-256 was unchanged from T53's start (`6750d80c…ccf9dd`) until this task's first edit.

| Probe | Before (T53) | After (T63) | Raw log |
|---|---|---|---|
| `T53-extract.ts` (88 cases, unmodified) | 0 bypasses, 14 over-approximations | **0 bypasses, 14 over-approximations, identical id set** | `T63-after-T53-extract.log` |
| `T53-resolve.ts` (41×15=615, unmodified) | 0 bypasses, 0 FP | **0 bypasses, 0 FP** | `T63-after-T53-resolve.log` |
| `T53-base.ts` (23 cases, unmodified) | `hostileNotNeutralized: 0`; `benignFlaggedIds: [g05,g06,g07,g08]` | **`hostileNotNeutralized: 0`; `benignFlaggedIds: [g05,g06]`** — g07/g08 no longer flagged | `T63-after-T53-base.log` |
| `T53-boundary.ts` (26 shapes, unmodified) | `hostileLeakingAtAnyBoundary: 0`; `benignNotByteIdenticalIds: [ctlCdnBaseDoc]` | **identical**: `0`; `[ctlCdnBaseDoc]` | `T63-after-T53-boundary.log` |
| `T53-corpus.ts` (repo sweep, unmodified) | part B: `codeFenceBaseExample` flagged (1 of 7) | **part B: 6 flagged, `codeFenceBaseExample` no longer among them**; part A: no benign file gained a `base-href-exfil` finding | `T63-after-T53-corpus.log` |
| `T42-exfil-attack.ts` (42 cases, unmodified) | 0 bypasses, 0 FP | **0 bypasses, 0 FP** | `T63-after-T42-exfil.log` |
| `T24-recheck2-exfil.ts` (48 cases, unmodified) | 0/0 | **0/0** | `T63-after-T24R2-exfil.log` |
| `T42-charrefs.ts` (240 cases, unmodified) | 0 bypasses | **0 bypasses, identical `absentButUrlSyntax: []`** | `T63-after-T42-charrefs.log` |
| `T42-boundary.ts` ROW 1 (unmodified) | 6 formerly-leaking shapes closed; `ctlPublicLink` `state=none` byte-identical | **identical** | `T63-after-T42-boundary.log` |
| `T24-recheck2-boundary.ts` (28 cases, unmodified) | 0 leaking at any boundary | **0 leaking, identical tokens** | `T63-after-T24R2-boundary.log` |

New regression, RED before / GREEN after (temporary in-file inversion of the new guard, restored —
file hash `4ec5a924…` identical before and after, no git operation): 3 of the 12 new tests fail without
the fix (`T63-red-probe.log`), all 36 pass with it (`T63-green-final.log`).

Required suites: `bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts
src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
src/security/persistence-sinks.test.ts` → **87 pass, 0 fail, 629 expect()**
(`.metaproject/data/gdctx/raw/2026-09-06T16-55-30-741Z_run.log`, confirmed again at
`T63-final-focused-suites.log`). `bun test src/security/detect/exfil.test.ts` alone: **36 pass, 0
fail, 331 expect()**.

`bun run typecheck` — exit 0, no output. `bunx eslint src/security/detect/exfil.ts
src/security/detect/exfil.test.ts` — exit 0, no output.

Performance sanity (not a committed artifact; session scratchpad only, since it isn't one of the
dispatch's required probes): 100 KB/8000 open tags with no `<base>` — 11.3 ms; 80 KB of 20,000
unclosed fence-opener lines followed by one `<base>` — 8.3 ms (worst case for the linear fence
scanner, still linear); 5000 closed HTML comments then a `<base>` — 3.9 ms; 920 KB benign prose plus
one `<base>` — 3.0 ms; a 500 KB unterminated `<!--` followed by a real `<base>` — 11.1 ms, and the
`<base>` is still classified (`matches: 1, egress.html-base-href-exfil`), confirming the unterminated
case is not exploitable to blanket-suppress content after it.

## Concerns for the orchestrator

None blocking. One judgement call worth surfacing: item 1's inert-span suppression is a genuine,
narrow behaviour change beyond what the reviewer's own suggested fix asked for (T53's ruling was
"keep the class... document the blast radius," without proposing context detection). I judged the
dispatch's explicit instruction to "decide whether the class should still fire" as authorizing this
independently, and the acceptance criteria's own "if behaviour changes... the matrices still hold"
phrasing anticipates it. If a reviewer disagrees with extending trust to markdown fenced code blocks
specifically (as opposed to HTML comments, which are unconditionally inert under every renderer model
this file assumes), the fenced-code-block half of `nonRenderedSpans` is the one to revisit — it is
isolated in its own function (`fencedCodeBlockSpans`) and the HTML-comment half does not depend on it.

## Routing audit

- `graph_used: no (not-relevant)` — the dispatch named the exact file set; the graph answers from the
  last `keryx gdgraph build` while this worktree carries a large uncommitted multi-worker change set,
  so a graph answer could not be quoted as current.
- `wiki_used: no (not-relevant)` — the governing texts (`T53-review.md`, `T52-implementation.md`,
  `docs/requirements/keryx-agent-first-core/policies.md`, the flow's `acceptance-criteria.md`) were all
  read directly, as the dispatch required.
- `ctx_used: partial, disclosed` — every text search went through `bun src/cli.ts ctx rg`. Probe and
  test **execution** ran `bun` directly (both the reviewer's probes and this task's own regression
  runs), for the same disclosed reason T52 and T53 gave: `ctx run`'s compaction elides the per-case
  rows that are the evidence. The one required focused-suite run went through `bun src/cli.ts ctx run`
  as specified, and its full output was small enough to read whole either way.
- `raw_rg_used: no` — no bare `rg`/`grep`/`cat`/`find`/`sed`/`tail` over project code; every attempt was
  correctly refused by the routing hook and replaced with `bun src/cli.ts ctx rg`/`ctx read` or a
  bounded `Read` call.
