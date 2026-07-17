# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `src/harness/policy/metaproject-escalation.ts` exports a `MetaprojectPolicyContext` type ({ blastRadius?: number; affected?: string[] }) and a pure `escalateForBlastRadius(decision: PolicyDecision, ctx: MetaprojectPolicyContext, threshold: number): PolicyDecision` that returns `decision` UNCHANGED unless `decision.decision === "allow"` AND `threshold > 0` AND `ctx.blastRadius !== undefined` AND `ctx.blastRadius >= threshold`, in which case it returns a decision with `decision: "ask"` and a reason indicating a blast-radius escalation. Deterministic; no side effects.
- AC2: Non-weakening property — for ANY input, `escalateForBlastRadius` NEVER returns a MORE permissive decision than its input: an `ask` input returns `ask`, a `deny` input returns `deny`, and an `allow` input returns `allow` or `ask` (never turns `ask`/`deny` into `allow`). A unit test asserts this across allow/ask/deny inputs with high and low blast radius and with threshold 0/undefined (no-op) — proving ADR-0003's "never weaken" is preserved.
- AC3: `metaprojectBlastRadius(port: MetaprojectPort, target: string): Promise<number>` returns the number of affected files from `port.graphAffected({target})` (0 when there are none, on a structured error, or on a thrown error — best-effort, never throws). Unit-tested with an injected fake port (dependents -> count; error -> 0).
- AC4: No regression / frozen-code untouched — `tsc --noEmit` clean and full `bun test` >= the pre-change baseline of 1424 pass / 3 skip / 0 fail with new tests green and 0 fail; OFFLINE/deterministic; `dependencies` REMAINS `{}`; the frozen `src/harness/policy/engine.ts` `decide()`, `PolicyContext`, `PolicyProfile`, and `src/harness/run/run.ts` are NOT modified (verifiable: no diff to those symbols), and no existing allow/ask/deny outcome changes anywhere.
