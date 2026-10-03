# Review round 4 — flow 355, PR #781 (fix round over round-3's findings)

Ref: `ed1c3ba6cb224bac4bed982a56b5da73585913d5..22478bc0a9970324373cbe38fb5fd7e34568f64c`
(main's tip immediately before this PR branched, to PR #781's own head). PR #781
was merged to `main` at 2026-09-28T12:01:27Z, tree-identical to `22478bc0` — this
merge happened during this review round, not as a result of it. Every finding
below is a claim about the code at `22478bc0`, examined directly in a read-only
detached worktree (`~/keryx-r4`) at that exact commit.

Branch: `fix/audit-remediation-2c`.

## Prior findings — disposition

### Round 3 (package `2026-09-28-pr-779-round3-9b0b3f58`)

All six re-verified BY EXECUTION at this head, using each finding's own
reproduction inputs plus the pinning tests this PR added.

| id | disposition | evidence |
|---|---|---|
| SEC-F3 | **acted-on** | `redactSensitiveText('leaked api_key: log-report-deadbeef01234567')` → `"leaked api_key: [REDACTED:entropy]"` (was unchanged — blocker claim was the LABELLED-path bypass, now closed). The same value UNLABELLED still passes shape/egress checks, but that is now an explicitly documented, deliberately-scoped, and test-pinned accepted residual (`findings.md` S-8/S-6: "Accepted residual, UNLABELLED path only"), not part of the blocker's own claim. Pinned by `entropy.test.ts` describe "SEC-F3 (flow 355 review round 3): the LABELLED path consults no slug exemption at all" (3 tests), `redact.test.ts` describe "SEC-F3 (flow 355 review round 3): no slug exemption survives adjacency to a real label" (2 tests), `outbound-secret.test.ts` describe "SEC-F3 (flow 355 review round 3), outbound path: accepted residual" (1 test) — all 6 pass at `22478bc0` (`bun test src/security/detect/entropy.test.ts -t SEC-F3` → 4 pass; `bun test src/security/redact.test.ts -t SEC-F3` → 2 pass). |
| LOG-F2 | **acted-on** | Two of the finding's three repro cases fixed and pinned: `detectEntropy('password is: kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz')` → 1 match (was `[]`); `detectEntropy('export API_KEY=\\\n' + secret)` → 1 match (was `[]`). The third case (`'password is:\n' + secret` — a label ending its own line with **no** explicit continuation marker) is still `[]`, but this is now a deliberate, documented, and test-pinned scope boundary (`entropy.ts` header + `entropy.test.ts` test "does NOT regress: a label on the PREVIOUS line with no continuation marker stays a residual (not adjacent)"), not a silent gap — reopening it was explicitly rejected to avoid regrowing LOG-F1's own false-positive class. Pinned by `entropy.test.ts` describe "LOG-F2 (flow 355 review round 3): ADJACENT_LABEL tolerates a filler word and an explicit line continuation" (6 tests, all pass at `22478bc0`: `bun test src/security/detect/entropy.test.ts -t LOG-F2` → 6 pass). See also round-4 finding **LOG-F3** below: the filler-word tolerance this fix added opens a narrow new over-redaction class. |
| REG-F2 | **acted-on** | `containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890')` → `false` (was `true`); `containsOutboundSecret('https://gist.github.com/a1b2c3d4e5f67890abcdef1234567890')` (no user segment) → `false`. Both confirmed by direct execution at `22478bc0`. Pinned by `outbound-secret.test.ts` describe "REG-F2 (flow 355 review round 3): a known public paste/commit identifier fetches" (7 tests, all pass: `bun test src/harness/web/outbound-secret.test.ts -t REG-F2` → 7 pass). See round-4 finding **SEC-F4** below: the allowlist this fix added is shape-only and can itself be abused. |
| DOC-F1 | **acted-on** | `entropy.ts:168-176`'s header comment now reads "`token=…` IS caught, and correctly so: all 32 characters are DISTINCT…", matching `entropy.test.ts`'s own R3 test framing. Confirmed by direct read (site-check) at `22478bc0`. |
| DOC-F2 | **acted-on** | `CHANGELOG.md`'s new `[0.3.21]` entry adds a "Also shipped in 0.3.19–0.3.20: `LABEL=VALUE` assignment shapes… and camelCase labels… are now recognised and redacted" line, backfilling the gap DOC-F2 reported. Confirmed by direct read (site-check) at `22478bc0`. |
| TEST-F1 | **acted-on** | `redact.test.ts`'s `F-SEC-F2` UUID coverage now uses 20 fixed, committed UUIDs instead of unseeded `crypto.randomUUID()` (confirmed: `randomUUID` appears only in a comment, no live call). `bun test src/security/redact.test.ts -t "F-SEC-F2"` run 5 times at `22478bc0`: **5/5 pass, 0 failures** (round 3 reproduced 1 failure in 4 runs on the old unseeded version). |

