# Review round 2 — flow 355, PR #776 (fix round)

Ref: `dc63b9bc..2a2db6b7b05761b8f0a38bd057671cc286512c05` (equivalently
`b7020b9fed35889b5fa814fdea4dd31ce5a28765..2a2db6b7b05761b8f0a38bd057671cc286512c05`
now that `origin/main` has advanced past a squash-merge of this same PR —
`2a2db6b7`'s tree is byte-identical to merge commit `83dcdab1`, confirmed via
`git diff 2a2db6b7..83dcdab1 --stat` returning empty).

Worktree: `~/keryx-ar2` at `2a2db6b7b05761b8f0a38bd057671cc286512c05`.

## Prior findings — disposition (round 1, package `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02`)

All eight re-verified BY EXECUTION against the new head, using the reviewers'
own reproduction inputs. Seven are fully closed; one (F-SEC-F2) is only
partially closed — the mechanism it named is fixed, but a distinct,
previously-unnoticed gate still swallows a fraction of the exact repro case
the finding used.

| id | disposition | evidence |
|---|---|---|
| F-SEC-F1 | closed | `bun run` against `~/keryx-ar2`: generic `?d=`, split `?a=/?b=`, and percent-encoded `t%6fken=` all now `containsOutboundSecret() === true` (refused). Pinned by `src/harness/web/outbound-secret.test.ts`: `"an anonymous query param with an opaque high-entropy value is caught"`, `"a percent-encoded PARAM NAME does not exempt a secret-shaped value ('t%6fken=')"`. |
| F-SEC-F2 | **partial** — see below | `redactSensitiveText` now redacts a labelled 40-hex SHA and a labelled npm/yarn integrity string (confirmed). A labelled UUID is redacted only ~75% of the time (6/8 random UUIDs sampled), because `bareShapeQualifies`'s own entropy floor (3.6 bits) runs BEFORE the label/allow-shape logic F-SEC-F2 fixed, and a UUID's Shannon entropy over its fixed 36-char hyphenated form straddles that floor. Pinned (for the part that is fixed) by `src/security/redact.test.ts` describe block `"F-SEC-F2 (flow 355 review, PR #776): a label overrides an allow-shape"`. The residual is filed as new finding **SEC-F2** below. |
| F-SEC-F3 | closed | `bun run`: `isDeniedForMcpChild` returns `true` for all 8 originally-evading names (`PRODDBPASS`, `STAGEDBPASS`, `MYPRIVATEKEY`, `USERREFRESHTOKEN`, `LEGACYACCESSTOKEN`, `V2APITOKEN`, `OAUTHACCESSTOKEN`, `SNOWFLAKEDBPASS`) and still `false` for `APITOKENIZER` (boundary preserved). Pinned by `src/mcp-servers/spawn-env.table.test.ts`, table class `"secret-shaped names, GLUED — no underscore boundary"` (rows for the 7 F-SEC-F3 names). |
| F-LOG-F1 | closed | `bun run`: `redactSensitiveText` no longer mangles `https://api.github.com/repos/foo/bar/commits/<sha40>`; `containsOutboundSecret` no longer refuses that URL or an ordinary secret-free webhook URL. Pinned by `src/security/detect/entropy.test.ts`: `"F-LOG-F1: a real commit-detail URL with a SHA in the path is NOT redacted"`, `"F-LOG-F1: a secret-free webhook URL is NOT redacted (no 'api' hostname false label)"`. `bun test src/lib/import-policy.live.test.ts` and the full entropy/redact/outbound-secret suite: 312 pass / 0 fail. |
| F-LOG-F2 | closed | `SHORT_GIT_SHA_RE` no longer exists in `src` (`keryx ctx rg "SHORT_GIT_SHA_RE" src` → 2 matches, both comments explaining the removal). `bun run` probe: a labelled 12-hex value still produces zero `detectEntropy` matches (dead code correctly removed, not repurposed). No dedicated regression test was added for the removal itself (see testing-practices note below); pinned instead by the absence of the symbol plus this round's re-execution. |
| F-REG-F2 | closed | `bun run`: `looksSecretShaped('123456789012345678901234')` (24 digits) → `false`; a 24-char value with one real hex letter → `true`. Pinned by `src/mcp-servers/http-headers.table.test.ts`: `"BOUNDARY — a 24-digit numeric order id stays visible"`, `"BOUNDARY — a 30-digit numeric id stays visible"`. |
| F-REG-F3 | closed | `bun run`: with `setEntropyBackendEnabledForTests(false)`, `redactSensitiveText` no longer masks a labelled 40-hex value and `containsOutboundSecret` no longer blocks a generic-param secret. Pinned by `src/security/redact.test.ts` describe `"F-REG-F3 (flow 355 review, PR #776): honours backends.entropy.enabled"` and `src/harness/web/outbound-secret.test.ts` describe `"F-REG-F3: containsOutboundSecret honours backends.entropy.enabled"`. |
| F-ARCH-F1 | closed | `keryx ctx rg` confirms `src/security/service.ts:97` now re-exports `EXTERNAL_ENV_DENY`/`EXTERNAL_ENV_PREFIX_SWEEPS` alongside `isDeniedForMcpChild`, and `src/harness/external/env-deny.ts:14` re-exports from `../../security/service` (the facade) rather than reaching into `credential-shape.ts` directly. `AVOIDABLE_BYPASS_CEILING` reverted to `150` in `src/lib/import-policy.live.test.ts:220`. Pinned by `"facade bypasses that COULD be fixed today are ratcheted, not allowed to grow"` (13 pass / 0 fail, `bun test src/lib/import-policy.live.test.ts`). |

