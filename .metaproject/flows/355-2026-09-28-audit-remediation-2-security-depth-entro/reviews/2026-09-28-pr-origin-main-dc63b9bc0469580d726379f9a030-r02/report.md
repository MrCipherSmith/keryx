**Changes requested — 2 Blocker, 5 Major, 1 Minor.** Reviewed `dc63b9bc0469580d726379f9a03040bc7a71f6da` against `origin/main` (round 1, PR #776, flow 355). All 8 findings were independently executed and CONFIRMED by `review-verifier`; none refuted. The corpus/test-suite claims in the PR body (AC1, AC3, AC5, AC6, AC7, AC8 process) hold up under direct verification. AC2 and AC4 do not: the entropy detector shipped in this same diff has a root-cause defect (TOKEN regex spans `/`) that both mangles ordinary tool output and hard-refuses ordinary `web_fetch`/`web_search` calls to any `api.*`-hosted URL, and the new outbound-secret check is trivially bypassed by an attacker who avoids the closed label list.

### Blocker

**F-SEC-F1. `containsOutboundSecret` (S-8) is trivially bypassed — a real secret under a generic query-param name, split across params, or with a percent-encoded label sails through and the fetch proceeds.** `src/harness/web/outbound-secret.ts:14-16`, in the diff.
Confirmed by execution (reviewer + independent verifier): `containsOutboundSecret` returned `false` for a 43-char secret under `?d=`, split across `?a=`/`?b=`, a bare 40-hex secret under a generic param, and a percent-encoded `t%6fken=` label. `web-fetch-tool.ts:53` falls through to the real network call whenever this returns `false`.
Fix: drop the label-list requirement for URL/query egress checks; check each path segment and each query value independently via `looksSecretShaped`, and decode query keys before matching the label list.

**F-LOG-F1. The entropy TOKEN regex includes `/`, so on a URL it compounds host+path into one candidate — this both corrupts ordinary tool output and false-refuses ordinary `web_fetch`/`web_search` calls to any `api.*`-hosted URL.** `src/security/detect/entropy.ts` (TOKEN regex), in the diff. Independently found and reproduced from the refusal side by `review-regression` (against the live `webFetchTool`, `api.github.com`/`api.stripe.com` URLs).
Confirmed by execution (two reviewers, independently, plus the verifier): `redactSensitiveText('https://api.github.com/repos/foo/bar/commits/<sha40>')` → `'https://api.github.[REDACTED:entropy]'` (an ordinary GitHub URL mangled); `containsOutboundSecret` on that same URL, and on an ordinary secret-free `api.example.com` webhook URL, both return `true` (hard-refused, zero network calls). The PR's own AC4 boundary test uses a non-`api`-hosted URL and does not exercise this class.
Fix: exclude `/` from the TOKEN character class, or split on `/` before running the entropy gates (the way `displayUrl`'s per-segment masking already does); require a word boundary around `SENSITIVE_LABEL` rather than a bare substring match. Add an `api.*`-hosted regression case to the AC4 boundary tests and the false-positive fixture.

### Major

**F-SEC-F2. The S-6/S-9 allow-shapes (git-SHA / UUID / npm-integrity) are checked by shape alone, with no provenance — a real secret in one of these shapes is never redacted or masked even sitting next to an explicit label.** `src/security/detect/entropy.ts` (`isAllowShapedValue`), in the diff.
Confirmed by execution (reviewer + verifier): `redactSensitiveText('leaked token: <40-hex>')`, a labeled UUID, a labeled short-hex, and a labeled `sha512-…` integrity string were all returned byte-for-byte unchanged.
Fix: do not let the allow-shape check override an explicit sensitive-label match nearby.

**F-SEC-F3. R-I2's `GLUED_SECRET_RE` anchoring fix over-corrected — any prefix glued onto `KEY`/`TOKEN`/`SECRET`/`PASS(WD)` without an underscore now evades `isDeniedForMcpChild` entirely.** `src/security/credential-shape.ts` (`GLUED_SECRET_RE`), in the diff.
Confirmed by execution (reviewer + verifier): `PRODDBPASS`, `MYPRIVATEKEY`, `USERREFRESHTOKEN`, `LEGACYACCESSTOKEN`, `V2APITOKEN`, `OAUTHACCESSTOKEN`, `SNOWFLAKEDBPASS` all return `false` (leak into spawned MCP-server / external-agent child envs unfiltered); unprefixed forms correctly return `true`; `APITOKENIZER` correctly stays `false`. No existing test covers a prefixed variant.
Fix: keep the trailing `($|_)` (which correctly stops `APITOKENIZER`) but drop the requirement that the leading boundary be `(^|_)`; if that reopens a different false positive, add a short explicit denylist instead, table-tested like the existing boundary rows.

**F-REG-F2. `displayUrl`'s new per-segment masking treats any pure-numeric path segment of 24+ digits as a credential, masking legitimate resource ids.** `src/mcp-servers/http-headers.ts:351`, in the diff (pre-existing `HEX_BLOB` regex, newly exposed with no label gate).
Confirmed by execution (reviewer + verifier): a 24-digit numeric segment is masked to `…`; a 23-digit one is left untouched — an arbitrary, undocumented boundary. None of the shipped `displayUrl` tests exercise a purely-numeric segment.
Fix: require at least one hex letter (a-f) before treating a candidate as `HEX_BLOB`, or require the entropy floor unconditionally for all-decimal values.

**F-REG-F3. The two new `detectEntropy` call sites (`redactSensitiveText`, `containsOutboundSecret`) bypass the `backends.entropy.enabled` config gate that `runDetectors`/`keryx security scan` honors.** `src/security/redact.ts:149`, in the diff.
Confirmed by execution (reviewer + verifier): `backends.entropy.enabled` is read in exactly one place in the codebase (`detect/index.ts:36`); neither `redactSensitiveText` nor `containsOutboundSecret` accepts a config parameter, so an operator who disables entropy detection still gets it applied on every tool output and every `web_fetch`/`web_search` call, with no way to turn it off.
Fix: thread the resolved config/enabled flag into both functions, or explicitly document/rename this as a separate non-configurable safety floor.

**F-ARCH-F1. The import-policy ceiling raise (150→151) is real but avoidable — the security facade re-exports `isDeniedForMcpChild` from `credential-shape.ts` but not the sibling `EXTERNAL_ENV_DENY`/`EXTERNAL_ENV_PREFIX_SWEEPS` constants, which is the only reason `env-deny.ts` bypasses it.** `src/harness/external/env-deny.ts:11`, in the diff.
Confirmed by execution (reviewer + verifier): live `checkImportPolicy` run measures avoidable=151 matching the new ceiling, with `env-deny.ts → credential-shape.ts` as the one new edge (no second, hidden edge); `security/service.ts` re-exports `isDeniedForMcpChild` but not the two DENY/SWEEPS constants.
Fix: add the two-constant re-export to `security/service.ts`, import through the facade in `env-deny.ts`, and revert the ceiling to 150.

### Minor

- **F-LOG-F2. The documented 7–12-hex short-SHA allow-shape (`SHORT_GIT_SHA_RE`) is unreachable dead code** — both callers gate out anything shorter than 16–20 characters before this branch could ever apply. `src/security/detect/entropy.ts`, in the diff. Confirmed by execution. No behavioral defect today; a future refactor of the length floors could silently break the (currently accidental) short-SHA safety with no test catching it.

### Verified clean

- **review-testing-practices**: mutation-tested 3 of the diff's guards (entropy allow-shape check, outbound-secret refusal, win32 RFC-3986 validation) by deleting each and re-running the relevant test file — all 3 went red on removal and green on revert. AC2/AC3/AC4/AC6/AC7's specific test claims (43-char bearer redacted, zero-network-call assertion, single-argv-entry assertion, case-insensitivity, exact corpus strings) are present as real, non-weakened assertions, not proxies.
- **win32 open-url allowlist (AC6)**: `review-security-code` constructed and ran adversarial inputs (`javascript:`/`data:`/`file:` schemes, backslash-for-slash, embedded tab/newline, Cyrillic-homoglyph host, backtick/pipe/caret, `&`-injection) — all refused. No bypass found.
- **`isDeniedForMcpChild` case-insensitivity (AC7)**: verified genuinely global at both call sites (`env.ts`, `spawn-env.ts`).
- **AC1 corpus baseline**: before/after `security eval --corpus all` recorded in the flow journal; no existing case regressed; new cases added for every named evasion and allow-shape.
- **AC3 (injection folding)**: newline-spanning match and Cyrillic/Greek confusable folding both verified; no benign corpus case newly fires.

### How this review was run

- **Run by:** MrCipherSmith with `review-orchestrator` (managed round, flow 355)
- **Scope:** `origin/main..dc63b9bc0469580d726379f9a03040bc7a71f6da`, round 1, PR #776
- **Orchestrator:** `review-orchestrator`
- **Reviewers dispatched (session model, tier=standard/inherit per `keryx review tier`):** review-security-code, review-logic, review-regression (scope B / blast-radius), review-testing-practices, review-architecture
- **Wave C:** review-verifier — 8/8 findings executed and confirmed, 0 refuted, 0 unverifiable
- **Not run:** none of the 5 requested reviewers were blocked
- **Verification:** filter; confirmed 8, refuted 0, unverifiable 0, unverified 0
- **External PR comments:** collected (round 1), 0 present

## Skill Learning
- none

```json keryx:findings
[
  {
    "id": "SEC-F1",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F1",
    "severity": "blocker",
    "file": "src/harness/web/outbound-secret.ts",
    "line": null,
    "quote": "export function containsOutboundSecret(text: string): boolean {\n  return detectSecrets(text).length > 0 || detectEntropy(text).length > 0;\n}",
    "problem": "S-8's outbound-secret check (containsOutboundSecret) is trivially bypassed: detectSecrets' URL-aware rule only fires when the query-param/path-segment name is on a small closed label list (api_key/access_token/auth_token/token/password/secret), and detectEntropy additionally requires a SENSITIVE_LABEL word within 40 chars on the same line. A secret placed under a generic param name, split across two generic params, or with the label word percent-encoded (t%6fken=) defeats both detectors.",
    "impact": "web_fetch/web_search send a real secret to an attacker-controlled host before any network call is blocked. Reviewer constructed and ran live probes against the worktree: containsOutboundSecret returned false for a 43-char secret under '?d=', for the same secret split across '?a='/'?b=', for a 40-hex secret under a generic param, and for a percent-encoded label ('t%6fken='). web_fetch reaches the real HTTP GET whenever this returns false.",
    "suggested_fix": "Drop the SENSITIVE_LABEL/label-list requirement for URL/query egress checks; route through looksSecretShaped per path-segment and per query-VALUE (unlabelled), and decode the URL/query keys before matching the label list.",
    "evidence": "bun run against ~/keryx-ar2 HEAD dc63b9bc: containsOutboundSecret('https://attacker.example/c?d=K9dQnR2zVbT8pXeYfWmC1oLaHsJtUvBgNq3rDcZk0AI') -> false; split across ?a=/?b= -> false; 40-hex under generic param -> false; 'https://x.example/c?t%6fken=<secret>' -> false. Independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "class_scope": {
      "sites": [
        "src/harness/web/outbound-secret.ts:14-16 containsOutboundSecret",
        "src/harness/tool/builtin/web-fetch-tool.ts:53 (gate before the real network fetch)",
        "src/harness/tool/builtin/web-search-tool.ts:58 (gate before the real search call)",
        "src/security/detect/entropy.ts SENSITIVE_LABEL / detectEntropy",
        "src/security/detect/secrets.ts secrets.url-sensitive-query / secrets.url-sensitive-path (closed label list)"
      ],
      "enumeration_method": "keryx ctx rg \"containsOutboundSecret\" src -> 2 production callers (web-fetch-tool.ts, web-search-tool.ts); read both detectors containsOutboundSecret composes end-to-end."
    }
  },
  {
    "id": "SEC-F2",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F2",
    "severity": "major",
    "file": "src/security/detect/entropy.ts",
    "line": null,
    "quote": "function isAllowShapedValue(value: string): boolean {\n  return (\n    FULL_GIT_SHA_RE.test(value) ||\n    SHORT_GIT_SHA_RE.test(value) ||\n    UUID_RE.test(value) ||\n    INTEGRITY_RE.test(value)\n  );\n}",
    "problem": "The S-6/S-9 allow-shapes are checked by shape alone with no provenance signal, applied even when an explicit sensitive label sits directly next to the value. A real secret that happens to be 40/7-12 hex chars, a UUID, or an npm/yarn integrity-shaped string is unconditionally exempted from redaction and from displayUrl masking.",
    "impact": "redactSensitiveText leaves labeled real secrets in these four shapes completely unredacted; displayUrl prints the same shapes verbatim in mcp list / mcp doctor --json / the trust prompt. Reviewer verified live: redactSensitiveText('leaked token: deadbeef...deadbeef') (40-hex), '...UUID...', '...sha512-...', and a short-hex case were all returned byte-for-byte unchanged despite the explicit label.",
    "suggested_fix": "Do not let the allow-shape check override an explicit sensitive-label match; when a label is present nearby, prefer treating the value as a candidate secret over the shape coincidence, or require the short/full-SHA shapes to also carry a 'commit'/'sha'/'rev' provenance word.",
    "evidence": "bun run against ~/keryx-ar2 HEAD: four labeled allow-shaped real-secret constructions all passed through redactSensitiveText unredacted; three unlabeled allow-shaped path segments passed through displayUrl unmasked. Independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts isAllowShapedValue / shapeQualifiesAsSecret (shared root cause)",
        "src/security/redact.ts:141-155 redactSensitiveText -> detectEntropy (S-6)",
        "src/mcp-servers/http-headers.ts:346-354 maskSecretShapedPathSegments -> looksSecretShaped (S-9)"
      ],
      "enumeration_method": "detectEntropy and looksSecretShaped are the only two exported functions of entropy.ts and both route through the single shapeQualifiesAsSecret/isAllowShapedValue gate; grepped every importer (keryx ctx rg) -> 2 production consumers besides outbound-secret.ts, which was checked separately and excluded (its labeled-URL path is caught by a different rule)."
    }
  },
  {
    "id": "SEC-F3",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F3",
    "severity": "major",
    "file": "src/security/credential-shape.ts",
    "line": null,
    "quote": "const GLUED_SECRET_RE =\n  /(^|_)(PRIVATE|SECRET|ACCESS|REFRESH|SESSION|CLIENT|API|APP)(KEY|TOKEN|SECRET)($|_)|(^|_)DB(PASS|PWD)($|_)/;",
    "problem": "R-I2's anchoring fix (added this PR to stop GLUED_SECRET_RE over-matching APITOKENIZER) requires the (^|_) boundary immediately before the glued prefix. This stops the false positive but also means the check only protects the five compounds at the very start of a name or right after an underscore; gluing any other word in front with no underscore (a common naming convention) makes the whole check stop matching for KEY/TOKEN/SECRET/PASS(WD) compounds (SECRET_SUBSTRING_RE still catches the PASSWORD family unaffected).",
    "impact": "A real credential named PRODDBPASS, MYPRIVATEKEY, USERREFRESHTOKEN, LEGACYACCESSTOKEN, V2APITOKEN, OAUTHACCESSTOKEN or SNOWFLAKEDBPASS is copied into a spawned MCP server's environment and an external agent CLI's environment unfiltered. Reviewer verified live: isDeniedForMcpChild returns false for all of the above (credential-shaped values), true for the unprefixed forms, and false for APITOKENIZER (intended). No existing test exercises a prefixed variant.",
    "suggested_fix": "Anchor on the compound itself (keep the trailing ($|_) which is what stops APITOKENIZER) without requiring the leading (^|_); if that reopens a different false positive, add a short explicit denylist of the handful of colliding words instead, table-tested the way spawn-env.table.test.ts already does for the KEY/TOKEN/PASS boundary cases.",
    "evidence": "bun run against ~/keryx-ar2 HEAD: isDeniedForMcpChild returned false for PRODDBPASS, STAGEDBPASS, MYPRIVATEKEY, USERREFRESHTOKEN, LEGACYACCESSTOKEN, V2APITOKEN, OAUTHACCESSTOKEN, SNOWFLAKEDBPASS (all credential-shaped values); true for unprefixed PRIVATEKEY/REFRESHTOKEN/ACCESSTOKEN/APITOKEN/DBPASS; false for APITOKENIZER (as intended). Independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-security-code",
    "class_scope": {
      "sites": [
        "src/security/credential-shape.ts GLUED_SECRET_RE (sole definition)",
        "src/mcp-servers/spawn-env.ts buildMcpChildEnv -> isDeniedForMcpChild",
        "src/harness/external/env.ts buildExternalChildEnv -> isDeniedForMcpChild"
      ],
      "enumeration_method": "isDeniedForMcpChild has exactly one definition and exactly two production callers, found via keryx ctx rg \"isDeniedForMcpChild\" src; both pass every parent-env entry through it unconditionally."
    }
  },
  {
    "id": "LOG-F1",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F1",
    "severity": "blocker",
    "file": "src/security/detect/entropy.ts",
    "line": null,
    "quote": "const TOKEN = /[A-Za-z0-9+/=_-]{20,}(?:\\.[A-Za-z0-9+/=_-]{6,})*/g;",
    "problem": "The entropy detector's TOKEN regex includes '/' in its character class, so applied to a URL it does not stop at path separators: an entire host/path/segments/<hex> run becomes one compound candidate. This defeats the git-SHA/UUID/integrity allow-shapes (which only match an isolated value, not a compound blob containing it) and makes SENSITIVE_LABEL's bare substring match fire on ordinary text like the hostname 'api.github.com'. Independently confirmed by review-regression (RG-1) from the outbound-refusal angle.",
    "impact": "redactSensitiveText mangles an ordinary https://api.github.com/repos/x/y/commits/<40-hex-sha> into '.../api.github.[REDACTED:entropy]' (silent corruption of tool-output transcripts). containsOutboundSecret refuses that same ordinary URL and an ordinary https://api.example.com/v1/webhooks/subscribe?... before any network call -- contradicting AC2's zero-false-positive claim and AC4's 'an ordinary URL with a commit SHA still fetches' guarantee for any api.*-hosted URL. Reproduced end-to-end against the real webFetchTool: api.github.com commit URL and api.stripe.com charge URL both hard-refused with zero network calls attempted; the PR's own boundary test uses a non-'api'-hosted host and dodges the bug.",
    "suggested_fix": "Exclude '/' from the TOKEN character class, or split candidates on '/' before applying the head/slug/entropy gates the way displayUrl's maskSecretShapedPathSegments already does per-segment; require a word boundary around SENSITIVE_LABEL rather than a bare substring match. Add a false-positive fixture case and an AC4 boundary test using an api.*-hosted URL with a hex id or auth-shaped path segment.",
    "evidence": "bun -e probes against ~/keryx-ar2: redactSensitiveText('https://api.github.com/repos/foo/bar/commits/abcdef1234567890abcdef1234567890abcdef12') -> 'https://api.github.[REDACTED:entropy]'; detectEntropy on the same string returns one match value 'com/repos/foo/bar/commits/abcdef1234567890abcdef1234567890abcdef12' (start:19,end:85); containsOutboundSecret on the same URL -> true; containsOutboundSecret('https://api.example.com/v1/webhooks/subscribe?callback=https://foo.bar/x') -> true (no secret present). review-regression independently reproduced the refusal half against the live webFetchTool with api.github.com and api.stripe.com URLs. Independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-logic",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/security/detect/entropy.ts (TOKEN regex / shapeQualifiesAsSecret / SENSITIVE_LABEL -- root mechanism)",
        "src/security/redact.ts (redactSensitiveText -- S-6/AC2 call site)",
        "src/harness/web/outbound-secret.ts (containsOutboundSecret -- S-8/AC4 call site, consumed by web-fetch-tool.ts and web-search-tool.ts)",
        "src/harness/tool/builtin/web-fetch-tool.ts:53",
        "src/harness/tool/builtin/web-search-tool.ts:58"
      ],
      "enumeration_method": "grepped detectEntropy( across src/ (excluding tests): redact.ts:149, detect/index.ts:37 (pre-existing, config-gated, unaffected), outbound-secret.ts:15 (both new call sites inherit the bug). displayUrl's maskSecretShapedPathSegments checked and excluded: it pre-splits on '/' before calling looksSecretShaped, so the compounding mechanism cannot apply there."
    }
  },
  {
    "id": "LOG-F2",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F2",
    "severity": "minor",
    "file": "src/security/detect/entropy.ts",
    "line": null,
    "quote": "const SHORT_GIT_SHA_RE = /^[0-9a-f]{7,12}$/i;",
    "problem": "AC2 and the CHANGELOG/findings.md narrative claim a '7-12-hex short SHA' allow-shape, but it is unreachable in both callers: detectEntropy's TOKEN regex requires a 20+ char head before any candidate is considered, and looksSecretShaped is only invoked on segments of 16+ chars -- both above the 7-12 range.",
    "impact": "No behavioural defect today (the outcome AC2 asks for holds), but it is dead code presented as the mechanism that achieves it; a future refactor that changes the length floors could silently break the (currently accidental) short-SHA safety with no test catching it.",
    "suggested_fix": "Either add a genuine call path that can reach a 7-12 char candidate plus a direct unit test through the real caller, or remove the branch/claim and document the length floors as the actual reason short SHAs are safe.",
    "evidence": "bun run: a labeled 12-hex string produced zero detectEntropy matches (20+ char TOKEN floor) and was left untouched by displayUrl (16-char segment floor); looksSecretShaped('abc1234def56') called directly -> false anyway; independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-logic"
  },
  {
    "id": "REG-F2",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F2",
    "severity": "major",
    "file": "src/mcp-servers/http-headers.ts",
    "line": 351,
    "quote": "return detectSecrets(segment).length > 0 || looksSecretShaped(segment) ? \"…\" : segment;",
    "problem": "displayUrl's new per-path-segment masking calls looksSecretShaped with no label requirement, which falls back to HEX_BLOB = /^[0-9a-f]{24,}$/i whenever the entropy floor isn't met on its own. Decimal digits are a strict subset of the hex alphabet, so any purely-numeric string of 24+ characters satisfies HEX_BLOB regardless of actual entropy or credential likelihood.",
    "impact": "A legitimate, non-credential, purely-numeric resource id (order/invoice/charge id) of 24+ digits anywhere in an MCP server's URL path is silently replaced with '…' in mcp list, mcp doctor --json, and the trust-authorisation prompt -- exactly the surfaces this feature exists to make debuggable. Verified: https://api.example.com/v1/invoices/123456789012345678901234/lines -> '.../invoices/.../lines'; a 23-digit id of the same shape is left untouched, so the boundary is arbitrary. None of the existing displayUrl masking tests exercise a purely-numeric segment.",
    "suggested_fix": "Require at least one actual hex letter (a-f) before treating a candidate as a HEX_BLOB, or require the entropy floor unconditionally for all-decimal values. Add a boundary test for a long purely-numeric segment asserting it is left untouched.",
    "evidence": "bun -e probe: looksSecretShaped('123456789012345678901234') (24 digits) -> true; looksSecretShaped('12345678901234567890123') (23 digits) -> false; displayUrl('https://api.example.com/v1/orders/123456789012345678901234/lines') -> '.../orders/.../lines'. Independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-regression",
    "location_class": "pre-existing",
    "class_scope": {
      "sites": [
        "src/mcp-servers/http-headers.ts:384 (displayUrl)",
        "src/commands/mcp-servers.ts:285",
        "src/commands/mcp-servers.ts:537",
        "src/mcp-servers/doctor.ts:317",
        "src/mcp-servers/doctor.ts:416",
        "src/mcp-servers/trust.ts:215",
        "src/tui/mcp-consumer.ts:138 (not in the computed 40-file blast-radius set, despite calling the identical masked function)"
      ],
      "enumeration_method": "keryx ctx rg \"displayUrl\" src (38 matches, 8 files) -- every non-test, non-definition call site read directly."
    }
  },
  {
    "id": "REG-F3",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F3",
    "severity": "major",
    "file": "src/security/redact.ts",
    "line": 149,
    "quote": "const matches = [\n    ...detectSecrets(text),\n    ...detectPii(text),\n    ...detectExfil(text),\n    ...detectEntropy(text),\n  ];",
    "problem": "This diff wires detectEntropy into redactSensitiveText (S-6) and into the new containsOutboundSecret (S-8) unconditionally -- neither threads a config/cwd parameter, so neither can consult SecurityConfig.backends.entropy.enabled. The only existing gate for detectEntropy is runDetectors (src/security/detect/index.ts:36), which keryx security scan/report/gate go through.",
    "impact": "An operator who has explicitly set backends.entropy.enabled: false (a real, documented, default-true toggle) still gets every tool output/session transcript entropy-redacted and every web_fetch/web_search call entropy-checked/potentially refused, with no way to turn either off -- silently breaking the previously-consistent meaning of that flag.",
    "suggested_fix": "Thread the security config (or a resolved enabled boolean) into redactSensitiveText/containsOutboundSecret and skip detectEntropy when backends.entropy.enabled === false, or explicitly document and rename this as a separate, non-configurable safety floor distinct from the scan/report/gate pipeline's opt-in backend.",
    "evidence": "Read src/security/redact.ts:141-155 (unconditional detectEntropy call), src/harness/web/outbound-secret.ts:14-16 (unconditional detectEntropy call), src/security/detect/index.ts:27-39 (the only if (config.backends.entropy.enabled) guard in the codebase, confirmed via keryx ctx rg \"backends.entropy\" src/security -- 2 matches total: detect/index.ts and config.ts), src/security/config.ts:39-51 (default enabled:true) and :385 (mergeSecurityConfig honoring an override). Neither redactSensitiveText nor containsOutboundSecret takes a config/cwd argument. Independently re-executed by review-verifier with the same result.",
    "confidence": "high",
    "reviewer": "review-regression",
    "location_class": "in-diff",
    "class_scope": {
      "sites": [
        "src/security/redact.ts:149 (redactSensitiveText)",
        "src/harness/web/outbound-secret.ts:15 (containsOutboundSecret)",
        "src/commands/agent.ts:3196",
        "src/session/store.ts:404",
        "src/session/store.ts:410",
        "src/session/slate.ts:346",
        "src/review/conform-state.ts:113",
        "src/review/conform-state.ts:114",
        "src/review/conform-state.ts:206",
        "src/harness/tool/builtin/slate-tool.ts:189",
        "src/sac/workspace-resolve.ts:150",
        "src/session/slate-terminal-state.ts:84",
        "src/security/output-validation.ts:210"
      ],
      "enumeration_method": "keryx ctx rg \"detectEntropy\" src cross-referenced with keryx ctx rg \"backends.entropy\" src/security. redactSensitiveText has 44 total production call sites repo-wide; 34 outside the capped 40-file blast-radius set were not individually re-verified but share the identical unconditional call at redact.ts:149."
    }
  },
  {
    "id": "ARCH-F1",
    "global_id": "2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#ARCH-F1",
    "severity": "major",
    "file": "src/harness/external/env-deny.ts",
    "line": null,
    "quote": "export { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from \"../../security/credential-shape\";",
    "problem": "This diff adds a new client-zone-imports-core-internal edge (harness/external/env-deny.ts -> security/credential-shape.ts), bypassing the security/service.ts facade, and permanently raises AVOIDABLE_BYPASS_CEILING from 150 to 151. The PR justifies this as 'structurally unavoidable' because credential-shape.ts (core) cannot import env-deny.ts (client) back -- true but irrelevant, since the actual bypass exists only because security/service.ts re-exports isDeniedForMcpChild from credential-shape.ts (added in this same diff) but was not also extended to re-export EXTERNAL_ENV_DENY/EXTERNAL_ENV_PREFIX_SWEEPS.",
    "impact": "The ratchet in import-policy.live.test.ts only ever fails on growth and does not self-correct once raised, baking in one avoidable bypass as permanent tracked debt when the fix was a two-line change to a file this diff was already editing for the identical purpose.",
    "suggested_fix": "Add `export { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from \"./credential-shape\";` to src/security/service.ts alongside the existing isDeniedForMcpChild re-export; change env-deny.ts's re-export to pull from \"../../security/service\" instead; revert AVOIDABLE_BYPASS_CEILING to 150.",
    "evidence": "Ran checkImportPolicy({root: SRC}) live against the PR-head worktree via a bun probe script: total avoidable = 151, matching the new ceiling exactly; of 29 edges into security/* internals, harness/external/env-deny.ts -> security/credential-shape.ts is the only one absent from the documented pre-PR baseline of 150 (confirming exactly +1 new edge, no hidden second edge). Confirmed src/security/service.ts re-exports only isDeniedForMcpChild from credential-shape.ts, not the two DENY/SWEEPS constants. Confirmed spawn-env.ts and harness/external/env.ts both import isDeniedForMcpChild via the facade correctly. Confirmed credential-shape.ts is a zero-import leaf module (no cycle risk from adding the re-export). Independently re-executed by review-verifier (live checkImportPolicy run + bun test src/lib/import-policy.live.test.ts, 13 pass) with the same result.",
    "confidence": "high",
    "reviewer": "review-architecture",
    "class_scope": {
      "sites": ["src/harness/external/env-deny.ts:11"],
      "enumeration_method": "Ran checkImportPolicy live against the PR-head worktree, filtered to kind 'client-imports-core-internal' with target under security/, diffed against the test file's documented pre-PR baseline of 150. Of 29 total edges into security/ internals, exactly one is new relative to baseline."
    }
  }
]
```
