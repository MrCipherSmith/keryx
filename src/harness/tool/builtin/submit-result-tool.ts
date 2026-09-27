// `submit_result` — the only tool a subagent is offered in its budget wrap-up
// round (flow 347 T7, AC5). Only the definition and the input validator live
// here; the round itself is driven by `finishWithSubmitResult` in
// `src/commands/agent.ts`, which never executes any other tool in that round.

import type { NormalizedToolDefinition } from "../../provider/types";

/** Name of the only tool offered in a subagent's budget wrap-up round. */
export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

/** A validated `submit_result` input. */
export interface SubmittedResult {
  status: "partial";
  summary: string;
  /** The task's result payload, in whatever shape the task text asked for. */
  result: string | Record<string, unknown> | unknown[];
}

/**
 * The `submit_result` tool definition. No provider in this codebase exposes a
 * forced tool choice (`NormalizedRequest` has no such field), so the wrap-up
 * round forces it the only portable way: this is the ONLY tool in the request,
 * the round is instructed to call it, and the input is validated by
 * {@link parseSubmitResultInput} rather than trusted.
 */
export const SUBMIT_RESULT_TOOL_DEFINITION: NormalizedToolDefinition = {
  name: SUBMIT_RESULT_TOOL_NAME,
  description:
    "Submit your result now. Your budget is exhausted and this is your final round: call this " +
    "tool exactly once with status 'partial', a summary of what you did and found, and the " +
    "result payload in the format your task asked for (a string, or a JSON object).",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["partial"] },
      summary: { type: "string" },
      result: { type: ["string", "object", "array"] },
    },
    required: ["status", "summary", "result"],
    additionalProperties: false,
  },
  risk: "read",
};

/**
 * Validate a raw `submit_result` input string against
 * {@link SUBMIT_RESULT_TOOL_DEFINITION}'s schema. Returns the result, or the
 * reason it was rejected.
 */
export function parseSubmitResultInput(raw: string): { ok: true; value: SubmittedResult } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "input is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "input is not a JSON object" };
  }
  const input = parsed as Record<string, unknown>;
  const extra = Object.keys(input).filter((key) => key !== "status" && key !== "summary" && key !== "result");
  if (extra.length > 0) {
    return { ok: false, reason: `unexpected field(s): ${extra.join(", ")}` };
  }
  if (input.status !== "partial") {
    return { ok: false, reason: "status must be \"partial\"" };
  }
  if (typeof input.summary !== "string" || input.summary.trim().length === 0) {
    return { ok: false, reason: "summary must be a non-empty string" };
  }
  const result = input.result;
  if (typeof result !== "string" && (typeof result !== "object" || result === null)) {
    return { ok: false, reason: "result must be a string, an object or an array" };
  }
  return {
    ok: true,
    value: { status: "partial", summary: input.summary, result: result as SubmittedResult["result"] },
  };
}