## New findings — review round 2 (the delta `dc63b9bc..2a2db6b7`)

All four found and confirmed by execution against `~/keryx-ar2`, then
independently re-executed (verifier pass, see `keryx:verifications` in the
ingest input).

### SEC-F1 (blocker) — `isWordSlug` lets any real secret be smuggled past both S-6 and S-8 by re-segmenting it

`isWordSlug` exempts a hyphen/underscore-joined run from the entropy/hex-blob
gate as long as every segment is pure-alpha, pure-digit, or a single
letter-run/digit-run "tag" (the round-2 fix's own carve-out for package
version tags). This is a **content-free** exemption — it never inspects
whether the reassembled value is itself high-entropy — so a real secret,
re-segmented into single-character-class chunks joined by `-`, defeats
`looksSecretShaped`/`secretShapedCandidatesIn` (and therefore `redactSensitiveText`,
`containsOutboundSecret`, and `displayUrl`'s masking) completely, for **any**
secret, not just a contrived one:

```
real secret:  aK9dQ2rN7zVbT4pXeYfWmC1oLaHsJtU8        looksSecretShaped -> true
segmented:    aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8
              looksSecretShaped -> false
              containsOutboundSecret('https://exfil.example/' + segmented) -> false
              redactSensitiveText('leaked api_key: ' + segmented) -> unredacted, verbatim
```

A minimal, more "natural-looking" variant also works with real words instead
of single digits — `log-<32-char-letters-then-digits-secret>-id` — as long as
one segment is a 3+ letter word: `containsOutboundSecret` → `false`,
`detectEntropy` → `[]`, labelled `redactSensitiveText` → unredacted verbatim.

**Impact**: complete bypass of S-6 (redaction) and S-8 (outbound egress
check) for a re-segmented secret. This is the exact class AC2/AC4 exist to
close, and it requires no exotic input — a prompt-injected model instructed to
"format the leaked value as `x-<value>-y` before sending it" defeats both
controls with three characters of formatting.

**Suggested fix**: `isWordSlug`'s exemption must not apply to the
RECONSTITUTED value's own entropy — either compute entropy over the ORIGINAL
unsegmented value's own character run (ignore hyphens as separators only
after confirming the joined alnum content isn't itself high-entropy), or cap
the exemption to segments that are individually SHORT (a real version tag
segment is a handful of characters, not 8+), which would reject a secret that
had to be split into many short chunks to qualify while still allowing
`numpy-1.26.4-cp311-cp311-manylinux_2_17_x86_64.whl`.

**class_scope** — `isWordSlug`/`bareShapeQualifies` is the ONE shared shape
gate; every label-free and label-based caller inherits the bypass:
- `src/security/detect/entropy.ts:235` `isWordSlug` (root)
- `src/security/detect/entropy.ts:274` `bareShapeQualifies`
- `src/security/detect/entropy.ts:319` `looksSecretShaped` (export, S-9)
- `src/security/detect/entropy.ts:464` `secretShapedCandidatesIn` (export)
- `src/security/redact.ts:153` `redactSensitiveText` (S-6)
- `src/harness/web/outbound-secret.ts:108,122` `containsOutboundSecret` (S-8)
- `src/mcp-servers/http-headers.ts:351` `displayUrl` (S-9)
- `src/security/detect/index.ts:37` `runDetectors` (`keryx security scan`)
enumeration method: `keryx ctx rg "looksSecretShaped\(|looksSecretShapedIn\(|secretShapedCandidatesIn\(|detectEntropy\(" src --glob '!*.test.ts'` — 13 matches, 5 files, every non-test call site read directly.

### LOG-F1 (major) — the generic (non-URL) scan still compounds `/`- and `=`-bearing text, and the label window is proximity-only

`TOKEN`'s character class still includes `/` and `=`. F-LOG-F1's fix
decomposes an `http(s)://` URL before scanning it, but any OTHER text
containing `/` or `=` — a relative markdown link, a filesystem path, a
`name=value` code assignment, a `/`-joined list — is still swept as ONE
compound run by the generic per-line pass, and `SENSITIVE_LABEL`'s 40-char
lookback is a same-line PROXIMITY check, not a true adjacency check, so any
ordinary occurrence of "key"/"password"/"api"/"credential"/etc. earlier in
the same line/comment is enough to trigger it on unrelated text.

**Reproduced against this repository's own real files** (`redactSensitiveText`
run directly, no synthetic input):

