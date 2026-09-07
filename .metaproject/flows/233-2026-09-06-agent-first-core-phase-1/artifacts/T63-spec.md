# T63 — closing T53's four findings against the auto-fetch floor

Fifth round on this floor's `<base>`/extraction repair. T53 (independent, tokenizer-oracle-backed
review) found no blocker and no major: one minor (F-001), three info (F-002, F-003, F-004), three of
the four about the *arguments recorded in the code* rather than the *behaviour*. This task verifies
each against the current tree, then acts.

Files owned: `src/security/detect/exfil.ts`, `src/security/detect/exfil.test.ts` only.

## Verification against current code (before writing anything)

Read `src/security/detect/exfil.ts` in full (627 lines) and cross-checked every finding's cited line
numbers and quoted code against the current tree — the file's SHA-256 at the start of T53-review
(`6750d80c…ccf9dd`) is unchanged (no drift recorded since, and I have not touched it yet).

- **F-001** (minor, `:571`, `tag === "base"` branch): reproduced by reading. The branch has no comment
  stating the whole-document blast radius, and the shared `remediation` string at `:322` is generic
  ("Strip or allowlist auto-rendered markdown image/link URLs and any `<base href>` that re-points
  them…") and does not distinguish `<base>`'s cost from `<img>`'s. The non-element-context
  over-approximation half is real: `HTML_START_TAG` (`:356`) matches `<base` anywhere in the content
  string with no awareness of comment/RAWTEXT/RCDATA/fenced-code context, so a `<base href>` quoted in
  an HTML comment or a markdown fenced code block is flagged identically to a live one. Confirmed
  reproducible.
- **F-002** (info, `:224`, `SYNTHETIC_BASE_PAIRS` comment / `exfilHost`): reproduced by reading. The
  comment at `:250-259`/`:223-229` states "a third base scheme could only repeat one of those two
  branches" without ever naming `resolvedHost`'s `http:`/`https:` filter (`:270-272`) as the fact that
  makes the FILE state and the opaque-path branch harmless. Confirmed the argument is incomplete as
  described.
- **F-003** (info, `:394`, `readStartTag` doc comment): reproduced by reading. The comment at
  `:394-398` states only the eager half ("EOF inside the tag… the renderer may hold the terminator we
  do not") and says nothing about the unterminated-quoted-value half (`close === -1 → valueEnd =
  content.length` at `:457-458`), which swallows the rest of the fragment. Confirmed one-directional.
- **F-004** (info, `:561`, `HTML_START_TAG.lastIndex = Math.max(end, nameEnd)`): reproduced by
  reading. No comment at that line records the decision; it is a bare assignment. Confirmed the
  finding's description of "an incidental consequence of the `lastIndex` line" rather than a recorded
  decision.

All four reproduce. None is rejected.

## Decisions

### F-001 — two parts

**(a) Disclosure — do.** State the whole-document blast radius in the `<base>` branch's comment and
give `<base>` findings their own `remediation` string (via a new optional `remediation` field on the
internal `UrlHit` type, defaulted to the existing generic text for every other call site) so a caller
reading `reasons: ["egress.html-base-href-exfil"]` is told the consequence is document-wide, not
one-image.

**(b) The inert-context question — change behaviour, narrowly and only for `<base>`.** Decision:
suppress a `<base href>` finding when the tag falls inside a span this fragment shows is CLOSED —
both delimiters present — as an HTML comment (`<!-- … -->`) or a CommonMark fenced code block
(``` ``` ``` or `~~~`, opener and matching closer both present). Reasoning:

1. **The asymmetry is real and specific to `<base>`.** A false positive on `<img src>` breaks one
   image; a false positive on `<base href>` re-points the whole document. `<img>`/`<image>` keep the
   existing, cheaper non-element-context gap unchanged — closing it for every element and every
   non-element context (RAWTEXT, RCDATA, bogus comment) uniformly is the deferred render-triggered-
   surfaces task's job (the dispatch's own scope line), not this branch's.
