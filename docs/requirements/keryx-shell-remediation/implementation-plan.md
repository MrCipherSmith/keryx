# Keryx Shell Remediation Implementation Plan
Version: 0.1.0

## Approach

Three flows, not six. The grouping is by **shared verification**, not by
convenience: each phase is proven by one coherent scenario, so splitting a phase
would mean building the same test twice and shipping half a fix in between.

```
Flow 1  P1  the agent can finish a task        D1 + D2   blocks everything else
Flow 2  P2  the scriptable door is real        D3+D4+D5  independent, small
Flow 3  P3  re-measure                          D6        needs Flow 1
```

## Flow 1 — the agent can finish a task

**Why D1 and D2 are one flow.** Fixing tool affinity alone leaves the run still
unable to complete unattended, so nothing can prove the fix worked. Fixing the
unattended mode alone lets the agent finish — by approving the shell round-trip
it should not have taken, which passes the scenario for the wrong reason and
hides D1. Only together do they produce the assertion that matters:
*answered correctly, through the native tool, with nobody at the terminal.*

**Order inside the flow.** Unattended posture first, tool affinity second. The
posture is what makes the failure observable in a test at all; without it, every
tool-affinity experiment ends in the same stall and tells you nothing.

**The trap to avoid.** The cheap way to pass AC-P1-1 is a blanket `--yes`. That
would trade away the single property this benchmark demonstrated keryx has —
every C-group case stopped because the shell is default-deny. AC-P1-3, AC-P1-4
and AC-P1-5 exist to fail the flow if that happens, and AC-P1-7 exists to fail it
if the *default* is loosened to make the flag look good.

**Done when:** benchmark case A1 runs scripted, answers correctly, uses the
native graph tool, and C1/C3 still refuse under the same mode.

## Flow 2 — the scriptable door is real

Three small, unrelated corrections that share a file and a test surface, which is
the only reason they travel together:

1. Register tools on the non-interactive path (D3).
2. Validate providers against `OPENAI_COMPAT_PROVIDERS` rather than a literal set
   (D4), and correct `cli-reference.md` in the same change — a code fix that
   leaves the doc wrong has only moved the divergence.
3. Stop defaulting to an undeclared model id (D5).

**Done when:** `harness run` accepts every registry provider, refuses an unknown
one, can execute a read-only tool, and the reference matches.

## Flow 3 — re-measure

Only after Flow 1. Apply the four catalog corrections from the run report, then
run groups A, B and D to completion and publish.

**Done when:** every case has a verdict or a recorded skip reason, the
transitive-count discrepancy is adjudicated, and a report exists whatever it says.

## Dependencies

- Flow 1 → nothing.
- Flow 2 → nothing. Can run in parallel with Flow 1.
- Flow 3 → Flow 1. Running it earlier re-measures the stall.

## Out of scope for every flow

- Weakening a `deny`, or introducing any path that reaches one.
- Rewriting a shell call into a tool call behind the model's back.
- Touching graph, wiki, memory or health implementations — the benchmark
  exercised them and found no fault in any of them.
- Any performance claim.