- `git log -p -30 --stat` (6.06 MB, 30 commits): 10 `detectEntropy` matches.
  1 true positive (a deliberately fake `ghp_…` token in a test-fixture diff).
  4 are `Claude-Session: https://claude.ai/code/session_…` trailers — arguably
  correct to redact (a session URL is capability-like), not counted as a
  defect. **5 are false positives**, all the same root cause:
  - a relative markdown link target, `/docs/decisions/keryx-harness/ADR-0007-tls-terminate-https-credential-masking`,
    flagged because the link TEXT right before it says "…Credential Masking".
  - `200531777+MrCipherSmith` (an ordinary GitHub noreply-email local part —
    numeric user id + `+` + username), flagged twice because the word "key"
    appears earlier in the same comment ("no real network or key").
  - `from_attributes=True`, an ordinary Python/Pydantic assignment, flagged
    because "the API." appears earlier in the same sentence.
  - `passlib/bcrypt/argon2`, a comment listing three public hashing-library
    names, flagged because "password" appears earlier in the same comment
    ("a password-hashing helper (passlib/bcrypt/argon2)").
- `bun.lock` (57 KB, full file): 0 matches.
- `CHANGELOG.md` (404 KB, full file): 0 matches.
- `docs/**/*.md` (518 files, 6.1 MB): 1 match, filed separately as REG-F1
  below (a URL, not this class).

**Impact**: silent corruption of tool-output/transcript content the model
sees — the same impact class F-LOG-F1 was `blocker` for — in a codebase that
(like this one) discusses security/credentials/tokens routinely, which is
close to a worst case for this heuristic's false-positive surface. Directly
contradicts the CHANGELOG's "measured at zero across a 200-sample fixture"
claim once real repository content is swept rather than a curated fixture.

**Suggested fix**: apply the same decomposition principle F-LOG-F1 established
for URLs to `/`- and `=`-bearing runs generally (split on `/` before applying
the shape gate, the way `displayUrl`'s per-segment masking and the new
URL-component scan already do), and require the label to be genuinely
ADJACENT (as `ADJACENT_LABEL` already does for the allow-shape override) for
ANY match, not just for overriding an allow-shape — a same-line 40-char
window is far too permissive once real prose/comments are the input rather
than a config line.

