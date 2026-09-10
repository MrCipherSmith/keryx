# Managed review round — flow 247, PR #526 (`feat/mcp-servers-p1`)

Remote MCP servers over streamable HTTP: transport, credential headers,
bearer tokens, and the HTTP half of `keryx mcp doctor`.

Three reviewers ran in parallel against the branch diff (`main...HEAD`),
each on a declared dimension. Every finding below was reproduced by the
author before being fixed, and the fix re-measured against the same
reproduction — for the security finding, in both directions.

## Round shape

| Dimension | Findings | Confirmed | Refuted after fix |
|---|---|---|---|
| Security | 1 | 1 | 1 |
| Correctness | 2 | 2 | 2 |
| Test quality | 1 | 1 | 1 |

No finding was dismissed. The reviewers each also recorded categories
they checked and found clean; those are listed at the end so that
"nothing reported" is distinguishable from "not looked at".

A capability gap is recorded honestly: all three reviewers ran without a
shell, so `keryx ctx rg` and `keryx ctx run` were unavailable to them and
the repository's hook blocked raw `Grep` with no fallback. They worked by
reading whole files and tracing call paths. Two of the four findings came
from reading the *installed SDK's* source rather than this repository's,
which no amount of searching this repository would have produced — but
the constraint is a dispatch error by the author, not a property of the
task, and the next round should give reviewers a shell.

---

## F-052 — CRITICAL — the redirect refusal covered two of the SDK's three fetch calls, and the credential rode on the third

**Reported by:** security. **Status:** confirmed, fixed, refuted.

`connectHttpMcpServer` set `redirect: "error"` on `requestInit` to stop
keryx following a redirect, because a custom credential header follows
one. The SDK spreads `requestInit` into exactly two of its three fetch
calls — `send()` (POST, `streamableHttp.js:301`) and `terminateSession()`
(DELETE, line 440). The third, `_startOrAuthSse()` (line 90), hand-builds
the GET that opens the event stream and spreads nothing:

```js
const response = await (this._fetch ?? fetch)(this._url, {
  method: 'GET', headers, signal: this._abortController?.signal
});
```

So that call ran at the platform default of following up to twenty hops.
`_commonHeaders()` *does* merge `requestInit.headers` into it, so the
configured credential was present on the one call with no policy. The GET
runs automatically after `notifications/initialized`, and again on every
SSE reconnection.

**Failure scenario.** A server configured with
`{"headers": {"X-Api-Key": "${VENDOR_KEY}"}}` answers the handshake
normally, then answers the SSE GET with
`307 Location: http://169.254.169.254/latest/meta-data/`. keryx follows
it and sends `X-Api-Key` to that host. `fetch` strips only
`Authorization`, and only across origins; a custom header — which this
code's own comment calls the common MCP pattern — is not stripped at all,
and `Authorization` itself survives a same-origin redirect.

**Why the existing test could not see it.** The fixture answered *every*
request with a 307, so the first `initialize` POST — which *is* protected
— failed and the connection never reached the GET. The test proved the
protected leg was protected.

**Fix.** Wrap `fetch` itself via the transport's `opts.fetch`, so all
three legs are covered and a fourth would be too. `requestInit.redirect`
is kept as a statement of intent.

**Verification, both directions.** With the wrapper removed, the redirect
target records `x-api-key: sk-live-must-not-follow`. With it, the target
records nothing while the redirector still records the GET — so the test
cannot pass by the SSE leg failing to run, which is precisely how the gap
survived the first time.

---

## F-053 — HIGH — the session dial never checked the URL, only `doctor` did

**Reported by:** correctness. **Status:** confirmed, fixed, refuted.

`urlProblem` exists specifically because an unset `${TENANT}` in a url
expands to a *valid* url addressing the wrong path
(`https://api.example//mcp`). It was called from one place: `diagnose()`
in `doctor.ts`. `connectRemote` — the dial every real shell session uses
— called neither it nor `userinfoProblem`.

**Failure scenario.** `"url": "https://api.example.com/${TENANT}/mcp"`
with `TENANT` unset. `keryx mcp doctor` reports `needs_auth — url needs
TENANT, which is unset` and does not dial. The shell session connects to
`https://api.example.com//mcp` and either fails with an error
`explainConnectFailure` describes as the *server's* problem, or succeeds
against the wrong path.

A pre-flight stricter than the flight is worse than no pre-flight: it
reports a problem the operator cannot then reproduce, and hides one they
will meet.

