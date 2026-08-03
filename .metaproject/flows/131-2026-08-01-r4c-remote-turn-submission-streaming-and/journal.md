# Flow Journal

## D5 — what "the local profile" is, decided rather than looked up

Spec AC-04 says a remote profile may never grant what the local profile denies,
and keryx has several local postures: `harness run` is `read-only-review`,
`harness exec` is shell-allow, and the interactive shell — the surface an
operator actually sits in front of — is `shellParentProfile`.

The ceiling is the interactive shell's posture. "Remote may never grant what
local denies" is a statement about what local GRANTS, not about the strictest
corner of it, and picking `read-only-review` would make the check pass only for
a remote profile that can do nothing — not a security property but a refusal to
implement the feature.

## Two things the launch prompt had wrong, found by running rather than reading

1. **There were four profile literals, not two.** The prompt named the two in
   `commands/harness.ts` as "the ONLY local profiles that exist".
   `tool/builtin/spawn-subagent-tool.ts` held two more with their own
   fingerprint inputs. The source-level guard written for D1 reported them; a
   reading of the prompt would not have.
2. **`DEFAULT_SERVE_PROFILE` is `remote-restricted`,** which is not a
   `PolicyProfileId`. Resolving the config's profile name against the frozen id
   set would have refused every configuration R4b shipped. Operator-facing names
   and frozen ids are now separate vocabularies — which is also the clearest
   statement of why `compareProfiles` may never compare names: `remote-restricted`
   and `unattended-untrusted` are one posture under two spellings.

## D6 — the security scan is rooted at the INSTALL, not the declared project

AC10's inventory assertion found it: `redact()` still needs an HMAC key to hash
finding values, and creates one under `<root>/.metaproject/data/security/` on
first use. Scanning against the declared project therefore WROTE INTO THE
PROJECT, which spec AC-14/15 forbid of every route on this surface.

Scoping to the install is the better answer on its own terms, not merely the one
that makes the test pass. The prompt is untrusted content arriving at the
INSTALL boundary. Project-scoped, a remote caller would choose which security
configuration governs the scan of their own prompt by naming that project — so
the laxest `.metaproject` on the machine would decide. One install, one scanning
policy, chosen by the operator rather than by the caller.

## Three defects the tests found in my own work

1. **The security scan was implemented and unreachable.** It was an exported
   function the route was expected to call, and the route did not. Step 5 of the
   required decision path was therefore indistinguishable from absent while
   every test passed. Fixed by making the pipeline a factory — a caller that
   gets a turn runner gets the scan with it — and by having the route suite use
   the production factory instead of re-composing its steps.
2. **The terminal result carried no assistant text.** The completion gate writes
   no `summary` when no tools are registered, so `text` was `""` while the event
   stream carried the whole answer — a result contradicting its own stream.
   Found by the AC9 positive control, which exists precisely so the absence
   assertions cannot pass against a surface that emits nothing.
3. **My redaction test claimed more than the code does.** It planted a generic
   40-character string and asserted its absence; no detector matches that shape.
   The claim is now scoped to what `src/security`'s detectors recognise, because
   redaction here is exactly as good as those detectors and a wider claim would
   be a claim about a different module.

## D7 — the `ask` boundary is enforced by the policy engine, not by the transport

Closing AC5 turned up the reason it could not have been confirmed by inspection.
`src/harness/policy/engine.ts` step 6 fails an `ask` closed whenever the context
is non-interactive, and a remote turn is non-interactive by construction —
nobody is present to answer. So the transport **never sees an `ask` at all**. It
sees a `deny` carrying `matchedRules: ["headless-fail-closed",
"profile:<id>:<risk>=ask"]`.

My first implementation checked `decision.decision === "ask"` and could never
fire. D3 is still right that the boundary must be stated rather than emergent —
but the statement belongs on the REPORTING, not on the denial. The engine denies;
the transport's job is to say so. Without that, the turn ends `completed` having
done nothing, and the operator is never told their request needed an approval
this release cannot ask for.

Both conditions are kept in the source. `headless-fail-closed` is the reachable
one today; `decision === "ask"` becomes reachable the moment an interactive
remote context exists, which is exactly when it must already be handled.

Two further things the fixture found:

- `unattended-untrusted` classifies `write` as `deny`, not `ask`, once the
  headless rule applies. The suite's premise test asserts the classification
  directly for that reason: every assertion under it is meaningless if the call
  is classified some other way.
- `newId: () => "fixed-id-N"` made `readTurnRecord` return null — `isTurnId`
  refused it. The turn-id containment check catching a test fixture is the
  check working.

## An ordering mistake I made and reverted

The profile checks first went in BEFORE the non-loopback check, and the recovery
suite went red: a two-fault configuration started refusing on the new check
instead of the proven one, changing which instruction the operator is handed.
Both refusals are terminal and neither is unsafe, so the order is a UX question
— and silently moving a refusal that has its own executed instruction is not a
change this slice needs. Moved to last, with the reason in the source.


- 2026-08-01T20:05:04.222Z - flow created
- 2026-08-01T20:12:53.915Z - frozen: 12 criteria; checksum recorded
- 2026-08-01T20:12:54.001Z - started
- 2026-08-01T20:38:43.999Z - task-done: T1: Collect remaining context
- 2026-08-01T20:38:44.083Z - task-done: T2: Implement per plan
- 2026-08-01T20:38:44.170Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-01T20:39:31.380Z - ac-confirmed: AC1
- 2026-08-01T20:39:31.465Z - ac-confirmed: AC3
- 2026-08-01T20:39:31.548Z - ac-confirmed: AC4
- 2026-08-01T20:39:31.634Z - ac-confirmed: AC6
- 2026-08-01T20:39:31.720Z - ac-confirmed: AC7
- 2026-08-01T20:39:31.803Z - ac-confirmed: AC8
- 2026-08-01T20:39:31.888Z - ac-confirmed: AC9
- 2026-08-01T20:39:31.969Z - ac-confirmed: AC10
- 2026-08-01T20:39:32.054Z - ac-confirmed: AC11
- 2026-08-01T20:39:32.140Z - ac-confirmed: AC12
- 2026-08-01T20:40:06.222Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/220
- 2026-08-01T20:58:25.790Z - ac-confirmed: AC2
- 2026-08-01T20:58:25.880Z - ac-confirmed: AC5
- 2026-08-01T20:58:25.965Z - task-done: T4: Self-review and prepare draft PR
