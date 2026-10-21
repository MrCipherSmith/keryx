import { expect, test } from "bun:test";
import { confirmCompletionExceptions, acceptedGateArgs } from "./flow-completion-confirm";
import { flowExceptionSpec } from "./operator-confirm-flow-exceptions";
import type { FlowService } from "../flow/types";

const selected = [{ gate: "health" as const, detail: "released regression", reason: "already shipped" }];

test("accept-gate is repeatable and comma separated", () => {
  expect(acceptedGateArgs(["469", "--accept-gate", "health,review:head-commit", "--accept-gate=security"])).toEqual(["health", "review:head-commit", "security"]);
  expect(() => acceptedGateArgs(["--accept-gate"])).toThrow();
});

test("terminal asks about exact failures and preserves the operator's words", async () => {
  const result = await confirmCompletionExceptions([], selected, "469", "/tmp", {
    env: {}, isTerminal: true, readAnswer: async (question) => {
      for (const text of ["469", "health", "released regression", "already shipped"]) expect(question).toContain(text);
      return "да";
    },
  });
  expect(result).toEqual({ operatorWords: "да", confirmedVia: "terminal" });
  await expect(confirmCompletionExceptions([], selected, "469", "/tmp", { env: {}, isTerminal: false })).rejects.toThrow();
  await expect(confirmCompletionExceptions([], selected, "469", "/tmp", { env: { KERYX_TOOL_CALL: "1" }, isTerminal: true })).rejects.toThrow();
});

test("exception card rejects changed refusals before completing", async () => {
  let completed = false;
  const service = {
    checkComplete: async () => ({ transition: { allowed: true }, gates: [{ name: "health", status: "fail", detail: "released regression" }] }),
    complete: async (input: Parameters<FlowService["complete"]>[0]) => {
      await input.confirmExceptions?.([{ ...selected[0]!, detail: "new failure" }]); completed = true;
    },
  } as unknown as FlowService;
  const spec = flowExceptionSpec(async () => service);
  const ctx = { projectRoot: "/tmp", env: {}, now: () => new Date() };
  const card = await spec.buildCard({ flow_id: "469", accept_gates: ["health"], reason: "already shipped" }, ctx);
  if ("refusal" in card) throw new Error(card.refusal);
  await expect(spec.apply({}, ctx, { answer: "yes" } as never, card.prepared)).rejects.toThrow();
  expect(completed).toBe(false);
});


test("exception card forwards the operator answer, not the rendered question, to completion", async () => {
  const service = {
    checkComplete: async () => ({ transition: { allowed: true }, gates: [{ name: "health", status: "fail", detail: "released regression" }] }),
    complete: async (input: Parameters<FlowService["complete"]>[0]) => {
      const decision = await input.confirmExceptions?.(selected);
      expect(decision).toEqual({ operatorWords: "yes", confirmedVia: "shell-card" });
      return { passed: true };
    },
  } as unknown as FlowService;
  const spec = flowExceptionSpec(async () => service);
  const ctx = { projectRoot: "/tmp", env: {}, now: () => new Date() };
  const card = await spec.buildCard({ flow_id: "469", accept_gates: ["health"], reason: "already shipped" }, ctx);
  if ("refusal" in card) throw new Error(card.refusal);
  const result = await spec.apply({}, ctx, {
    answer: "yes", quote: "Complete flow 469 with exceptions?: yes",
  } as never, card.prepared);
  expect(result.isError).toBe(false);
});