**Fix.** One `remoteTargetProblem(raw, env)` in `http-headers.ts`, called
by both `connectRemote` and `diagnose`. One list, two callers — the same
lesson the duplicated `defaultConnect` taught earlier on this branch.

---

## F-054 — MEDIUM — `keryx mcp list --json` contradicted `doctor` on the same config

**Reported by:** correctness. **Status:** confirmed, fixed, refuted.

`publicView` redacted headers with `redactValues`, the function
`doctor.ts`'s own docstring says is wrong for headers: `Bearer ${NOPE}`
expands to `"Bearer "`, which is non-empty, so the naive check reads
`set` for a header that will never be sent.

**Failure scenario.** Same config, two commands: `doctor` reports
`headers: {"Authorization": "unset"}`, `list --json` reports `"set"`. The
self-contradicting report that `redactHeaders` was written to fix, still
shipping from the sibling command. `list` also resolved its config
without the injected environment, so the two commands could disagree for
that reason as well.

**Fix.** `publicView` takes `env` and calls `redactHeaders`; `load()`
threads `deps.env`.

---

## F-055 — MEDIUM — the ECONNREFUSED test accepted the fallback's wording

**Reported by:** test quality. **Status:** confirmed, fixed, refuted.

`doctor.failures.test.ts` asserted
`/nothing is listening|could not be reached/`. The second alternative is
the *generic fallback* that fires for any unrecognised syscall code, so
deleting the `ECONNREFUSED` branch entirely leaves the assertion true.

This is verbatim the criticism `mutation-gaps.test.ts` makes of the DNS
test four lines away — written by the author, in the same session, and
not applied here.

**Measured, not argued.** With the branch deleted, 41 tests stayed green.

**Fix.** An exact-wording unit test in `mutation-gaps.test.ts`, matching
the `ENOTFOUND`/`EAI_AGAIN`/TLS pattern already there. The live test keeps
its looser regex as an end-to-end smoke check but is no longer the only
thing behind the branch.

**Second-order fix — the sweep's own blind spot.** `scripts/mutation-sweep.ts`
generated this mutant as `===` → `!==` and it *died*, because inverting a
dispatch branch makes it fire for every other code, which a sibling's
exact test catches. Only *deleting* the branch is invisible. Single-line
guard clauses are now deleted as well as inverted; that shape can be
removed whole and still parse, which arbitrary statements cannot.

---

## Checked and found clean

Recorded so that an absence of findings is distinguishable from an
absence of looking.

**Security:** credential values in logs/`doctor --json`/`ServerState.error`
(hardened — no path carries a real value); `sanitiseForDisplay` and
`truncateResult` coverage on third-party text; the trust fingerprint now
covering `headers`/`bearer_token_env_var`; trust-store TOCTOU and symlink
handling.

**Correctness:** `unresolvedVariables`, `isHollowValue`, the duplicate
guard and the `bearer_token_env_var`-vs-explicit precedence across the
unset/`:-`/whitespace/case-duplicate boundaries; `connectHttpMcpServer`'s
scheme, userinfo and timeout handling; `explainConnectFailure`'s
code-based classification and its 100–599 range.

**Test quality:** the fixture (real socket, records what arrived);
`class-table.ts` and the invariant that proves it bites; the class tables
in `http-headers.table.test.ts` and `spawn-env.table.test.ts` (real
`expandVars`, boundary rows present); `http.credentials.test.ts`'s
insistence on `server.requests()` being empty rather than the promise
rejecting; the two rewritten timing tests.

## Carried, not fixed

**`ServerState.error` is not sanitised**, unlike the parallel `doctor`
path. The security reviewer looked for a surface that displays it and
could not find one — `use_tool`'s "not connected" message shows
`state.status`, `reportMcpProblems` shows config problems, and the
consumer-MCP TUI does not exist yet. It is a latent asymmetry, not a
reachable defect today, and the surface that would make it reachable is
P2's `/mcp` panel. Recorded there rather than fixed speculatively here.


