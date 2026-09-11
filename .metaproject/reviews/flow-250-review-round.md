# Review round — flow 250, MCP servers P3b (OAuth)

Five reviewers, dispatched in parallel on the diff against merge-base
`1571131f`. Project-local reviewer skills from
`.metaproject/skills/gdskills/review/`, each run through
`general-purpose` because no native agent type exists for those names
— the fallback the orchestrator specifies.

| Reviewer | Verdict | blocker | major | minor | info |
|---|---|---|---|---|---|
| review-security-code | DONE_WITH_CONCERNS | 1 | 4 | 2 | 1 |
| review-logic | DONE_WITH_CONCERNS | 1 | 5 | 3 | 0 |
| review-architecture | DONE_WITH_CONCERNS | 0 | 4 | 5 | 3 |
| review-testing-practices | DONE_WITH_CONCERNS | 1 | 1 | 4 | 1 |
| spec-compliance (stage 1) | 15 met / 2 partial / 1 not met | 1 | 2 | 0 | 0 |

## The two blockers were both confirmed criteria that were false

This is the finding the round existed to produce. I am the author, I
confirmed all eighteen criteria myself, and two of those
confirmations did not hold.

**AC12 — the session never refreshed.** `sessionAuthProviderOptions`
omitted `redirectUrl`, which reads as correct: a session has nowhere
to be redirected to. The SDK computes `nonInteractiveFlow =
!provider.redirectUrl` and short-circuits into a client-credentials
grant *before* the refresh branch. No session ever refreshed a token;
the failure arrived with no status, so `needsAuthorisation` returned
false and doctor reported `failed` instead of the `needs_auth` this
release exists to produce.

Why my tests missed it: the integration helper hard-codes
`redirectUrl`, so every AC12 test exercised the `keryx mcp auth`
provider shape and none exercised the session's. Found independently
by review-logic and review-security-code, both by driving the real
SDK rather than reading it. Reproduced before accepting.

Two consequences neither reviewer reached, found by probing further:
the headless gate was unreachable from a session at all, because the
SDK calls `state()` before `redirectToAuthorization` and `state()`
threw a plain `Error`; and a session with no credential silently
POSTed a dynamic client registration to the operator's authorisation
server. Refusing inside `saveClientInformation` is too late — the
request has already been sent — so a session now attaches no provider
it cannot use.

**AC6 — the bind address was never asserted.** The criterion says a
test asserts the bound address. The test asserted `redirectUrl`,
which the module builds from the same constant it passes to `serve`:
the constant compared with itself. Changing `hostname` to `0.0.0.0`
left all 19 callback tests green — the listener could have offered
the authorisation code to the whole network. Proven by the spec
reviewer's mutation, reproduced here before accepting.

The mutation sweep could not have caught this: its operator table has
no string-literal substitution. A limitation of the tool, recorded
rather than explained away.

**Note on the panel.** The spec reviewer marked AC12 as MET — fooled
the same way I was, by checking that tests exist and assert the right
things without noticing the provider shape under test. The two
reviewers who ran the code caught it. Where the panel disagreed, the
empirical reviewers were right.

## Dispositions

Every finding was either fixed or answered. Nothing was deferred.

| Area | Finding | Disposition |
|---|---|---|
| session OAuth | no `redirectUrl`; no refresh; unattended registration; gate unreachable | fixed, verified against a mock AS |
| callback | bind address unasserted (AC6) | fixed — `boundHost` read from the server |
| callback | `?error=` settled before the `state` check: any visited web page could abort an in-flight authorisation | fixed — state first, constant-time |
| auth command | no approval gate, unlike every other surface | fixed |
| auth command | no shared target pre-flight; unset `${VAR}` waited out the callback budget | fixed |
| auth command | own platform browser table, missing `open-url.ts`'s DISPLAY guard; URL never printed | fixed — reuses the shared module |
| auth command | every leg-one failure treated as "browser is open" → 5-minute wait blaming the operator | fixed |
| credentials | unlocked read-modify-write loses concurrent updates | fixed — `withFileLock`, proven with six real processes |
| credentials | `{ok:false}` discarded by all three provider save methods | fixed |
| credentials | PKCE verifier outlived its documented lifetime | fixed |
| credentials | `schemaVersion` written, never read | fixed — a newer store is refused |
| config | `scopes` and `callbackPort` validated and read by nothing | implemented, asserted on a recording mock |
| config | `clientSecretEnvVar` accepted, unimplemented | now reported as unimplemented rather than silently ignored |
| recovery | no way to remove a dead credential | added `keryx mcp logout` |
| doctor | 401 branch ungated, contradicting `auth` on bearer servers | fixed |
| tests | two vacuous tests in `mcp-auth-flow.test.ts` | rewritten; both mutants now die |
| tests | secrecy sentinel was a literal tautology | replaced with a per-surface output check |
| tests | AC3 `/mcp` view never driven with a token | added |
| tests | AC14 fingerprint not after a completed flow, config dir only | added, across config + project + home |
| tests | AC9 tests hung rather than failed | routed through the deadline helper |
| tests | duplicate BOUNDARY; class-table axis did not describe what varies | both fixed |
| tests | "expired token not sent" searched bodies only | reads headers now |
| constraints | writer sweep not extended to the two new writers | extended |
| arch | `usesOAuth` lives in the store module | NOT FIXED — moving it risks a `config → credentials → config` cycle for a naming gain. Recorded. |
| arch | `bothStreamsAreATerminal` exported though only `resolveInteractive` calls it | NOT FIXED — it is the tabled unit; the export is what the table tests. |

## Unrelated defect found while verifying

`src/sac/fwk-parity.test.ts` spawns a real process and drives a real
stdio MCP handshake against bun's default 5s timeout. It failed about
one run in three. Fixed, because a release was about to be certified
on this suite's verdict and a flake in the gate teaches the reader to
re-run instead of look.