### Round 2, residual (package `2026-09-28-pr-776-round2-2a2db6b7`)

| id | disposition | evidence |
|---|---|---|
| REG-F1 | **acted-on** | Left `unknown` in round 2 pending the Gist residual. That residual is REG-F2 above, now fixed: the exact Gist URL from REG-F1's own reproduction (`containsOutboundSecret` on `https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890`) now returns `false`, confirmed by direct execution at `22478bc0`. Both halves of REG-F1's original claim (Medium URL shape, fixed in round 3; Gist URL shape, fixed in round 3's own follow-up commit covered by REG-F2's tests) now pass. |

## New findings — review round 4 (the delta between `9b0b3f58`/round-3-head and `22478bc0`)

### SEC-F4 (major) — the new outbound public-id allowlist is shape-only: a real secret at the Gist-id position bypasses S-8

`outbound-secret.ts`'s `knownPublicIdentifierIn`/`stripKnownPublicIdentifier`
(added this round to fix REG-F2) exempt a URL path segment from
`containsOutboundSecret`'s scan whenever it matches `gist.github.com`
`/<user>/<32-hex>` or `/<32-hex>` — **by shape and exact hostname only**, with
no check that the matched segment corresponds to a real, existing gist. A
**real secret** that happens to be formatted as exactly 32 lowercase-hex
characters (e.g. an MD5-derived token) placed at that exact identifier
position on `gist.github.com` is stripped from the scan text **before** any
shape/entropy check runs, so `containsOutboundSecret` returns `false` and
`web_fetch`/`web_search`'s S-8 gate does not refuse the request — defeating
the exact control S-8 exists to provide, for this specific value shape:

```
containsOutboundSecret('https://gist.github.com/<32-hex>')            -> false  (NOT refused)
containsOutboundSecret('https://gist.github.com/someuser/<32-hex>')   -> false  (NOT refused)
// Control, same 32-hex value, unrelated host, same path position:
containsOutboundSecret('https://example.com/<32-hex>')                -> true   (refused — proves gist.github.com's allowlist, not a general 32-hex exemption, causes the miss)
```

**Correction versus this finding's own first draft, made by an independent
re-check (a separate verifier agent, then confirmed by re-running with a
byte-counted fixture):** the `github.com` `/…/commit\|blob/<40-hex>…` and
`gitlab.com` `/…/-/commit/<40-hex>` legs of the SAME allowlist do **not**
introduce new exposure. A bare (unlabelled) 40-hex-character value is
**already** exempted from `containsOutboundSecret` on *any* host, at *any*
path position — confirmed with `https://example.com/<40-hex>` → `false`,
`https://example.com/x?x=<40-hex>` (unlabelled query) → `false` — via
`isAllowShapedValue`'s pre-existing `FULL_GIT_SHA_RE`, which predates this PR
and is unrelated to `knownPublicIdentifierIn`. A first pass mistakenly cited
`github.com/commit/<40-hex>` and `gitlab.com/-/commit/<40-hex>` as bypasses
this round introduced; they are not — they were already exempt before this
diff, so they are **out of this round's blast radius** (no link to the
change). One secondary, non-blocking observation this correction surfaces:
the `github.com`/`gitlab.com` legs of the new allowlist appear to be inert —
they exempt a shape (bare 40-hex) that was already unconditionally exempt —
worth a follow-up look, but not filed as its own finding here since it
changes no observable behaviour.