```json keryx:findings
[
  {
    "id": "F-052",
    "reviewer": "review-security-code",
    "severity": "blocker",
    "file": "src/mcp-client/client.ts",
    "line": 549,
    "confidence": "high",
    "blocking_merge": true,
    "problem": "`redirect: \"error\"` was set on the SDK transport's `requestInit`, and the SDK spreads `requestInit` into only two of its three fetch calls. The third, `_startOrAuthSse()`, hand-builds the GET that opens the SSE stream and spreads nothing, so it ran at the platform default of following up to twenty hops \u2014 while `_commonHeaders()` merged the configured credential header into it.",
    "impact": "Credential exfiltration and SSRF. A server answers the handshake normally, then answers the SSE GET with `307 Location: http://169.254.169.254/...`; keryx follows it and sends `X-Api-Key` to that host. `fetch` strips only `Authorization`, and only across origins, so a custom header \u2014 which this code's own comment calls the common MCP pattern \u2014 is not stripped at all. The GET runs automatically after `notifications/initialized` and again on every reconnection.",
    "suggested_fix": "Pass a `fetch` wrapper via the transport's `opts.fetch` that forces `redirect: \"error\"` on every call, rather than relying on `requestInit`, which is provably not honoured by all of the transport's fetches.",
    "evidence": "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js: line 90 `(this._fetch ?? fetch)(this._url, {method:'GET',headers,signal})` with no requestInit spread; lines 301 and 440 do spread it. Measured both directions: with the wrapper removed the redirect target records `x-api-key: sk-live-must-not-follow`; with it, the target records zero requests while the redirector still records the GET.",
    "class_scope": {
      "sites": [
        "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:90 (_startOrAuthSse GET \u2014 unprotected)",
        "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:301 (send POST \u2014 protected by requestInit)",
        "node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js:440 (terminateSession DELETE \u2014 protected by requestInit)"
      ],
      "enumeration_method": "Grepped every `(this._fetch ?? fetch)(` call site and every `...this._requestInit` spread in the installed SDK transport; three fetches, two spreads. The fix wraps `fetch` itself so the count cannot drift."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit db94154c \u2014 fetch wrapper in connectHttpMcpServer, `redirectSseTo` fixture mode, and the test 'including the SSE stream's GET, which the POST test could not reach' in src/mcp-servers/http.live.test.ts"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Verified against commit db94154c, the tree that will merge. Removed the `fetch` wrapper introduced by db94154c from src/mcp-client/client.ts and re-ran `bun test src/mcp-servers/http.live.test.ts`: 1 failure, the redirect target having recorded `x-api-key: sk-live-must-not-follow`. Restored db94154c's version: 25 pass, 0 fail, target records zero requests while the redirector still records the GET. The finding does not reproduce at db94154c.",
      "verifier": "author-mutation-check"
    }
  },
  {
    "id": "F-053",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/mcp-servers/runtime.ts",
    "line": 246,
    "confidence": "high",
    "problem": "`urlProblem` and `userinfoProblem` were called only from `diagnose()` in doctor.ts. `connectRemote` \u2014 the dial every real shell session uses \u2014 called neither.",
    "impact": "`keryx mcp doctor` refuses a config with an unset `${TENANT}` in the url, while the session it is pre-flighting connects to `https://api.example.com//mcp`: a valid URL addressing the wrong path. A pre-flight stricter than the flight reports a problem the operator cannot reproduce and hides one they will meet.",
    "suggested_fix": "One `remoteTargetProblem(raw, env)` in http-headers.ts, called by both `connectRemote` and `diagnose`.",
    "evidence": "`keryx ctx rg urlProblem src/` returned doctor.ts:223 and the definition only; runtime.ts had no reference. Reproduced by test 'the runtime refuses, naming the variable' in http.credentials.test.ts.",
    "class_scope": {
      "sites": [
        "src/mcp-servers/runtime.ts:connectRemote",
        "src/mcp-servers/doctor.ts:diagnose",
        "src/commands/mcp-servers.ts (uses the shared defaultConnect, so covered by the runtime site)"
      ],
      "enumeration_method": "Enumerated every caller that reaches connectHttpMcpServer with a ResolvedMcpServer in hand: the runtime dial, doctor's diagnose, and the CLI \u2014 which had already been deduplicated onto the runtime's defaultConnect earlier in this branch."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit db94154c \u2014 remoteTargetProblem added to http-headers.ts and called from both connectRemote and diagnose"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Verified against commit db94154c, the tree that will merge. db94154c adds `remoteTargetProblem` and calls it from `connectRemote`; `bun test src/mcp-servers/http.credentials.test.ts` at that commit passes 14/14, including 'the runtime refuses, naming the variable' (zero requests reach a real listener), the BOUNDARY case that connects with the variable set, and the userinfo refusal. The finding does not reproduce at db94154c.",
      "verifier": "author-mutation-check"
    }
  },
  {
    "id": "F-054",
    "reviewer": "review-logic",
    "severity": "major",
    "file": "src/commands/mcp-servers.ts",
    "line": 129,
    "confidence": "high",
    "problem": "`publicView` redacted headers with `redactValues`, the function doctor.ts's own docstring states is wrong for headers: `Bearer ${NOPE}` expands to a non-empty `\"Bearer \"`, so the naive check reads `set` for a header that will never be sent. `load()` also resolved config without the injected environment.",
    "impact": "`keryx mcp doctor` reports `headers: {\"Authorization\": \"unset\"}` and `keryx mcp list --json` reports `\"set\"` for the identical config \u2014 the self-contradicting report `redactHeaders` was written to fix, still shipping from the sibling command.",
    "suggested_fix": "`publicView` takes `env` and calls `redactHeaders`; `load()` threads `deps.env`.",
    "evidence": "src/commands/mcp-servers.ts:129 called redactValues(server.headers) while doctor.ts:182 called redactHeaders(server, env) for the same field.",
    "class_scope": {
      "sites": [
        "src/commands/mcp-servers.ts:publicView (list --json)",
        "src/mcp-servers/doctor.ts:diagnose (doctor, already correct)"
      ],
      "enumeration_method": "Grepped every call site of redactValues and redactHeaders across src/; two surfaces emit a `headers` field to an operator, and only one used the hollow-aware function."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commit db94154c \u2014 publicView now takes env and calls redactHeaders; load() threads deps.env"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Verified against commit db94154c, the tree that will merge. db94154c changes `publicView` to take `env` and call `redactHeaders`, and threads `deps.env` through `load()`; `bun test src/mcp-servers/ src/mcp-client/ src/commands/mcp-servers` at that commit passes 635/635. `keryx ctx rg redactValues src/commands/mcp-servers.ts` no longer matches the headers field. The finding does not reproduce at db94154c.",
      "verifier": "author-mutation-check"
    }
  },
  {
    "id": "F-055",
    "reviewer": "review-testing-practices",
    "severity": "major",
    "file": "src/mcp-servers/doctor.failures.test.ts",
    "line": 84,
    "confidence": "high",
    "problem": "The ECONNREFUSED test asserted `/nothing is listening|could not be reached/`, and the second alternative is the generic fallback for any unrecognised syscall code. Deleting the ECONNREFUSED branch entirely leaves the assertion true \u2014 verbatim the criticism mutation-gaps.test.ts makes of the DNS test four lines away.",
    "impact": "The syscall dispatch chain in explainConnectFailure read as covered while its arms could be removed silently. Following the class up found ETIMEDOUT in the same state.",
    "suggested_fix": "Exact-wording unit tests per arm in mutation-gaps.test.ts, plus a BOUNDARY test pinning the generic fallback so no arm can be mistaken for it. Teach the mutation sweep to DELETE single-line guard clauses, not only invert them.",
    "evidence": "Deleted the ECONNREFUSED branch from doctor.ts and ran `bun test src/mcp-servers/doctor.failures.test.ts src/mcp-servers/mutation-gaps.test.ts`: 41 pass, 0 fail. Measured, not argued.",
    "class_scope": {
      "sites": [
        "src/mcp-servers/doctor.ts ECONNREFUSED arm (reported)",
        "src/mcp-servers/doctor.ts ENOTFOUND/EAI_AGAIN arm (already had an exact test)",
        "src/mcp-servers/doctor.ts TLS arm (already had exact tests)",
        "src/mcp-servers/doctor.ts ETIMEDOUT arm (found by following the class; had no exact test)",
        "src/mcp-servers/doctor.ts generic fallback (had no test pinning it as distinct)"
      ],
      "enumeration_method": "Enumerated every arm of the syscall if-chain in explainConnectFailure and checked each for an exact-wording test. Then re-ran the mutation sweep with a guard-deletion operator, which independently surfaced the ETIMEDOUT arm."
    },
    "disposition": {
      "state": "acted-on",
      "evidence": "commits db94154c (ECONNREFUSED exact test, guard-deletion operator) and 5e40e492 (ETIMEDOUT exact test and the fallback BOUNDARY test)"
    },
    "verification": {
      "verdict": "refuted",
      "method": "execution",
      "evidence": "Verified against commits db94154c and 5e40e492, the tree that will merge. db94154c adds the exact-wording ECONNREFUSED test and the guard-deletion operator; 5e40e492 adds ETIMEDOUT and the fallback BOUNDARY test. At 5e40e492, deleting the ETIMEDOUT branch from doctor.ts makes 1 test fail where 0 failed before; restoring gives 29 pass. The fourth mutation sweep at that tree leaves 12 survivors, all equivalent mutants. The finding does not reproduce at 5e40e492.",
      "verifier": "author-mutation-check"
    }
  }
]
```
