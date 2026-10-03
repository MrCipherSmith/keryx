# Review round 3 — flow 355, PR #779 (fix round over round-2's findings)

Ref: `1a11bff6fbb9fa8c05f2ba11537c6da3414959cd..9b0b3f58b18caf90b2e811744133ef2364dc7e4b`
(the merge-base before PR #779, to PR #779's own head). PR #779 was merged to
`main` as `ed1c3ba6cb224bac4bed982a56b5da73585913d5` at 2026-09-28T11:11:45Z
— tree-identical to `9b0b3f58` (`git diff ed1c3ba6..9b0b3f58 --stat` is
empty). This merge happened **during** this review round, not as a result of
it; every finding below is unaffected, since it is a claim about the code at
`9b0b3f58`/`ed1c3ba6`, both examined directly.

Branch: `fix/audit-remediation-2b`. Worktree `~/keryx-ar2b` was
removed (by the merge/cleanup, not by this round) partway through; all
re-verification after that point ran directly against `~/keryx`
at `ed1c3ba6` (confirmed byte-identical to `9b0b3f58` via `git diff --stat`
and a direct `diff` of `entropy.ts` against the worktree's copy taken
earlier in the round).

## Prior findings — disposition (round 2, package `2026-09-28-pr-776-round2-2a2db6b7`)

All four re-verified BY EXECUTION at this head, using each finding's own
reproduction inputs from the round-2 package. **Three are closed. One —
REG-F1 — is only partially closed**, and the residual is refiled below as
REG-F2.

| id | disposition | evidence |
|---|---|---|
| SEC-F1 | **closed** | `looksSecretShaped('aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8')` → `true` (was `false`); `containsOutboundSecret` on the same value in a URL → `true` (was `false`); `redactSensitiveText('leaked api_key: ' + segmented)` → `[REDACTED:entropy]` (was unchanged). Minimal-wrap variant also now caught. Pinned by `entropy.test.ts`'s SEC-F1 describe block (segmented-secret, minimal-wrap cases). |
| LOG-F1 | **closed** | All 4 originally-reported false positives (ADR relative link near "Credential Masking", GitHub noreply-email local part, `from_attributes=True`, `passlib/bcrypt/argon2`) now produce 0 `detectEntropy` matches. Pinned by `entropy.test.ts`'s LOG-F1 describe block. |
| REG-F1 | **partial — see REG-F2 below** | `containsOutboundSecret` on the Medium URL from the finding's own repro → `false` (FIXED, was `true`). `containsOutboundSecret` on the Gist URL from the same finding's repro → **still `true`** (unchanged). The finding bundled two URLs under one id; the fix (`isSlugHexTail`, bounded to the last segment of an already-valid word-slug) reaches the Medium shape but not the Gist shape, whose id is a bare, non-hyphenated 32-hex path segment that never reaches `isWordSlug` at all — it is caught unconditionally by `isHexBlob` instead. |
| SEC-F2 | **closed** | 8/8 sampled UUIDs (including the canonical RFC 4122 example, entropy 3.39) now redacted when labelled `"leaked credential: "` (was 6/8). Pinned by `redact.test.ts`'s `"F-SEC-F2 (flow 355 review, PR #776): a label overrides an allow-shape"` describe block. |

## New findings — review round 3 (the delta at this head, plus what REG-F1 left open)

### SEC-F3 (blocker) — `isSlugHexTail`, added to fix REG-F1, reopens SEC-F1's bypass class

`isSlugHexTail` grants a hyphenated slug's LAST segment a content-free
carve-out whenever it is 10-16 characters of pure hex, with **no check on
whether that segment is itself the secret**. `bareShapeQualifies` checks
`isWordSlug` before any entropy/allow-shape/label logic runs, and
`labelledPieceQualifies` (the LABELLED path) calls `bareShapeQualifies`
first, falling back to `isAllowShapedValue` only when `bareShapeQualifies`
did **not** already return `qualifies: false` via the slug exemption — so a
real secret dressed as `<word>-<word>-<10to16-hex>` bypasses
`looksSecretShaped`, `containsOutboundSecret` (S-8) and
`redactSensitiveText` (S-6) completely, **even when explicitly labelled**:

```
redactSensitiveText('leaked api_key: log-report-deadbeef01234567')
  -> 'leaked api_key: log-report-deadbeef01234567'   (unchanged)
containsOutboundSecret('https://exfil.example/log-report-deadbeef01234567')
  -> false
```

This is the same class of defect SEC-F1 closed for the digit/letter-run
segmentation trick; round 3's own fix for REG-F1 reintroduced an equivalent
primitive. A prompt-injected model instructed to "format the leaked value as
word-word-<hex>" reproduces this immediately.

**class_scope**: `isSlugHexTail` (entropy.ts:341) → `isWordSlug` (:345) →
`bareShapeQualifies` (:394, unconditional) → `shapeQualifiesAsSecret` (:424,
label-free) / `labelledPieceQualifies` (:623, labelled — checks the slug gate
BEFORE the allow-shape fallback) → `looksSecretShaped` (:439),
`secretShapedCandidatesIn` (:584), `redactSensitiveText` (S-6),
`containsOutboundSecret` (S-8), `displayUrl` (S-9).

### LOG-F2 (major) — `ADJACENT_LABEL`'s strict adjacency now misses ordinary labelled phrasing

Round 2's LOG-F1 fix correctly requires the label to be genuinely adjacent to
the value (fixing same-line proximity false positives), but the adjacency
check has no allowance for a filler/copula word between the label and the
connector, and the label look-back is bounded to the current line only. Two
ordinary, non-adversarial phrasings now go unlabelled and unredacted:

- `"password is: kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz"` → `detectEntropy` → `[]`
  (the label word "password" is not immediately followed by the connector —
  "is" sits between them).
- A label ending one line with the value starting the next (e.g. a
  shell-style `export API_KEY=\` continuation) → `[]` — the value's own line
  has no label in its look-back window at all.

Both are reproduced with `kd8Fj2LmQp9xZr4TvWn7Yb3` — the exact secret this
PR's own header comment uses as its running example for the `api_key=`
assignment fix — immediately next to an unambiguous label, with neither
S-6 (`redactSensitiveText`) nor S-8 (`containsOutboundSecret`, which reuses
the same `detectEntropy` call) catching it.

**class_scope**: `ADJACENT_LABEL` (entropy.ts:214, root) → `lastLineOf`
(:275, bounds the look-back to the current line) → `detectEntropy`'s generic
per-line pass (:706-757, the only caller) → `redactSensitiveText` (S-6),
`containsOutboundSecret` (S-8).

### REG-F2 (major) — REG-F1's residual: a bare-hex-id Gist path segment is still refused

Continuation of round-2 REG-F1, not a new mechanism: `isSlugHexTail` fixes
the Medium `<words>-<hex>` shape (hyphenated, hex tail is the last segment of
an otherwise-valid word-slug) but does **not** reach the real, common GitHub
Gist shape — `gist.github.com/<user>/<32-hex-id>` — because the id there is
a single path segment with no internal hyphenation. `isWordSlug` short-
circuits on `segments.length < 3` for a bare token, so this segment falls
straight to the unconditional `isHexBlob` check (any 24+ char pure-hex run
with a letter), independent of `isWordSlug`/`isSlugHexTail` entirely.

```
containsOutboundSecret('https://medium.com/.../rag-...-3a9bae9ec8f9')
  -> false   (FIXED)
containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890')
  -> true    (STILL REFUSED)
```

**class_scope**: `HEX_BLOB`/`isHexBlob` (entropy.ts:251/254) →
`bareShapeQualifies` (:394, unconditional branch, reached exactly because
`isWordSlug` is false for a single bare segment) → `containsOutboundSecret`
(S-8, the real-world failure site) → `secretShapedCandidatesIn` /
`urlComponentSpans` (S-6, redaction of the same shape in tool output).

## Documentation and testing-practices findings (minor)

### DOC-F1 — stale "DELIBERATELY still missed" comment contradicts the code's own test

`entropy.ts:168-171`'s header claims `token=abcdefghijklmnopqrstuvwx12345678`
is deliberately missed because it is "low-entropy". Shannon entropy over a
per-character model does not see ordering, so a 33-distinct-character string
is near-maximal entropy (5.0), not low — and the code's OWN test added in
this diff (`entropy.test.ts:331`, titled *"the coordinator's own
'low-entropy' example is actually maximal-entropy and IS caught"*) already
documents and pins the opposite. No runtime defect (the code is more
protective than the stale comment claims), but the header a future reader
sees first states a false premise the test file already contradicts.

### DOC-F2 — CHANGELOG has no entry for this round's `LABEL_ASSIGNMENT_RE`/camelCase fix

`CHANGELOG.md`'s `[0.3.20]` entry documents SEC-F1/REG-F1/LOG-F1/SEC-F2 but
not the `LABEL_ASSIGNMENT_RE` (`api_key=<value>`) and camelCase
(`apiKey: "…"`) boundary fix shipped in the same diff, with its own tests. A
genuine, user-facing behaviour change with no changelog line.

### TEST-F1 — an existing SEC-F2 pinning test is flaky (unrelated detector collision)

`redact.test.ts`'s `"F-SEC-F2 … 20 random UUIDs"` test draws unseeded
`crypto.randomUUID()` values and asserts the unlabelled half are never
redacted. Reproduced 1 failure in 4 runs: a random UUID's digit substring
independently passed the pre-existing `pii.credit-card` Luhn check
(`src/security/detect/pii.ts`, untouched by this PR), producing a
`[REDACTED:cc]` match unrelated to entropy.ts. No security gap (over-
redaction, not under-redaction), and outside this diff's own blast radius,
but an intermittently-red test in a file this round touches is worth fixing
before it erodes trust in the suite.

## Real-file sweep (review-regression requirement, re-run at this head)

| corpus | size | `detectEntropy` matches | classification |
|---|---|---|---|
| `bun.lock` | 57,262 chars | 0 | — |
| `CHANGELOG.md` | 417,214 chars | 0 | — |
| `git log -p -30 --stat` | 6,287,828 chars | 41 | 36 test-fixture secrets (added/modified `*.test.ts` diffs across these 30 commits — AWS's own `AKIAIOSFODNN7EXAMPLE` placeholder, GitHub/Slack/OpenAI-shaped fake tokens, fixture UUIDs/SHAs/integrity strings, a Google-Doc-id test fixture); 4 `Claude-Session: https://claude.ai/code/session_…` commit-trailer URLs (session identifiers — same "arguably correct to redact, capability-like" class round 2 already classified as not a defect); 1 self-referential doc-comment string (the DOC-F1 example, itself now correctly caught, not a false positive). **0 false positives, 0 unaccounted-for hits.** |
| `docs/**/*.md` (519 files) | 6,167,675 chars | 0 | — (REG-F1's own Medium-URL false positive, present in round 2's sweep of this corpus, is gone — confirms the Medium half of the fix) |

Every one of the 41 git-log hits is accounted for; none is a new false
positive and none is an unredacted real secret.

```json keryx:findings
[
  {
    "id": "SEC-F3",
    "global_id": "2026-09-28-pr-779-round3-9b0b3f58#SEC-F3",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "problem": "isSlugHexTail — added this round to fix REG-F1 — grants a hyphenated slug's LAST segment a content-free carve-out whenever it is a 10-16 character pure-hex run, with no check on whether that segment is itself the secret. Because bareShapeQualifies checks isWordSlug BEFORE any entropy/allow-shape/label logic, and labelledPieceQualifies (the LABELLED path, reached only after ADJACENT_LABEL already confirmed a label) calls bareShapeQualifies first and only falls back to isAllowShapedValue afterward, a real secret dressed as `<word>-<word>-<10to16-hex>` bypasses looksSecretShaped, containsOutboundSecret (S-8) and redactSensitiveText (S-6) completely — even when the value carries an explicit label right next to it.",
    "impact": "Complete bypass of S-6 and S-8 for a secret formatted as a word-slug with a hex tail, in both the label-free and the labelled path. Reproduced: redactSensitiveText('leaked api_key: log-report-deadbeef01234567') returns the value UNREDACTED, byte for byte, despite the explicit label; containsOutboundSecret('https://exfil.example/log-report-deadbeef01234567') returns false (not refused); looksSecretShaped('log-report-deadbeef01234567') returns false. This is the same class of defect SEC-F1 (round 2, blocker) fixed for the digit/letter-run segmentation trick — round 3's own fix for REG-F1 reopened an equivalent primitive.",
    "suggested_fix": "isSlugHexTail's carve-out must not be content-free with respect to the reconstituted secret risk: either (a) do not let it bypass the LABELLED path at all — labelledPieceQualifies should check isAllowShapedValue independently of bareShapeQualifies's isWordSlug gate, so a label always gets a chance to override a slug-shaped value, or (b) additionally require the specific segment to be validated against a real registry/shape rather than 'any 10-16 hex chars'.",
    "evidence": "bun run against ~/keryx (post-merge main, HEAD 9b0b3f58/ed1c3ba6): looksSecretShaped('log-report-deadbeef01234567') -> false; containsOutboundSecret('https://exfil.example/log-report-deadbeef01234567') -> false; redactSensitiveText('leaked api_key: log-report-deadbeef01234567') -> unchanged. Root cause: entropy.ts:412 `if (isWordSlug(head)) return { qualifies: false, entropy: 0 };` runs unconditionally inside bareShapeQualifies, which labelledPieceQualifies (entropy.ts:624) calls first, before its isAllowShapedValue fallback (entropy.ts:628).",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 341,
    "quote": "const SLUG_HEX_TAIL_RE = /^[0-9a-f]{10,16}$/i;\nfunction isSlugHexTail(segment: string): boolean {\n  return SLUG_HEX_TAIL_RE.test(segment);\n}",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:341 isSlugHexTail",
        "src/security/detect/entropy.ts:345 isWordSlug (calls isSlugHexTail on the last segment)",
        "src/security/detect/entropy.ts:394 bareShapeQualifies (calls isWordSlug unconditionally, before entropy/hex-blob)",
        "src/security/detect/entropy.ts:424 shapeQualifiesAsSecret (label-free callers)",
        "src/security/detect/entropy.ts:439 looksSecretShaped (export)",
        "src/security/detect/entropy.ts:584 secretShapedCandidatesIn (export, URL components)",
        "src/security/detect/entropy.ts:623 labelledPieceQualifies (labelled path — calls bareShapeQualifies BEFORE isAllowShapedValue)",
        "src/security/redact.ts:142 redactSensitiveText (S-6)",
        "src/harness/web/outbound-secret.ts:116 containsOutboundSecret (S-8)",
        "src/mcp-servers/http-headers.ts:384 displayUrl (S-9)"
      ],
      "enumeration_method": "keryx ctx rg -- \"isWordSlug\\(|isSlugHexTail\\(|labelledPieceQualifies\\(|bareShapeQualifies\\(\" src (excluding *.test.ts) -> all definitions and call sites are in entropy.ts (single-file gate), consistent with SEC-F1's own round-2 class_scope for the downstream exporters/callers."
    }
  },
  {
    "id": "LOG-F2",
    "global_id": "2026-09-28-pr-779-round3-9b0b3f58#LOG-F2",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "ADJACENT_LABEL (round 2's fix for LOG-F1's false-positive proximity window) requires the label word to sit immediately before the value with only a continuation, optional quote and a single ':'/'=' connector between them. This over-corrects: it now misses a real labelled secret whenever an ordinary filler word sits between the label and the connector ('password IS: <secret>'), or when the label and the value are on different lines, and the label look-back is explicitly bounded to the current line.",
    "impact": "A real, explicitly-labelled secret is not redacted (S-6) and not caught by the outbound-egress check (S-8). Reproduced: detectEntropy('password is: kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> [] (the exact secret from this PR's own header-comment example, immediately preceded by an unambiguous label); redactSensitiveText on the same text leaves it verbatim. A label ending one line with the value starting the next is also never labelled.",
    "suggested_fix": "Either widen ADJACENT_LABEL to tolerate a short, closed set of copula/filler words between the label and the connector, or special-case the common 'LABEL is VALUE' / 'LABEL: \\n VALUE' shapes the same way LABEL_ASSIGNMENT_RE special-cases 'LABEL=VALUE'. For the cross-line case, either extend the label look-back to also check the end of the previous line (bounded), or document the gap explicitly.",
    "evidence": "bun run against ~/keryx (post-merge main, HEAD 9b0b3f58/ed1c3ba6): detectEntropy('password is: kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> []; redactSensitiveText same input -> unchanged. detectEntropy('export API_KEY=\\\\\\n' + 'kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> []; detectEntropy('password is:\\n' + 'kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> []. Root cause: ADJACENT_LABEL (entropy.ts:214) requires no intervening word, and lastLineOf (entropy.ts:275) bounds the look-back to the current line by design.",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 214,
    "quote": "const ADJACENT_LABEL = new RegExp(\n  `(?:^|[^A-Za-z0-9])(?:${caseless(SENSITIVE_LABEL_WORDS)})[A-Za-z0-9_-]*[\"']?\\\\s*[:=]?\\\\s*[\"']?$`,\n);",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:214 ADJACENT_LABEL (root)",
        "src/security/detect/entropy.ts:275 lastLineOf (bounds the look-back to the current line)",
        "src/security/detect/entropy.ts:706-757 detectEntropy generic per-line pass (the only caller of ADJACENT_LABEL)",
        "src/security/redact.ts:142 redactSensitiveText (S-6)",
        "src/harness/web/outbound-secret.ts:116,122 containsOutboundSecret (S-8)",
        "src/security/detect/index.ts runDetectors (keryx security scan/report/gate)"
      ],
      "enumeration_method": "keryx ctx rg -- \"ADJACENT_LABEL\" src (excluding *.test.ts) -> single definition and single caller in entropy.ts; downstream callers re-confirmed against round-2 LOG-F1's own class_scope."
    }
  },
  {
    "id": "REG-F2",
    "global_id": "2026-09-28-pr-779-round3-9b0b3f58#REG-F2",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "REG-F1 (round 2) is only partially fixed. isSlugHexTail correctly carves out a hex tail that is the LAST segment of an already-valid word-slug (fixes Medium's '<words>-<hex>' shape), but a GitHub Gist URL's real, common shape is 'gist.github.com/<user>/<32-hex-id>' — the id is a SINGLE path segment with no internal hyphenation, so it never reaches isWordSlug at all (segments.length < 3 short-circuit). That segment falls straight to bareShapeQualifies's unconditional isHexBlob check.",
    "impact": "web_fetch still refuses an entirely ordinary, public GitHub Gist URL — REG-F1's own stated AC4 guarantee remains violated for this shape, even though the CHANGELOG and PR body describe REG-F1 as closed for 'a Medium OR GitHub Gist URL'. This is the exact reproduction the round-2 finding used, still failing.",
    "suggested_fix": "Extend the carve-out to a bare hex-blob path segment that is not preceded by a sensitive label — e.g. treat a 24-40 character pure-hex SINGLE path segment the same way isAllowShapedValue already treats a full git SHA (FULL_GIT_SHA_RE is the same alphabet at 40 chars; a Gist id is 32).",
    "evidence": "bun run against ~/keryx (post-merge main, HEAD 9b0b3f58/ed1c3ba6): containsOutboundSecret on the Medium URL from REG-F1's own repro -> false (fixed). containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890') -> true (still refused). detectEntropy shows the flagged span is the 32-char id via the hex-blob branch, not isWordSlug/isSlugHexTail.",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 254,
    "quote": "function isHexBlob(value: string): boolean {\n  return HEX_BLOB.test(value) && /[a-f]/i.test(value);\n}",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:251 HEX_BLOB",
        "src/security/detect/entropy.ts:254 isHexBlob",
        "src/security/detect/entropy.ts:394 bareShapeQualifies (unconditional isHexBlob branch)",
        "src/harness/web/outbound-secret.ts:98 anyComponentLooksSecret / :116 containsOutboundSecret (S-8, real-world failure site)",
        "src/security/detect/entropy.ts urlComponentSpans / secretShapedCandidatesIn (S-6)"
      ],
      "enumeration_method": "Same keryx ctx rg sweep as REG-F1's own round-2 enumeration; both call sites re-read directly and reproduced against the live Gist URL at this head."
    }
  },
  {
    "id": "DOC-F1",
    "global_id": "2026-09-28-pr-779-round3-9b0b3f58#DOC-F1",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "The file header comment added this round (entropy.ts:168-171) claims token=abcdefghijklmnopqrstuvwx12345678 is 'DELIBERATELY still missed' because 'its value is low-entropy'. This is factually wrong: a string with 32-33 distinct characters has entropy near the theoretical maximum, not low. The code's own test, added in the same diff, correctly documents and pins the OPPOSITE behaviour, but the header comment was not updated to match.",
    "impact": "No runtime defect — the code is more protective than the comment claims. But a future maintainer reading only the header could 're-fix' a future regression by reintroducing the wrong exemption based on a false premise already written into the file.",
    "suggested_fix": "Update the header comment to match entropy.test.ts:331-343's own framing: the value is caught BECAUSE it is maximal-entropy under this file's per-character model, not despite being low-entropy.",
    "evidence": "bun run against ~/keryx (post-merge main): shannonEntropy('abcdefghijklmnopqrstuvwx12345678') = 5.0; detectEntropy('token=abcdefghijklmnopqrstuvwx12345678') -> 1 match. entropy.test.ts:331 test title: \"R3 — the coordinator's own 'low-entropy' example is actually maximal-entropy and IS caught\".",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 168,
    "quote": "// `token=abcdefghijklmnopqrstuvwx12345678` is DELIBERATELY still missed: its\n// value is low-entropy (a near-sequential alphabet-then-digits run), so the\n// usual 3.6-bit floor correctly does not fire"
  },
  {
    "id": "DOC-F2",
    "global_id": "2026-09-28-pr-779-round3-9b0b3f58#DOC-F2",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "CHANGELOG.md's [0.3.20] entry documents the four round-2 findings but has no line for this same PR's LABEL_ASSIGNMENT_RE (LABEL=VALUE assignments) and camelCase label-boundary fix. Both are genuine, user-facing behaviour changes shipped in this same diff, with their own tests, but with no changelog line.",
    "impact": "No runtime defect. A reader of the 0.3.20 changelog would not learn that LABEL=VALUE assignments and camelCase labels are now redacted differently than before.",
    "suggested_fix": "Add a changelog bullet for the LABEL=VALUE / camelCase-label fix alongside the four already documented.",
    "evidence": "git diff 1a11bff6..9b0b3f58 -- CHANGELOG.md: +50 lines, all covering SEC-F1/REG-F1/LOG-F1/SEC-F2; no line mentions LABEL_ASSIGNMENT_RE, api_key=, or apiKey. entropy.ts:148-166 and entropy.test.ts's new 'REVIEW ROUND 3' tests confirm the behaviour shipped in this same diff.",
    "confidence": "medium",
    "file": "CHANGELOG.md",
    "line": 6,
    "quote": "## [0.3.20] — 2026-09-28\n\n### Fixed\n- **A secret re-chunked into hyphenated pieces no longer bypasses redaction"
  },
  {
    "id": "TEST-F1",
    "global_id": "2026-09-28-pr-779-round3-9b0b3f58#TEST-F1",
    "reviewer": "review-testing-practices",
    "severity": "minor",
    "problem": "src/security/redact.test.ts's 'F-SEC-F2 ... 20 random UUIDs' test draws unseeded crypto.randomUUID() values and asserts the unlabelled half are never redacted. This is flaky: one of the 20 random UUIDs can pass the pre-existing pii.credit-card Luhn check (unrelated to this PR's entropy.ts diff), producing a [REDACTED:cc] match on the 'unlabelled' assertion. Reproduced once in 4 runs.",
    "impact": "No security gap (over-redaction, not under-redaction), and outside this diff's own blast radius, but an intermittently-red test erodes trust in the suite's signal.",
    "suggested_fix": "Seed the UUID generation or filter out any sampled UUID whose digit run happens to be Luhn-valid before asserting on it.",
    "evidence": "bun test src/security/redact.test.ts -t \"F-SEC-F2\" run 4 times: 1 failure (Expected \"request id: 59593996-3554-4212-8ce6-3b142d420c0f\", Received \"request id: [REDACTED:cc]-8ce6-3b142d420c0f\"), 3 passes. pii.ts:146-147 confirms the colliding detector (pii.credit-card, mask \"cc\") is distinct from entropy.ts.",
    "confidence": "high",
    "file": "src/security/redact.test.ts",
    "line": 164
  }
]
```