Bounded correctly in two ways this review confirmed by execution: (1) a
lookalike host (`gist.github.com.evil.example`, `evil-gist.github.com`, a
userinfo trick `gist.github.com@evil.com`, `evil.gist.github.com`) is still
refused normally — the host check is an exact match, not substring/suffix;
(2) a secret **elsewhere** in the same allowlisted URL (e.g. a query
parameter) is still caught — only the matched identifier substring is
exempted. So this is not an open exfiltration primitive to an
attacker-controlled destination; it is a defeat of S-8 confined to one real
host (`gist.github.com`). Rated `major` rather than `blocker` for that
reason — the destination is not attacker-chosen — but it is a real,
demonstrated, unauthorized-third-party data egress via the exact check meant
to prevent it, on a plausible real-world credential shape (32 hex
characters, e.g. an MD5-derived token).

Not covered by any existing test: `outbound-secret.test.ts`'s REG-F2 describe
block tests "a secret elsewhere in an allowlisted URL is still caught" but
never tests "the identifier-shaped segment IS itself the secret."

**class_scope**: `HEX32_FRAGMENT`/`GIST_HEX32_PATH_RE`
(`src/harness/web/outbound-secret.ts:76,79`) → `knownPublicIdentifierIn`
(:91, the `gist.github.com` branch) → `stripKnownPublicIdentifier` (:112) →
`containsOutboundSecret` (:180, S-8, the real-world failure site — the only
caller of `stripKnownPublicIdentifier`). The `github.com`/`gitlab.com`
branches of the same function (:91, `SHA40_FRAGMENT`/
`GITHUB_COMMIT_OR_BLOB_PATH_RE`/`GITLAB_COMMIT_PATH_RE`, :77,80-81) are
excluded from this finding's claim per the correction above. Confirmed by
`keryx ctx rg` that neither function is reachable from `entropy.ts`'s
redaction path (S-6/S-9), so tool-output redaction is unaffected — this is
confined to the outbound-egress gate.

### LOG-F3 (minor) — the new filler-word tolerance opens a narrow, bounded over-redaction class

`entropy.ts:292-293`'s `FILLER_WORDS` (`is|was|set|to|the|value|now`, ≤2
words) lets `ADJACENT_LABEL` match a sensitive label followed by up to two
filler words and **no connector at all**. This makes `detectEntropy` (and
`redactSensitiveText`) flag an ordinary hex-blob-shaped, non-secret value
(e.g. a git commit SHA merely mentioned in prose) when it follows phrasing
like "the release key is now `<hex>`" or "the auth token is now `<hex>`" —
phrasing that did **not** match under round 2's strict same-line,
immediate-connector adjacency:

```
detectEntropy('the release key is now 3f5e8a9b2c7d1e4f6a8b9c0d1e2f3a4b5c6d7e8f')
  -> 1 match (redacted)   — the value is a plain 40-hex string, not a real secret
```

This is over-redaction (the safe failure direction), not a security bypass,
so it is `minor` rather than `major`: no secret is exposed, some non-secret
prose near a sensitive-sounding word is now masked. It is genuinely bounded —
confirmed by execution that 3+ filler words ("the auth token is now set to
`<hex>`") does **not** match, matching the existing pinned test "an arbitrary
sentence between a label and an unrelated value is still NOT adjacent" — and
the real-file sweep below found **zero** instances of this exact phrasing in
this repository's own corpus (bun.lock, CHANGELOG.md, the last 30 commits'
diffs, all 519 `docs/**/*.md` files), so it is a real but currently dormant
class rather than one observed causing damage. No existing test in
`entropy.test.ts`'s `LOG-F2` describe block covers the "label + ≤2 filler
words + no connector + hex-blob value" shape specifically.

