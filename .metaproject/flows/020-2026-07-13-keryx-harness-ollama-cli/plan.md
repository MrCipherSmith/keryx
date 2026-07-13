# Implementation Plan — Flow 020 (Ollama provider + keryx harness CLI)

Status: scoped increment (beyond Release 1) — live-testable

## Approach

Add a local Ollama `ProviderPort` adapter (OpenAI-compat SSE, thin fetch, no SDK) +
a narrow additive egress opt-in (`allowLoopback`, loopback-only) + a `keryx harness run`
CLI that drives `runOffline` with a selectable provider, test-first. Reuse the W14
adapter structure + W15 egress guard. Automated tests stay OFFLINE (recorded transcripts
+ mocked fetch); a live smoke run against the local Ollama proves end-to-end.

## Worker routing & Model Policy

| Task | Kind | Worker | Model | Reviewer |
|---|---|---|---|---|
| T5 (RED) | test | tests-creator | **Sonnet** | provider/security |
| T6 (impl) | implement | task-implementer | **Opus 4.8** | provider/security |
| T7 (security review) | review | review-orchestrator | **Opus 4.8** | security/provider/contract |
| T8 (live smoke) | verify | orchestrator | — | — |
| T2/T3/T4 | umbrella | orchestrator | Opus | — |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, worktree-guard.

## Steps

1. T1: adapter/CLI map + egress opt-in design + reuse surface (context.md).
2. T5 (RED): Ollama adapter offline transcript tests (normalization + provider negatives
   + storage-off) + egress opt-in tests (default loopback deny preserved; `allowLoopback`
   permits loopback only; metadata still denied) + CLI offline test (fake provider).
3. T6 (GREEN): `ollama/{ollama-provider,normalize}.ts` + additive `isLoopbackHost` +
   opt-in branch + `src/commands/harness.ts` + `src/cli.ts` registration. Make T5 green.
4. T7 (security review): egress opt-in is narrow (adversarial — can a public-looking host
   reach a private one? can `allowLoopback` reach metadata/private-LAN? can an untrusted
   destination piggyback the opt-in?); adapter conformance + negatives fail-closed; CLI
   wiring correct; offline determinism; reuse-only; deps `{}`; frozen untouched.
5. T8 (live smoke): `bun ./src/cli.ts harness run --provider ollama --model llama3.1:latest
   "..."` against the local server; capture the end-to-end output. (Manual; not in CI.)
6. `keryx health run`; confirm ACs; completion (option B).

## Verification

Gate: `tsc` clean; full `bun test` ≥1160 + new green and OFFLINE; the egress opt-in
re-permits LOOPBACK only (metadata/private-LAN still denied, proven by tests); the Ollama
adapter conforms to ProviderPort + normalizes a recorded transcript; the CLI runs offline
via `fake`; deps `{}`; no live network in the suite; the live smoke succeeds end-to-end.

## Risks

- **Egress opt-in weakens SSRF** → `allowLoopback` re-permits LOOPBACK only, per-grant, for
  its own base URL; `isLoopbackHost` excludes metadata/link-local/private-LAN; T5/T7 prove
  a metadata host is denied even WITH the opt-in, and a loopback host is denied WITHOUT it.
- **A test hits the live network** → recorded transcripts + mocked fetch; T7 confirms no
  un-mocked fetch; the live smoke is a separate manual step.
- **A new dependency / SDK sneaks in** → thin fetch, no SDK; `dependencies` stays `{}`.
- **Rewriting W14/W15** → additive only (isLoopbackHost export + opt-in branch + CLI reg);
  the Anthropic adapter's default egress is unchanged; large refactor → STOP + report.
- **CLI non-determinism leaks into tests** → the CLI's live path uses real clock/id, but its
  OFFLINE test uses the fake provider + is asserted deterministically (or asserts structure,
  not exact ids); the deterministic runOffline test path is untouched.
- **Wrong-worktree / index-guard** → guard directives in every dispatch.
