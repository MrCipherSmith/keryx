import { canonicalDigest, type Control } from "../../remote-control/protocol";
import { inspectLegacyFlowPins } from "../legacy-flow-pins";
import { assertLegacyFlowWritable, buildRevisionRecord, fail } from "../domain";
import type { HubState } from "../store";
import type { RemoteRepository } from "./storage";
import type { MachineRecord, RunRow } from "./model";
import { id, iso, version } from "./guards";
const secretPattern = /(?:-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b)/;
/** The managed pins of a run that the current Flow no longer matches. The result keeps the run's original snapshot; drift is recorded, never repaired. */
function pinDrift(state: HubState, association: Control["FlowAssociation"]): NonNullable<RunRow["pinDrift"]> {
  if (association.mode !== "flow") return [];
  return inspectLegacyFlowPins(state,association).drift;
}
export function resultUpload(state: HubState, repo: RemoteRepository, machine: MachineRecord, projectId: string, runId: string, body: Control["ResultUpload"], key: string): Control["ResultReceipt"] {
  const run = repo.get<RunRow>("remote_run", runId);
  if (!run || run.machineId !== machine.machineId || run.projectId !== projectId || !machine.projectIds.includes(projectId)) fail(404, "not-found", "Run not found");
  const previous = repo.get<{ payloadDigest: string; key: string; receipt: Control["ResultReceipt"] }>("remote_result_receipt", runId);
  const payloadDigest = canonicalDigest(body);
  if (previous) { if (previous.payloadDigest !== payloadDigest) fail(409, "payload-conflict", "Immutable result changed"); return previous.receipt; }
  if(run.association.mode==='flow')assertLegacyFlowWritable(state,projectId,run.association.flowId);
  version(run.version, body.expectedRunVersion);
  if (body.sessionId !== run.sessionId || body.turnId !== run.turnId || canonicalDigest(body.association) !== canonicalDigest(run.association)) fail(409, "stale-reference", "Result ownership or association changed");
  if (!["succeeded", "failed", "cancelled"].includes(run.state) || body.outcome !== run.state) fail(409, "stale-reference", "Result requires confirmed matching terminal observation");
  if (body.outcome !== "succeeded" && !body.partial && body.changes.length) fail(400, "invalid-result", "Failed or cancelled changes must be labeled partial");
  for (const change of body.changes) if ("contentBase64" in change && secretPattern.test(Buffer.from(change.contentBase64, "base64").toString("utf8"))) fail(400, "secret-screening", "Result contains protected material; retain it locally");
  for (const check of body.checks) if (secretPattern.test(check.output) || secretPattern.test(check.command)) fail(400, "secret-screening", "Check contains protected material; retain it locally");
  // A changed spec during execution stays visible on the run and its review-only revision; Flow review submission refuses the changed spec on its own.
  const drift = pinDrift(state, run.association);
  const message = `Remote ${run.state} result ${runId}${drift.length > 0 ? `; pinned Flow ${drift.join(" and ")} changed during execution, original snapshot kept` : ""}`;
  const revision = buildRevisionRecord(state, projectId, `machine:${machine.machineId}`, { baseRevisionId: null, gitBaseSha: body.gitBaseSha, message, purpose: "review-bundle", changes: body.changes });
  let evidenceId: string | null = null;
  const flowId = run.association.mode === "flow" ? run.association.flowId : null;
  if (flowId) {
    const flow = state.flows.find((entry) => entry.id === flowId && entry.projectId === projectId);
    if (!flow) fail(409, "stale-reference", "Pinned Flow no longer exists");
    for (const check of body.checks) {
      const entry = { id: id(), projectId, flowId, subjectRevisionId: revision.id, checkId: check.checkId, command: check.command, exitCode: check.exitCode, output: redact(check.output).slice(0, 65536), actorId: `machine:${machine.machineId}`, provenance: "self-reported" as const, createdAt: iso() };
      state.evidence.push(entry); evidenceId ??= entry.id;
    }
    // An empty actual-check set cannot manufacture a successful Evidence report.
    if (!evidenceId) fail(409, "evidence-required", "Managed result needs actual check provenance");
  } else {
    for (const check of body.checks) repo.put("remote_run_check", `${runId}:${check.checkId}`, { ...check, output: redact(check.output), actorId: `machine:${machine.machineId}`, provenance: "self-reported", createdAt: iso() }, { projectId, machineId: machine.machineId, sessionId: run.sessionId, runId });
  }
  const receipt: Control["ResultReceipt"] = { receiptId: id(), runId, turnId: run.turnId, sessionId: run.sessionId, revisionId: revision.id, checksKind: flowId ? "FlowEvidence" : "RunChecks", flowId, evidenceId, partial: body.partial };
  repo.put("remote_result_receipt", runId, { payloadDigest, key, receipt }, { projectId, machineId: machine.machineId, sessionId: run.sessionId, runId });
  run.result = receipt; run.partial = body.partial; if (drift.length > 0) run.pinDrift = drift; run.version++; run.notificationVersion = (run.notificationVersion ?? 0) + 1; repo.put("remote_run", runId, run, { projectId, machineId: machine.machineId, sessionId: run.sessionId, runId });
  state.events.push({ sequence: (state.events.at(-1)?.sequence ?? 0) + 1, projectId, type: "revision-created", actorId: `machine:${machine.machineId}`, entityId: revision.id, createdAt: iso() });
  return receipt;
}
// eslint-disable-next-line no-control-regex -- Remove ANSI escapes and unsafe raw control bytes at ingestion.
export function redact(text: string): string { return text.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ""); }
