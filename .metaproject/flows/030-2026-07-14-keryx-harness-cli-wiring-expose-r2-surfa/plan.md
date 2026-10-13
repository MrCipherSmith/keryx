# Implementation Plan — Flow 030 (keryx harness CLI wiring)

Status: frozen scope (3 new subcommands: exec / extension / wave)

## Approach

Add three `keryx harness` subcommands (`exec`, `extension`, `wave`) that compose the R2 library
functions, mirroring `harness.ts`'s existing `run` command (injectable deps, fail-closed guards,
structured JSON output, never persists flow.json). Test-first. The real subprocess is gated behind
`--allow-real-subprocess`/`KERYX_ALLOW_REAL_SUBPROCESS` and the offline suite injects a fake adapter.
Reuse-only; deterministic; deps `{}`.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | security |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | security |
| T7 (review) | review | review-orchestrator | **Opus 4.8** | security |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via subagent-dispatch → subagent-result, worktree-guard
(`cd ~/goodea/keryx`, branch `feature/keryx-harness-cli-wiring`).

## Steps

1. T1: scope + the `harness.ts` reuse pattern + the R2 input shapes (description.md/context.md).
2. T5 (RED): CLI command tests (OFFLINE, injected deps — clock/idSeq/env + a fake process adapter +
   an injected spec):
   - **exec**: without the allow-real flag → a refusal (no adapter constructed, no spawn); WITH an
     injected `FakeProcessAdapter` (deps) → a clean-exit prints `{outcome:{kind:"completed",…}, receipt,
     evidenceRefs}`; a fake timeout/overflow/cancel → the matching non-success outcome; an unapproved
     argv/env / a budget breach → `{outcome:{kind:"blocked"}}` (fail-closed, spawn not called); the
     command prints ONE JSON blob as its last line and NEVER writes flow.json.
   - **extension**: a valid injected spec (manifest+grant+task) → `{registration:{ok:true}, dispatch,
     result, evidenceRefs}` (canonical); an invalid/denied registration → a fail-closed error result
     (no dispatch); an escalating grant without policy+provenance+approval → denied.
   - **wave**: a valid spec (registered tasks + config) → `{ok:true, waves:[…]}` bounded (≤ maxConcurrency,
     aggregate budget); an unregistered task / cycle / budget breach → `{ok:false, reason}`.
   - a flag-gated real-exec smoke (`KERYX_ALLOW_REAL_SUBPROCESS=1`) — CI-inert (skipIf), runs `/bin/echo`.
   RED before T6.
3. T6 (GREEN): implement the three subcommands in `src/commands/harness.ts` (+ small helpers or sibling
   modules) and route them in `src/cli.ts`; extend usage/`--help`. Reuse `runContainedProcess` +
   `RealProcessAdapter`/fake, `registerExtension`+`dispatchExtension`, `planExtensionWave`. Injectable
   deps (adapter/spec/clock/idSeq/env) so tests stay offline. Fail-closed guards first. Never persist
   flow.json. Make T5 green.
4. T7 (review, security): exec fail-closed (no spawn without the flag; unapproved argv/env/budget →
   blocked; adapter gated + not in the offline path); extension/wave fail-closed (unregistered/denied/
   escalation → refused); D-02 (no command writes flow.json — `ctx rg writeFlow|flow.json src/commands`);
   secrets (env values/API key) never logged; reuse-only (R2 functions + harness.ts run path unmodified
   or additive); deps `{}`; determinism (offline tests inject the adapter/spec; no real spawn in CI);
   no regression; frozen surface untouched.
5. `keryx health run`; live smoke (`KERYX_ALLOW_REAL_SUBPROCESS=1 keryx harness exec -- /bin/echo hi`);
   confirm ACs; completion (option B) + PR (no co-authorship).

## Verification

Gate: `tsc` clean; full `bun test` ≥ baseline (1338/2skip/0) + new green; `keryx harness exec` refuses
without the flag and (with a fake adapter in tests / the real flag live) runs a contained command
printing a typed outcome + receipt + evidence; `keryx harness extension` registers+dispatches a
canonical result; `keryx harness wave` plans a bounded wave; every command prints one JSON blob and
writes no flow.json; deterministic offline; no real spawn in CI; no new dependency.

## Risks

- **exec spawns without the flag** → the RealProcessAdapter is constructed ONLY behind the flag; without
  it the command refuses before building the adapter; T5/T7 assert no spawn.
- **A command persists flow.json (D-02 break)** → mirror `harness.ts` (returns/prints only); T7 greps.
- **guardAction/allowlist can't be built for a real exec** → construct an allowlist/GuardInput that
  permits the user's argv while keeping the injection scan; if `runContainedProcess`'s allowlist gate
  can't be satisfied without changing the library, STOP and report.
- **Secrets in output** → env VALUES never printed; only allowlisted KEYS and typed outcomes; T7 checks.
- **Non-determinism / real spawn in CI** → offline tests inject a fake adapter + spec; the real path is
  flag-gated + skipIf; no Date.now/Math.random in the command core beyond the injectable clock/id.
- **New dep** → child_process is stdlib; deps `{}`.
- **Rewriting R2 libs** → compose only; STOP-and-report guard.
- **Wrong-worktree / index-guard** → guard directives in every dispatch.