**class_scope**: `FILLER_WORDS`/`ADJACENT_LABEL` (`src/security/detect/entropy.ts:292-293`)
→ `isAdjacentLabel` (the per-line scan's only gate) → `detectEntropy`'s
generic per-line pass → `redactSensitiveText` (S-6), `containsOutboundSecret`
(S-8, same shared `detectEntropy` call).

## Real-file sweep (review-regression requirement, re-run at this head)

| corpus | size | `detectEntropy` matches | classification |
|---|---|---|---|
| `bun.lock` | 57,262 chars | 0 | — |
| `CHANGELOG.md` | 419,606 chars | 1 | The DOC-F1 example string (`token=abcdefghijklmnopqrstuvwx12345678`) quoted in the CHANGELOG's own prose describing the DOC-F1 fix — a self-referential doc-comment string, correctly caught by design (same class round 3 already classified as not a defect). 0 false positives. |
| `git log -p -30 --stat` | 6,413,269 chars | 63 | Every hit traced individually. All are: (a) the DOC-F1 example string, repeated across several commits' diffs; (b) test-fixture "secrets" reused across many test files (`K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI`, `log-report-deadbeef01234567`, `kd8Fj2LmQp9xZr4TvWn7Yb3…`, `aK-9-dQ-2-rN-…`, a fake Slack-bot token, a fake `ghp_…` GitHub-PAT-shaped fixture, a fixture presigned-URL signature, this round's own REG-F2/SEC-F3 fixture URLs); (c) well-known documented placeholders (AWS's own `AKIAIOSFODNN7EXAMPLE`, a Google Drive capability-id, a `Claude-Session:` commit-trailer URL — the same "arguably correct to redact, capability-like" class round 2/3 already classified as not a defect); (d) the `flow-153-wiki-update-1` CLI example (same hit round 3 found, same classification: accepted consequence of SEC-F3's fix, not a defect). **0 false positives, 0 unaccounted-for hits, 0 real secrets.** Count differs from round 3's 41 because the `-30` commit window now includes this PR's own fix commits (whose diffs re-introduce several of round 3's own fixture strings into the window). |
| `docs/**/*.md` (519 files) | — | 3 | `findings.md` (2: the DOC-F1 example string in its own S-6 narrative, and the `flow-153-wiki-update-1` example) and `docs/verification/wiki-graph-sac-proof.md` (1: the same `flow-153-wiki-update-1` example) — identical to round 3's own classification of this exact hit. **0 new/unclassified hits.** |

The sweep confirms REG-F1/REG-F2's fix introduces no collateral false
positives in this repository's real files, and that LOG-F3's theoretical
over-redaction class (above) does not happen to occur in this corpus today.

## How this review was run

- **Run by:** MrCipherSmith with a manual round-4 pass (execution-based
  re-verification + delta review), following `review-orchestrator`/
  `review-verifier` conventions from `.metaproject/skills/gdskills/review/`.
- **Scope:** `ed1c3ba6cb224bac4bed982a56b5da73585913d5..22478bc0a9970324373cbe38fb5fd7e34568f64c`, round 4, PR #781 (merged mid-round to `main`, tree-identical).
- **Verification:** `filter`; new findings SEC-F4/LOG-F3 independently verified by a separate agent (never the raiser) via execution in the read-only worktree at `22478bc0`; round-3/round-2 findings re-verified by execution directly against each finding's own reproduction inputs.
- **Not run:** full domain-reviewer fan-out (`review-frontend`, `review-backend`, etc.) — out of scope; this diff touches only `security/`, `harness/web/`, tests, `CHANGELOG.md`, and `findings.md`.

```json keryx:findings
[
  {
    "id": "SEC-F4",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "The new outbound public-id allowlist (knownPublicIdentifierIn/stripKnownPublicIdentifier in harness/web/outbound-secret.ts, added this round to fix REG-F2) is shape-only: its gist.github.com branch exempts a URL path segment matching /<user>/<32-hex> or /<32-hex> from containsOutboundSecret's scan by exact hostname + shape only, with no check that the segment corresponds to a real gist. A real secret formatted as exactly 32 lowercase-hex characters, placed at that identifier position on gist.github.com, is stripped from the scan text before any shape/entropy check runs, so containsOutboundSecret returns false and web_fetch/web_search's S-8 gate does not refuse the request. CORRECTION to this finding's first draft (caught by independent re-verification): the github.com/commit|blob and gitlab.com/-/commit (40-hex) branches of the SAME allowlist do NOT add new exposure -- a bare 40-hex value is already unconditionally exempt on any host via the pre-existing FULL_GIT_SHA_RE allow-shape, unrelated to this diff, so only the 32-hex gist.github.com case is a bypass this round actually introduced.",
    "impact": "Defeats S-8 (the outbound secret-shaped-content refusal) for a real credential shaped as exactly 32 lowercase-hex characters, placed at the gist-id position on gist.github.com. Reproduced with a byte-counted 32-hex fixture: containsOutboundSecret('https://gist.github.com/<32-hex>') -> false; containsOutboundSecret('https://gist.github.com/someuser/<32-hex>') -> false; control containsOutboundSecret('https://example.com/<32-hex>') (same value, unrelated host, same path shape) -> true, proving the gist.github.com allowlist (not a general 32-hex exemption) causes the miss. Bounded: a lookalike host (gist.github.com.evil.example, evil-gist.github.com, evil.gist.github.com, a userinfo trick gist.github.com@evil.com) is still refused normally (exact hostname match, not substring/suffix); a secret elsewhere in the same allowlisted URL (a query parameter) is still caught. Not an attacker-controlled-destination exfiltration primitive, but a real, demonstrated defeat of a security control on one real host, for a plausible real-world credential shape (32 hex characters, e.g. an MD5-derived token). Not covered by any existing test: the REG-F2 test suite tests 'a secret elsewhere in the URL is still caught' but never 'the identifier-shaped segment IS itself the secret.' The github.com/gitlab.com 40-hex branches of this same allowlist were verified NOT to change behaviour (pre-existing FULL_GIT_SHA_RE already exempted bare 40-hex values everywhere) and are excluded from this finding's claim -- worth a follow-up look as possibly-inert code, but not itself a new defect.",
    "suggested_fix": "Require the matched identifier to be validated against something beyond shape before exempting it -- e.g. only apply the allowlist when the request is a plain GET with no other secret-shaped content anywhere in the URL AND log/flag exempted fetches for audit, or narrow the allowlist further (e.g. require the surrounding path shape to exactly match a real gist URL pattern), or drop the identifier-only exemption and instead exempt the well-known FULL URL templates via a stricter regex anchored on the entire pathname rather than a substring, closing off placement of attacker-controlled/secret content anywhere in the matched group.",
    "evidence": "bun run against ~/keryx-r4 (PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c, merged to main tree-identical), using a length-verified (JS .length checked) 32-character hex fixture: containsOutboundSecret returns false for both gist.github.com/<32-hex> forms; true for the same value on an unrelated host at the same path position; true for the same value at a query-param position on gist.github.com itself; true for all lookalike-host variants tested. A separate verifier agent independently reproduced this and additionally caught that my first-draft 40-hex fixture strings were miscounted (39 chars, not 40) and that a CORRECTLY 40-char value is exempted on ANY host (e.g. https://example.com/<real-40-hex>) via the pre-existing FULL_GIT_SHA_RE allow-shape in entropy.ts (S-6/AC2) -- re-confirmed directly with a byte-counted fixture. Root cause of the real bypass: knownPublicIdentifierIn (outbound-secret.ts:91) matches gist.github.com purely on URL.hostname + GIST_HEX32_PATH_RE (:79, shape-only), and stripKnownPublicIdentifier (:112) zeroes out the matched substring before containsOutboundSecret (:180) runs any shape/entropy check on it.",
    "confidence": "high",
    "file": "src/harness/web/outbound-secret.ts",
    "line": 91,
    "quote": "function knownPublicIdentifierIn(url: URL): string | null {\n  const host = url.hostname.toLowerCase();\n  if (host === \"gist.github.com\") {\n    return GIST_HEX32_PATH_RE.exec(url.pathname)?.[1] ?? null;\n  }",
    "class_scope": {
      "sites": [
        "src/harness/web/outbound-secret.ts:76,79 HEX32_FRAGMENT/GIST_HEX32_PATH_RE",
        "src/harness/web/outbound-secret.ts:91 knownPublicIdentifierIn (gist.github.com branch)",
        "src/harness/web/outbound-secret.ts:112 stripKnownPublicIdentifier",
        "src/harness/web/outbound-secret.ts:180 containsOutboundSecret (S-8, real-world failure site, only caller of stripKnownPublicIdentifier)"
      ],
      "enumeration_method": "keryx ctx rg -- \"knownPublicIdentifierIn|stripKnownPublicIdentifier|isKnownPublicIdentifierUrl\" src -> definitions and all call sites confined to outbound-secret.ts (S-8 path only); a comment mention in entropy.ts confirms the redaction path (S-6/S-9) is not reachable from this allowlist. The github.com/gitlab.com branches (:77,80-81, SHA40_FRAGMENT/GITHUB_COMMIT_OR_BLOB_PATH_RE/GITLAB_COMMIT_PATH_RE) are excluded from this finding's sites per the correction above -- re-verified they change no observable behaviour versus the pre-existing FULL_GIT_SHA_RE exemption."
    }
  },
  {
    "id": "LOG-F3",
    "reviewer": "review-security-code",
    "severity": "minor",
    "problem": "entropy.ts's new FILLER_WORDS (is|was|set|to|the|value|now, up to 2 words) lets ADJACENT_LABEL match a sensitive label followed by up to two filler words and no connector at all, before a candidate value. This makes detectEntropy (and redactSensitiveText) flag an ordinary hex-blob-shaped, non-secret value that follows phrasing like 'the release key is now <hex>' or 'the auth token is now <hex>' -- phrasing that did not match under round 2's strict same-line, immediate-connector adjacency.",
    "impact": "Over-redaction (safe failure direction, not a security bypass): a git-SHA-shaped or otherwise hex-blob-shaped value mentioned in ordinary technical prose near a sensitive label word, using this specific 'LABEL <=2 filler words, no connector> VALUE' phrasing, now gets masked as [REDACTED:entropy] even though it is not a secret. Reproduced: detectEntropy('the release key is now 3f5e8a9b2c7d1e4f6a8b9c0d1e2f3a4b5c6d7e8f') -> 1 match. Bounded: 3+ filler words does not match (detectEntropy('the auth token is now set to <hex>') -> []), matching the existing pinned regression test for the same boundary. The real-file sweep of this repository's own corpus (bun.lock, CHANGELOG.md, git log -p -30 --stat, all 519 docs/**/*.md files) found zero instances of this exact phrasing today -- a real but currently dormant class.",
    "suggested_fix": "Either require an explicit connector (':'/'=') whenever a filler word is present (tightening back to 'filler words only extend the label word itself, never substitute for the connector'), or require the candidate value to fail the allow-shape/full-git-SHA carve-out before the filler-tolerant path can fire, so a value that looks exactly like an ordinary commit SHA is not swept up by casual prose. At minimum, add a regression test for the 'LABEL <=2 filler words, no connector> <hex-blob, non-secret>' shape so a future change to FILLER_WORDS has a pin to break.",
    "evidence": "bun run against ~/keryx-r4 (PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c): detectEntropy('the release key is now 3f5e8a9b2c7d1e4f6a8b9c0d1e2f3a4b5c6d7e8f') -> 1 match (value masked); detectEntropy('the auth token is now set to 3f5e8a9b2c7d1e4f6a8b9c0d1e2f3a4b5c6d7e8f') -> [] (3-filler-word control, confirms the closed-set/2-word bound holds); entropy.test.ts's LOG-F2 describe block has no test for the 2-filler-word-no-connector-hex-blob shape specifically (only the colon-delimited 'password is:' case is pinned).",
    "confidence": "medium",
    "file": "src/security/detect/entropy.ts",
    "line": 292,
    "quote": "const FILLER_WORDS = \"is|was|set|to|the|value|now\";\nconst ADJACENT_LABEL = new RegExp(\n  `(?:^|[^A-Za-z0-9])(?:${caseless(SENSITIVE_LABEL_WORDS)})[A-Za-z0-9_-]*` +\n    `(?:\\\\s+(?:${caseless(FILLER_WORDS)})){0,2}` +\n    `[\"']?\\\\s*[:=]?\\\\s*[\"']?$`,\n);",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts:292 FILLER_WORDS",
        "src/security/detect/entropy.ts:293 ADJACENT_LABEL",
        "src/security/detect/entropy.ts isAdjacentLabel (only caller of ADJACENT_LABEL)",
        "src/security/redact.ts redactSensitiveText (S-6)",
        "src/harness/web/outbound-secret.ts containsOutboundSecret (S-8, shares the same detectEntropy call)"
      ],
      "enumeration_method": "keryx ctx rg -- \"FILLER_WORDS|ADJACENT_LABEL\" src -> single definition site (entropy.ts), single caller (isAdjacentLabel); downstream callers re-confirmed against LOG-F2's own round-3 class_scope."
    }
  }
]
```
