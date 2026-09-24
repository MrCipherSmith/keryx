// Flow 316, T5 — the stable-pack gate's pinned provenance policy. Kept in
// its own file (rather than inline in `eval.ts`) so the two things every
// stack-pack eval report's provenance is checked against — which runner
// scored the deterministic trigger/behavior checks, and which judge scored
// the rubric-graded behavior scenarios — are named in exactly one place, not
// re-typed at each call site.
//
// The owner pinned DeepSeek (`deepseek-chat`) for BOTH roles (plan.md
// "Alternatives rejected": a free choice of grader model weakens the gate).
// A report whose `(runner, model)` or `(judge, judgeModel)` is not on these
// lists never clears `checkStablePackGate`, regardless of how clean the
// rest of the report looks.

export interface GateModelIdentity {
  readonly provider: string;
  readonly model: string;
}

export const STACK_PACK_GATE_POLICY: {
  readonly runners: readonly GateModelIdentity[];
  readonly judges: readonly GateModelIdentity[];
} = {
  runners: [{ provider: "deepseek", model: "deepseek-chat" }],
  judges: [{ provider: "deepseek", model: "deepseek-chat" }],
};

export function isAllowlistedRunner(provider: string | undefined, model: string | undefined): boolean {
  return STACK_PACK_GATE_POLICY.runners.some((entry) => entry.provider === provider && entry.model === model);
}

export function isAllowlistedJudge(provider: string | undefined, model: string | undefined): boolean {
  return STACK_PACK_GATE_POLICY.judges.some((entry) => entry.provider === provider && entry.model === model);
}
