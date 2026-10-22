import { formatCompletionException, selectCompletionExceptions, type CompletionExceptionSelection, type CompletionExceptionContext } from "../flow/service";
import type { FlowService } from "../flow/service";
import { hiddenInCard } from "../lib/card-safe";
import type { OperatorConfirmSpec } from "./operator-confirm-tools";
import { CompletionConfirmationError } from "./flow-completion-confirm";

type Prepared = { id: string; gates: string[]; reason: string; mergedCommit?: string; confirmToken?: string; selected: CompletionExceptionSelection[]; context: CompletionExceptionContext };
async function defaultService(): Promise<FlowService> {
  const [{ flowServiceDeps }, { createFlowService }] = await Promise.all([import("./flow"), import("../flow/service")]);
  return createFlowService(flowServiceDeps());
}
export function flowExceptionSpec(service: () => Promise<FlowService> = defaultService): OperatorConfirmSpec<Prepared> {
  return {
    name: "flow_complete_exceptions",
    description: "Complete a flow with individually accepted failing gates. The operator sees the current refusals and reason. Mandatory gates cannot be accepted; changed refusals require a new card.",
    inputSchema: { type: "object", properties: { flow_id: { type: "string" }, accept_gates: { type: "array", items: { type: "string" } }, reason: { type: "string" }, merged_commit: { type: "string" }, confirm_token: { type: "string" } }, required: ["flow_id", "accept_gates", "reason"], additionalProperties: false },
    async buildCard(input, ctx) {
      const id = input["flow_id"], gates = input["accept_gates"], reason = input["reason"];
      if (typeof id !== "string" || !id.trim() || typeof reason !== "string" || !Array.isArray(gates) || !gates.length || !gates.every((g) => typeof g === "string")) return { refusal: "flow_id, accept_gates and reason are required" };
      const mergedCommit = typeof input["merged_commit"] === "string" ? input["merged_commit"] : undefined;
      const confirmToken = typeof input["confirm_token"] === "string" ? input["confirm_token"] : undefined;
      const check = await (await service()).checkComplete({ cwd: ctx.projectRoot, id, mergedCommit, confirmToken });
      if (!check.transition.allowed) return { refusal: check.transition.detail };
      const choice = selectCompletionExceptions(check.gates, gates, reason);
      if (!choice.ok) return { refusal: choice.error };
      if (choice.remaining.length) return { refusal: `Unaccepted failures: ${choice.remaining.join(", ")}` };
      const lines = [...choice.exceptions.map(formatCompletionException), `Context: ${JSON.stringify(check.exceptionContext)}`];
      if ([id, ...lines].some(hiddenInCard)) return { refusal: "Hidden characters in exception text" };
      return { title: `Complete flow ${id} with exceptions?`, subject: `flow ${id}`, lines,
        prepared: { id, gates, reason, ...(mergedCommit ? { mergedCommit } : {}), ...(confirmToken ? { confirmToken } : {}), selected: choice.exceptions, context: check.exceptionContext } };
    },
    async apply(_input, ctx, confirmation, prepared) {
      if (!prepared) return { output: "No exception completion prepared", isError: true };
      const result = await (await service()).complete({ cwd: ctx.projectRoot, id: prepared.id, acceptGates: prepared.gates, reason: prepared.reason,
        mergedCommit: prepared.mergedCommit, confirmToken: prepared.confirmToken,
        confirmExceptions: async (current, context) => {
          if (JSON.stringify(current) !== JSON.stringify(prepared.selected) || JSON.stringify(context) !== JSON.stringify(prepared.context)) throw new CompletionConfirmationError("Refusals changed; ask again.");
          return { operatorWords: confirmation.answer, confirmedVia: "shell-card" };
        },
      });
      return { output: `flow ${prepared.id}: ${result.passed ? "done with exceptions" : "not completed"}`, isError: !result.passed };
    },
  };
}
