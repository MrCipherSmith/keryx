# Harden the harness

Status: formalized
Source: README-against-source audit (PRs #245, #246; issues #241–#244)

## Problem

A claim-by-claim audit of the README against source found five places where the
harness is built but not reachable, or reachable but not doing what it says. The
documentation has been corrected; this flow closes the gaps in the code.

One of them is a live security weakness; the rest are safety mechanisms that
cannot fire, and finished code with no entry point.

**1. The Linux sandbox escape hatch defeats the guarantee it documents.**
`KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` covers two different failure modes with one
flag. A missing launcher is a degradation a user can knowingly accept. But on
Linux with `network=restricted` — the domain-allowlist posture, which is
macOS-only — the wrap is refused, `failClosed` is false because
`defaultSandboxProfile` never sets `required`, and the command falls through to
`inner.spawn` **uncontained** (`adapter.ts:57,86`) while the allowlist proxy has
already started and `HTTP(S)_PROXY` has already been merged into the command env
(`harness.ts:726-742`). The caller asked to restrict egress to a domain list and
received no containment plus an ignorable proxy. That is not weaker containment,
it is the opposite of what was requested, and the limitations table explicitly
promises it cannot happen.

**2. The mutation security scanner cannot fire.** `scanAvailable` is a
fail-closed capability signal — `guard.ts:308` denies when it is `false` — and
the only production call site pins it to `true` (`harness.ts:787`). The real
scanner seam (`guardOutput`/`redactRaw`, `src/security/guard.ts:86,129`) is wired
into memory, wiki, testing, metrics, ctx and MCP, but never into any harness
mutation path. The safety catch is jammed open.

**3. The completion gate never learns what a flow requires.** The gate is real
and blocking — it fails on a timed-out or overflowed tool, a failed redaction,
and a missing final message. But `run.ts:428` passes `requiredEvidenceRefs: []`
and `requiredGates: []`, both hardcoded, so `evidence:required-present` computes
over an empty set and can only pass. Evidence ids themselves are honest: the run
loop mints them per recorded tool result (`run.ts:410`), so nothing the model
emits can forge one. The gap is the requirement side, not the evidence side.

**4. Branching has no user surface.** `forkBranch` is complete, deterministic,
offline and tested; merge is deliberately out of scope for v1. It is never
called outside its own tests — no slash command, no CLI verb, and the shell
never sets `parentSessionId`.

**5. Replay has no entry point.** The module is correct for what its own header
declares — `mode: "validate-log"`, a fixture integrity check, with Release 0
never selecting `isolated-re-execute`. The README oversold it as divergence
detection and has been corrected. But `buildReplayFixture`/`replayOffline` are
called from nowhere in `src/` outside their own tests, so even the integrity
check it does implement is unavailable.

## Expected Outcome

- A `network=restricted` profile fails closed on Linux regardless of any
  environment variable, while the missing-launcher escape hatch survives.
- The security scanner runs on the harness mutation path, and `scanAvailable`
  reflects whether it is actually there.
- A flow's frozen acceptance criteria reach the completion gate.
- Branching and replay-fixture validation are reachable from the CLI.

## Out of Scope

- **Real replay** (`simulate-recorded-results`): re-running recorded provider
  and tool fixtures through the loop and diffing state transitions. This is the
  feature the README originally described and it is worth building — half the
  machinery exists, since `FakeProvider` already replays recorded transcripts —
  but it is weeks of work and belongs in its own flow. This flow only makes the
  existing `validate-log` capability reachable.
- **Branch merge.** Excluded from v1 by design (`branch.ts:17-18`); not revisited
  here.
- Anything in the harness beyond these five.
