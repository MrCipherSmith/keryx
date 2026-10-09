/** Validate declared dispatch evidence, not the truth of reviewer work. */
export function dispatchErrors(value: unknown): string[] {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
  if (!object(value)) return ["reviewer dispatch evidence is missing"];
  const errors: string[] = [];
  if (value.version !== 1) errors.push("dispatch version must be 1");
  if (!strings(value.selected) || !value.selected.length || new Set(value.selected).size !== value.selected.length)
    return [...errors, "dispatch needs a nonempty unique selected reviewer inventory"];
  if (!Array.isArray(value.unresolvedRules) || value.unresolvedRules.length) errors.push("dispatch has unresolved rule anchors");
  if (!Array.isArray(value.runs)) return [...errors, "dispatch runs must be an array"];
  const roles = new Set<string>();
  const executions = new Set<string>();
  for (const run of value.runs) {
    if (!object(run)) { errors.push("invalid dispatch run"); continue; }
    const role = text(run.reviewer) ? run.reviewer : "<missing-reviewer>";
    if (!value.selected.includes(role) || roles.has(role)) errors.push(`${role}: unexpected or duplicate reviewer run`);
    roles.add(role);
    if (!text(run.executionId) || executions.has(run.executionId)) errors.push(`${role}: missing or shared execution identity`);
    if (text(run.executionId)) executions.add(run.executionId);
    if (run.status === "not-run") {
      errors.push(`${role}: not run${text(run.notRunReason) ? ` (${run.notRunReason})` : ""}; a reviewer that did not run is never a clean pass`);
      continue;
    }
    if (run.status !== "complete" || run.scopeComplete !== true) errors.push(`${role}: reviewer scope is incomplete`);
    if (!text(run.rawEvidence)) errors.push(`${role}: raw result evidence is required`);
    if (!strings(run.ruleEvidence) || !run.ruleEvidence.length) errors.push(`${role}: resolved rule evidence is required`);
    if (typeof run.executionRequired !== "boolean") errors.push(`${role}: execution requirement must be declared`);
    if (run.executionRequired === true && (!strings(run.executionEvidence) || !run.executionEvidence.length))
      errors.push(`${role}: required execution has no evidence`);
    if (run.executionRequired === false && !text(run.executionReason)) errors.push(`${role}: non-execution needs a scope justification`);
  }
  for (const role of value.selected) if (!roles.has(role)) errors.push(`${role}: selected reviewer was not dispatched`);
  return errors;
}
