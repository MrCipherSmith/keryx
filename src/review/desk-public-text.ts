// Only public assistant messages and explicitly selected display fields reach Desktop.
import { redactSensitiveText } from "../security/service";
import type { ParsedResult } from "./ledger";

export function publicReviewText(value: string, limit: number): string {
  return redactSensitiveText(value).slice(0, limit);
}

/** A read can name its source file, but never carries a directory, query, command, or contents. */
export function publicReadFile(input: string): string | undefined {
  try {
    const args = JSON.parse(input);
    const file = typeof args?.path === "string" ? args.path.split(/[\\/]/).at(-1) : undefined;
    if (typeof file === "string" && /^[\w-][\w.-]{0,90}\.(?:[cm]?[jt]sx?|json|md|txt|css|scss|rs|py|yaml|yml|toml|snap)$/i.test(file)) {
      return publicReviewText(file, 96);
    }
  } catch { /* Malformed or clipped arguments reveal only the tool name. */ }
  return undefined;
}

export function reviewerContextRequest(result: ParsedResult): string | undefined {
  const requests = Array.isArray(result.needs_context) ? result.needs_context : [result.needs_context];
  const questions = requests.flatMap(request => {
    const question = typeof request === "string" ? request : request?.question;
    return typeof question === "string" && question.trim() ? [question.trim()] : [];
  }).slice(0, 6);
  return questions.length ? publicReviewText(questions.join("\n"), 1800) : undefined;
}

export function publicReviewerOutput(result: ParsedResult): { finalOutput?: string; outcomeReason?: string; needsContext?: true } {
  const partial = result.status === "BLOCKED" || result.status === "NEEDS_CONTEXT";
  const notes = typeof result.summary === "string" && result.summary.trim() ? [result.summary.trim()] : [];
  if (Array.isArray(result.findings)) {
    for (const finding of result.findings.slice(0, 12)) {
      if (!finding || typeof finding.problem !== "string" || !finding.problem.trim()) continue;
      const severity = ["blocker", "major", "minor", "info"].includes(String(finding.severity)) ? finding.severity + ": " : "";
      notes.push(severity + publicReviewText(finding.problem.trim(), 640));
    }
  }
  const context = partial ? reviewerContextRequest(result) : undefined;
  const reason = context || (partial ? result.summary : undefined);
  return {
    ...(result.status === "NEEDS_CONTEXT" ? { needsContext: true as const } : {}),
    ...(notes.length ? { finalOutput: publicReviewText(notes.join("\n\n"), 4800) } : {}),
    ...(typeof reason === "string" && reason.trim() ? { outcomeReason: publicReviewText(reason.trim(), 1800) } : {}),
  };
}