2. **HTML comments are inert under every renderer model this file already assumes.** The file's own
   header frames the threat model as a markdown-auto-render client with raw-HTML passthrough
   (`<img src>`/`<base href>` are matched as raw HTML specifically because such clients render embedded
   HTML too). An HTML comment is never turned into a live element by either a markdown-then-HTML
   pipeline or a raw-HTML-only one. This is unconditionally safe to suppress.
3. **Markdown fenced code blocks are inert under the SAME assumed model.** CommonMark guarantees a
   fenced code block's content is rendered as literal text, never parsed as HTML or markdown, in any
   compliant renderer. This is the same class of trust-the-renderer decision this floor already makes
   and records for F-004 (below) — not a new kind of risk, and it is recorded as a decision for the
   same reason F-004 asks its own trust decision to be recorded rather than left as an implicit
   consequence.
4. **Bounded to avoid a new bypass.** Only a span with BOTH delimiters present in the fragment counts.
   An unterminated `<!--` or an unclosed fence at the end of the fragment does not swallow the rest of
   the content — the same fragment-eager bound `readStartTag` already applies to EOF-in-tag (T53#F-003):
   a truncated fragment cannot tell "the renderer's real document has no closing delimiter" from "the
   closing delimiter is past what this scanner was given," so ambiguity resolves toward flagging, not
   toward suppressing. This also forecloses the obvious abuse (open an unterminated comment early and
   hope everything after it stops being classified) — it does not, because it is never treated as
   closed.
5. **Implementation stays linear.** Fenced-code-block detection is a single forward pass pairing
   opener/closer lines (CommonMark's own closing rule: same character, at least as long), not a nested
   backtracking search. HTML-comment detection is a lazy literal-terminator scan (`-->`), the same
   pattern already used elsewhere for bounded scanning in this codebase.

This is a genuine behaviour change, disclosed here and measured below, not merely a comment edit.

### F-002 — comment only, no behaviour change

Rewrite the sufficiency argument to name `resolvedHost`'s `http:`/`https:` filter as the fact that
makes the FILE state and the opaque-path branch harmless, and state the consequence: widening
`resolvedHost` past http(s) invalidates the argument and requires a third base scheme realising the
FILE branch. No code change beyond the comment; `SYNTHETIC_BASE_PAIRS`, `resolvedHost`, `agreedHost`,
`exfilHost` are unchanged. Two regression tests added pinning the load-bearing fact directly (a
destination that only ever resolves to `file:`/`ws:`/`wss:`/`ftp:` under either pair is not a finding),
so the corrected argument is backed by a test, not only a sentence.

### F-003 — comment only, no behaviour change

State both halves of the EOF rule in `readStartTag`'s doc comment: the eager half (unterminated tag →
classify) and the conservative half (unterminated quoted value → swallow to end of fragment, matching
a conformant tokenizer, per T53-extract's `y01`/`y02`). No code change. One regression test added
pinning the swallow behaviour directly in this file's own suite (previously only pinned in the
reviewer's read-only probe).

### F-004 — record the decision, do not change behaviour

Add a comment at the `HTML_START_TAG.lastIndex = Math.max(end, nameEnd)` line naming the decision and
its premise: markup inside a quoted attribute value is text for any conformant HTML parser, so it is
released unmasked; this is the one point (together with the new F-001(b) inert-context check) where
this floor trusts the reader's parser rather than assuming the worst. No behaviour change — the
existing false-positive-removal behaviour and its existing test coverage
(`tokenizer-faithful attribute scanning adds no false positives`) stay as they are. Recorded, per the
dispatch, rather than reversed.

## Planned code changes to `src/security/detect/exfil.ts`

1. Header comment (`:17-20`): one clause noting the blast-radius asymmetry and pointing at the new
   inert-span exception.
2. `SYNTHETIC_BASE_PAIRS` comment block (`:210-229`): replace the closing paragraph with the corrected,
   two-part sufficiency argument naming `resolvedHost`'s filter and the widening consequence.
3. New constants/functions before `readStartTag` (module scope): `HTML_COMMENT_SPAN`, `FENCE_LINE`,
   `fencedCodeBlockSpans`, `nonRenderedSpans`, `isInNonRenderedSpan` — the bounded, linear inert-span
   detector, `<base>`-only.
4. `readStartTag` doc comment (`:394-398`): add the conservative half and its measurement.
5. `UrlHit` type: add optional `remediation?: string`. `considerUrl`: use `hit.remediation ??
   IMAGE_REMEDIATION`. New constants `IMAGE_REMEDIATION` (existing text, renamed) and
   `BASE_REMEDIATION` (new, states the whole-document consequence).
6. `HTML_START_TAG.lastIndex = Math.max(end, nameEnd);` line: add the F-004 decision comment.
7. `tag === "base"` branch (`:566-584`): add the blast-radius comment, gate `considerUrl` on
   `!isInNonRenderedSpan(m.index, getNonRenderedBaseSpans())`, pass `remediation: BASE_REMEDIATION`.
   `getNonRenderedBaseSpans` is a lazily-memoized closure inside `detectExfil` so content with no
   `<base>` tag pays no extra scanning cost.

No change to extraction for `<img>`/`<image>`, no change to `SYNTHETIC_BASE_PAIRS` values, no change to
`resolvedHost`/`agreedHost`/`exfilHost`, no change to markdown extraction, no change to character
reference handling. Masking stays on the original byte offsets throughout — `isInNonRenderedSpan` only
gates whether `considerUrl` is called at all; it never touches `attribute.valueStart`.

## New tests planned for `exfil.test.ts`

1. `<base href>` inside a closed HTML comment → no finding.
2. `<base href>` inside a closed backtick-fenced code block → no finding.
3. `<base href>` inside a closed tilde-fenced code block → no finding.
4. `<base href>` inside an UNTERMINATED comment or fence → still a finding (bounds the new behaviour).
5. `<img src>` inside a comment or fence → still a finding (pins that F-001(b) is base-only).
6. `<base href>` outside a fence in a document that also contains a benign fence elsewhere → still a
   finding (the check is span-local, not a document-wide toggle).
7. Base finding's `remediation` mentions the whole-document consequence and differs from an image
   finding's `remediation`.
8. A destination resolving only to `file:`/`ws:`/`wss:`/`ftp:` under either synthetic base pair is not
   a finding (F-002's corrected load-bearing fact, pinned directly).
9. An unterminated quoted value swallows the rest of the fragment (F-003's conservative half, pinned
   directly in this file's own suite).

None of these weaken or delete an existing test.

## Verification plan

Before / after, all under `.metaproject/data/gdctx/raw/`:
- `T53-extract.ts`, `T53-resolve.ts`, `T53-base.ts`, `T53-boundary.ts`, `T53-corpus.ts` (read-only,
  unmodified) run directly with `bun` (not `ctx run`, which elides per-case rows).
- `T42-exfil-attack.ts` (42 cases), `T24-recheck2-exfil.ts` (48 cases), `T42-charrefs.ts` (240 cases),
  `T42-boundary.ts`, `T24-recheck2-boundary.ts`.
- `bun src/cli.ts ctx run -- bun test src/security/detect/exfil.test.ts
  src/security/output-validation.test.ts src/mcp/structural-redaction.test.ts
  src/security/persistence-sinks.test.ts`.
- `bun run typecheck`, `bunx eslint` on both changed files.

Expected deltas: `T53-base.ts` `benignFlaggedIds` shrinks by exactly `g07.cdnBaseInFence` and
`g08.cdnBaseInComment` (both inert-span cases); `g05.twoBasesRelativeFirst` and `g06.cdnBaseDoc` stay
flagged (neither is a comment/fence case — out of scope by design, see judgement above). Every other
probe: byte-identical / zero-bypass / zero-false-positive, unchanged from T53's numbers, since no
extraction, resolution, or markdown logic changes.