**class_scope**: the generic per-line pass in `src/security/detect/entropy.ts` (`detectEntropy`, the loop starting around the `TOKEN.lastIndex = 0` for the non-URL, non-label-assignment pass) is the root; every `detectEntropy` caller inherits it: `src/security/redact.ts:153` (S-6), `src/harness/web/outbound-secret.ts:122` (S-8), `src/security/detect/index.ts:37` (`keryx security scan`/`report`/`gate`). enumeration method: same `keryx ctx rg` sweep as SEC-F1 above, filtered to `detectEntropy(` call sites.

### REG-F1 (major) — the word-slug exemption doesn't cover a multi-transition hex-suffix URL slug; an ordinary public blog/gist URL is refused

`isSingleTransitionTag` (added this round for package-manager version tags
like `cp311`) only forgives a segment that changes character class AT MOST
ONCE. A very common real convention — Medium's and GitHub Gist's
`<slug>-<12+ hex chars>` URL suffix — interleaves letters and digits many
times in that trailing id, so it fails `isWordSlug` entirely (one bad segment
poisons the whole check, by design), falls through to the entropy gate, and
qualifies as secret-shaped.

**Reproduced from a real link already in this repository**:
`docs/requirements/keryx-wiki-graph-next/README.md` links
`https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9`
— `containsOutboundSecret(url) === true`. A GitHub Gist URL
(`https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890`)
reproduces the same failure.

**Impact**: `web_fetch` refuses an entirely ordinary, public, non-credential
URL — directly contradicting AC4's "an ordinary URL … still fetches"
guarantee, for a URL shape common enough that it already appears once in this
repository's own docs tree.

**Suggested fix**: extend the single-transition carve-out to also accept a
segment that is a recognisable "slug + trailing hex id" shape (a leading
word/word-run followed by a separatorless 8+ hex-only tail), or — simpler —
apply the SAME per-word-with-trailing-hash exemption `isWordSlug` already
uses for its word-count logic, treating a segment as "structured" when it
decomposes into a leading alpha run and a trailing pure-hex run with no
further alternation.

**class_scope**:
- `src/security/detect/entropy.ts:231` `isSingleTransitionTag`, `:235` `isWordSlug` (root)
- `src/harness/web/outbound-secret.ts:108` `anyComponentLooksSecret` → `looksSecretShapedIn` (S-8)
- `src/security/detect/entropy.ts` URL-component pass in `detectEntropy` (redaction of an ordinary URL containing this slug shape in tool output)
enumeration method: same as SEC-F1's `keryx ctx rg` sweep; both call sites read directly and reproduced.

### SEC-F2 (major) — residual: a labelled UUID is redacted non-deterministically (~75%), not reliably, because the entropy floor gate runs before the fixed label/allow-shape logic

