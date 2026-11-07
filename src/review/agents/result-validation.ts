import { validateAgainstSchemaObject } from "../../contracts/validator";
import reviewerResultSchema from "../../gdskills/bundled/skills/review/review-orchestrator/reviewer-finding.schema.json";

function parseResult(content: string): unknown {
  // The ledger reader repairs incomplete fields; admission must validate raw JSON.
  const fences = [...content.matchAll(/^```(?:REVIEW_RESULT|json)[ \t]*\r?\n/gm)];
  const labelled = fences.filter((match) => match[0].startsWith("```REVIEW_RESULT"));
  const last = labelled.at(-1) ?? fences.at(-1);
  let json = content.trim().replace(/^REVIEW_RESULT[ \t]*:?[ \t]*\r?\n/, "");
  if (last !== undefined) {
    const tail = content.slice(last.index! + last[0].length);
    const end = /^```[ \t]*\r?$/m.exec(tail);
    if (end === null) throw new Error("invalid_review_result: unclosed result fence");
    json = tail.slice(0, end.index).trim();
  }
  try { return JSON.parse(json); }
  catch { throw new Error("invalid_review_result: no parseable REVIEW_RESULT"); }
}

/** Validate the contract while preserving the raw adapter reply for export. */
export function reviewAgentResultStatus(content: unknown): "completed" | "blocked" {
  let payload = content;
  if (typeof content === "object" && content !== null && !Array.isArray(content)) {
    const envelope = content as Record<string, unknown>;
    if ("submittedResult" in envelope) payload = envelope.submittedResult;
    else if ("text" in envelope) payload = envelope.text;
  }
  const result: unknown = typeof payload === "string" ? parseResult(payload) : payload;
  if (result === undefined) throw new Error("invalid_review_result: no parseable REVIEW_RESULT");
  const validation = validateAgainstSchemaObject(reviewerResultSchema, result);
  if (!validation.valid) {
    throw new Error(`invalid_review_result: ${JSON.stringify(validation.errors.slice(0, 8))}`);
  }
  const validated = result as { status: string; inputs_unreadable?: string[]; needs_context?: string[] };
  // A valid blocked reply is an artifact, not a completed review.
  return validated.status === "BLOCKED" || validated.status === "NEEDS_CONTEXT"
    || (validated.inputs_unreadable?.length ?? 0) > 0 || (validated.needs_context?.length ?? 0) > 0
    ? "blocked" : "completed";
}