Continuation of round-1 F-SEC-F2, not a new mechanism. The round-1 fix makes
the labelled generic scan skip the allow-shape check entirely
(`bareShapeQualifies` carries no allow-shape logic) — correct, and it is why a
labelled 40-hex SHA and a labelled npm integrity string are now reliably
redacted. But `bareShapeQualifies` ALSO gates on `entropy >= 3.6 || isHexBlob`
BEFORE any label is even consulted, and a UUID (36 chars, 4 structural
hyphens, 32 hex digits) sits right at that floor: `isHexBlob` never matches
(hyphens aren't in `[0-9a-f]`), so a UUID's fate rests entirely on whether
its own hex digits happen to repeat enough to push Shannon entropy over 3.6.

**Measured**: 6 of 8 sampled UUIDs (2 canonical/common example UUIDs plus 6
random ones) were redacted when explicitly labelled `"leaked credential: "`;
2 were not — including the ubiquitous RFC 4122 example UUID
`550e8400-e29b-41d4-a716-446655440000` (entropy 3.39) and one random sample
(entropy 3.56). The existing regression test for this exact case,
`"a LABELLED UUID is redacted"` in `src/security/redact.test.ts:164`, happens
to use a UUID whose entropy is 4.06 — comfortably clear of the floor — so it
passes without exercising the boundary at all.

**Impact**: an operator relying on "a labelled leaked credential is redacted"
gets non-deterministic protection for any UUID-shaped credential (several
SaaS providers issue UUID-shaped API keys/session tokens) — roughly a
quarter of real instances, by this sample, leak into a transcript unredacted
despite being explicitly labelled.

**Suggested fix**: either lower the floor specifically for the LABELLED path
(a label is already a strong signal; the floor exists to avoid FALSE
positives on unlabelled text, which does not apply once something is
explicitly called out as leaked), or special-case `UUID_RE`-shaped values in
the labelled path the same way the allow-shape override already special-cases
them for the unlabelled path — test the boundary explicitly with a
representative sample of UUIDs, not one hand-picked value.

**class_scope**:
- `src/security/detect/entropy.ts:182` `HEX_BLOB`/`isHexBlob`, `:196-202` `UUID_RE`/`isAllowShapedValue`, `:274` `bareShapeQualifies` (entropy gate ordering)
- `src/security/redact.ts:153` `redactSensitiveText` (where the gap manifests, S-6)
enumeration method: `keryx ctx rg "isAllowShapedValue|UUID_RE|bareShapeQualifies" src/security/detect/entropy.ts`; single definition site, single call path into the labelled scan.

## Real-file sweep (review-regression requirement)

| corpus | size | `detectEntropy` matches | classification |
|---|---|---|---|
| `bun.lock` | 57,262 chars | 0 | — |
| `CHANGELOG.md` | 404,366 chars | 0 | — |
| `git log -p -30 --stat` | 6,058,824 chars | 10 | 1 true positive (test fixture), 4 arguably-intentional (session URLs), 5 false positives → filed as LOG-F1 above |
| `docs/**/*.md` (518 files) | 6,148,276 chars | 1 | false positive (ordinary URL) → filed as REG-F1 above |

## Testing-practices note

None of the four new findings has a regression test at the new head — expected,
since they were found by this round, not by the round the diff shipped. The
existing `"a LABELLED UUID is redacted"` test (SEC-F2 residual) is a cautionary
example of exactly the failure `spawn-env.table.test.ts`'s own header warns
about: a single hand-picked example verifies "does the reported reproduction
pass" rather than the CLASS, and this UUID happened to sit on the side of the
floor that passes. Recommend a `redact.table.test.ts` (or an addition to the
existing table-style tests) sampling several UUIDs/labelled-value shapes
rather than one each, mirroring the lesson `spawn-env.table.test.ts` already
encodes for the credential-shape module.

```json keryx:findings
[
  {
    "id": "SEC-F1",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "problem": "isWordSlug exempts a hyphen/underscore-segmented run from the entropy/hex-blob gate whenever every segment is pure-alpha, pure-digit, or a single-transition tag, with no check on the RECONSTITUTED value's own entropy. Re-segmenting any real secret into single-character-class chunks joined by '-' defeats looksSecretShaped/secretShapedCandidatesIn entirely.",
    "impact": "Complete bypass of S-6 (redactSensitiveText) and S-8 (containsOutboundSecret) for a re-segmented secret, and of S-9 (displayUrl masking). Reproduced: a real 32-char alphanumeric secret, re-segmented into letter-run/digit-run chunks ('aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8'), passes looksSecretShaped as false, containsOutboundSecret as false when placed in a URL path, and redactSensitiveText leaves it byte-for-byte unredacted even when explicitly labelled 'leaked api_key:'. A simpler variant using real dictionary words on either side of the secret ('log-<secret>-id') reproduces the same bypass.",
    "suggested_fix": "Do not let isWordSlug's exemption apply to the reconstituted (hyphen-stripped) value's own entropy; require the check to fail when the joined alnum content is itself high-entropy, or cap the exemption to segments short enough that a real version/platform tag would still qualify (a handful of characters) while a secret forced into many short single-class chunks would not.",
    "evidence": "bun run against ~/keryx-ar2 HEAD 2a2db6b7: looksSecretShaped('aK9dQ2rN7zVbT4pXeYfWmC1oLaHsJtU8') -> true; looksSecretShaped('aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8') -> false; containsOutboundSecret('https://exfil.example/aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8') -> false; redactSensitiveText('leaked api_key: aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8') -> unchanged. Minimal-wrap variant: containsOutboundSecret('https://x.example/log-abcdefghijklmnopqrstuvwxyzAB1234-id') -> false; detectEntropy of the same URL -> [].",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 235,
    "quote": "function isWordSlug(value: string): boolean {\n  const segments = value.split(/[-_]/);\n  if (segments.length < 3) {\n    return false;\n  }",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:235 isWordSlug",
        "src/security/detect/entropy.ts:274 bareShapeQualifies",
        "src/security/detect/entropy.ts:319 looksSecretShaped",
        "src/security/detect/entropy.ts:464 secretShapedCandidatesIn",
        "src/security/redact.ts:153 redactSensitiveText (S-6)",
        "src/harness/web/outbound-secret.ts:108,122 containsOutboundSecret (S-8)",
        "src/mcp-servers/http-headers.ts:351 displayUrl (S-9)",
        "src/security/detect/index.ts:37 runDetectors (keryx security scan/report/gate)"
      ],
      "enumeration_method": "keryx ctx rg \"looksSecretShaped\\(|looksSecretShapedIn\\(|secretShapedCandidatesIn\\(|detectEntropy\\(\" src --glob '!*.test.ts' -> 13 matches, 5 files; every non-test call site read directly."
    }
  },
  {
    "id": "LOG-F1",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "The generic (non-URL) per-line scan's TOKEN character class still includes '/' and '=', so a relative path, a code assignment, or a '/'-joined list is swept as one compound run; SENSITIVE_LABEL's 40-char lookback is same-line PROXIMITY, not true adjacency, so any ordinary occurrence of a label word earlier in the line/comment triggers a match on unrelated text.",
    "impact": "Silent corruption of tool-output/transcript content, the same impact class F-LOG-F1 was blocker for. Real-file sweep of this repository: git log -p -30 --stat (30 commits) produced 5 false positives (a relative markdown link path near the words 'Credential Masking'; a GitHub noreply-email local part near the word 'key'; a Python 'from_attributes=True' assignment near the word 'API'; a 'passlib/bcrypt/argon2' library-name comment near the word 'password'), against 0 in bun.lock and 0 in CHANGELOG.md.",
    "suggested_fix": "Decompose '/'-bearing runs the same way URLs are now decomposed (split on '/' before the shape gate); require the label to be genuinely ADJACENT (as ADJACENT_LABEL already does for the allow-shape override) for any match to fire, not only to override an allow-shape.",
    "evidence": "bun run against ~/keryx-ar2 HEAD 2a2db6b7, detectEntropy() over `git -C ~/keryx log -p -30 --stat` (6,058,824 chars): 10 matches, 5 classified false positive (ADR relative link, noreply-email local part x2, from_attributes=True, passlib/bcrypt/argon2); over docs/**/*.md (518 files, 6,148,276 chars): 1 match (filed separately as REG-F1); over bun.lock (57,262 chars) and CHANGELOG.md (404,366 chars) full-file: 0 matches each.",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 173,
    "quote": "const TOKEN = /[A-Za-z0-9+/=_-]{20,}(?:\\.[A-Za-z0-9+/=_-]{6,})*/g;",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts detectEntropy generic per-line pass (root)",
        "src/security/redact.ts:153 redactSensitiveText (S-6)",
        "src/harness/web/outbound-secret.ts:122 containsOutboundSecret (S-8)",
        "src/security/detect/index.ts:37 runDetectors (keryx security scan/report/gate)"
      ],
      "enumeration_method": "keryx ctx rg \"detectEntropy\\(\" src --glob '!*.test.ts' -> every non-test call site read directly."
    }
  },
  {
    "id": "REG-F1",
    "reviewer": "review-regression",
    "severity": "major",
    "problem": "isSingleTransitionTag only forgives a segment that changes character class at most once. Medium's and GitHub Gist's common '<slug>-<hex id>' URL convention interleaves letters and digits many times in the trailing id, which fails isWordSlug entirely (one bad segment poisons the whole slug check) and falls through to the entropy gate, qualifying as secret-shaped.",
    "impact": "web_fetch refuses an entirely ordinary, public, non-credential URL, contradicting AC4's guarantee. Reproduced against a URL already present in this repository's own docs: docs/requirements/keryx-wiki-graph-next/README.md links a Medium article whose trailing hex id triggers the refusal; a GitHub Gist URL reproduces the same failure.",
    "suggested_fix": "Extend the single-transition carve-out (or add a sibling rule) to accept a segment shaped as a leading alpha run followed by a trailing pure-hex run with no further alternation ('slug + trailing hex id'), the same class of 'structured, not random' evidence the existing pip/npm version-tag carve-out already grants.",
    "evidence": "bun run against ~/keryx-ar2 HEAD 2a2db6b7: containsOutboundSecret('https://medium.com/real-time-data-evolution/rag-architecture-in-2026-how-to-keep-retrieval-actually-fresh-3a9bae9ec8f9') -> true (refused); containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890') -> true (refused). detectEntropy over docs/requirements/keryx-wiki-graph-next/README.md's own current content reproduces the same match on the live file.",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 231,
    "quote": "function isSingleTransitionTag(segment: string): boolean {\n  return /^[A-Za-z]+[0-9]+$/.test(segment) || /^[0-9]+[A-Za-z]+$/.test(segment);\n}",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:231 isSingleTransitionTag",
        "src/security/detect/entropy.ts:235 isWordSlug",
        "src/harness/web/outbound-secret.ts:108 anyComponentLooksSecret (S-8)",
        "src/security/detect/entropy.ts detectEntropy URL-component pass (S-6/redaction of tool output containing this URL shape)"
      ],
      "enumeration_method": "keryx ctx rg \"looksSecretShapedIn\\(|secretShapedCandidatesIn\\(\" src --glob '!*.test.ts'; both call sites read directly and reproduced against the live docs file."
    }
  },
  {
    "id": "SEC-F2",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "Continuation of round-1 F-SEC-F2. The fixed label-overrides-allow-shape logic is correct, but bareShapeQualifies's own entropy floor (3.6 bits, no hex-blob match possible for a hyphenated UUID) runs BEFORE the label is ever consulted, so whether a labelled UUID is redacted depends entirely on that UUID's own digit repetition, independent of the label.",
    "impact": "Non-deterministic protection for UUID-shaped credentials even when explicitly labelled as leaked. Sample: 6 of 8 UUIDs redacted when labelled 'leaked credential:'; 2 were not, including the canonical RFC 4122 example UUID (550e8400-e29b-41d4-a716-446655440000, entropy 3.39) that appears throughout real documentation and example code. The existing regression test for this exact case uses a UUID (entropy 4.06) that happens to clear the floor, so it passes without exercising the boundary.",
    "suggested_fix": "Lower (or bypass) the entropy floor specifically on the labelled path — a label is already a strong independent signal, and the floor's purpose is to avoid false positives on UNLABELLED text — or special-case UUID_RE-shaped values in the labelled scan the same way the allow-shape override already does for the unlabelled path. Test with a representative sample of UUIDs, not one fixed value.",
    "evidence": "bun run against ~/keryx-ar2 HEAD 2a2db6b7: shannonEntropy('550e8400-e29b-41d4-a716-446655440000') = 3.39 (< 3.6 floor); redactSensitiveText('leaked credential: ' + that UUID) leaves it unchanged. 8-UUID sample (2 canonical + 6 crypto.randomUUID()): 6/8 redacted when labelled, 2/8 not (entropies 3.39 and 3.56). src/security/redact.test.ts:164-168 'a LABELLED UUID is redacted' passes only because its fixed example UUID has entropy 4.06.",
    "confidence": "high",
    "file": "src/security/detect/entropy.ts",
    "line": 274,
    "quote": "function bareShapeQualifies(head: string): { qualifies: boolean; entropy: number } {",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:182 HEX_BLOB/isHexBlob",
        "src/security/detect/entropy.ts:196-202 UUID_RE/isAllowShapedValue",
        "src/security/detect/entropy.ts:274 bareShapeQualifies (entropy-gate ordering)",
        "src/security/redact.ts:153 redactSensitiveText (where the gap manifests, S-6)"
      ],
      "enumeration_method": "keryx ctx rg \"isAllowShapedValue|UUID_RE|bareShapeQualifies\" src/security/detect/entropy.ts; single definition site, single call path into the labelled scan."
    }
  }
]
```
