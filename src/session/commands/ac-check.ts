// `/ac <flowId> check` and `/flows <flowId> check`: the Flow inspector's `c` key (tui-shell.ts onRunCheck), which runs
// `runCheckAc` for the selected local Flow. Natively the check takes the deterministic path the TUI takes when Jev is not
// configured (Jev is a security-local setup boundary there, specification 3.1), reads git only through the session's owned,
// hardened read port, and writes no cache file: the owned checkout admits no effect over `.metaproject/data/ac-check/`.
import { runCheckAc } from "../../commands/flow-check-ac";
import { renderAcCheckReport, summarizeVerdicts } from "../../flow/service";
import { validateArguments, type Control } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/service";
import type { NativeCommandContribution, SessionCommandContext } from "./handlers";

export const acCheckInputSchema: Control["ArgumentSchema"] = { type: "object", additionalProperties: false, properties: { flowId: { type: "string", maxLength: 200 } }, required: ["flowId"] };
export type AcCheckContext = Pick<SessionCommandContext, "cwd" | "inspection">;
export type AcCheckResult =
  | { ok: true; source: "local-native"; data: unknown }
  | { ok: false; source: "local-native"; error: { code: "invalid-arguments" | "implementation-gap" | "refused" | "cancelled" | "quota-exceeded"; message: string } };

function failure(code: Extract<AcCheckResult, { ok: false }>["error"]["code"], message: string): AcCheckResult {
  return { ok: false, source: "local-native", error: { code, message } };
}
const safe = (context: AcCheckContext, text: string) => redactSensitiveText(text.replaceAll(context.cwd, "."));

/** One advisory check of a local Flow's frozen criteria: never changes Flow state, never confirms an AC. */
export async function executeAcCheck(context: AcCheckContext, input: unknown): Promise<AcCheckResult> {
  if (!validateArguments(acCheckInputSchema, input).ok) return failure("invalid-arguments", "Name the local Flow to check: /ac <flowId> check");
  const gitSpawn = context.inspection?.analysisRead?.acCheckGit; const signal = context.inspection?.signal;
  if (gitSpawn === undefined || signal === undefined) return failure("implementation-gap", "The native owned git read is not attached to this session; nothing was checked.");
  const { flowId } = input as { flowId: string };
  try {
    const result = await runCheckAc(context.cwd, flowId, { askJev: false, persist: false, signal }, { gitSpawn });
    const text = renderAcCheckReport({ flowId: result.flowId, verdicts: result.verdicts, jevAsked: result.jevAsked, ...(result.usage === undefined ? {} : { usage: result.usage }),
      at: result.at, criteriaChecksum: result.criteriaChecksum, diffHash: result.diffHash });
    const data = JSON.parse(safe(context, JSON.stringify({ flowId: result.flowId, cached: result.cached, jevAsked: result.jevAsked, acCheckEnabled: result.acCheckEnabled, at: result.at,
      criteriaChecksum: result.criteriaChecksum, diffHash: result.diffHash, summary: summarizeVerdicts(result.verdicts), verdicts: result.verdicts, text }))) as unknown;
    return Buffer.byteLength(JSON.stringify(data)) <= 30000 ? { ok: true, source: "local-native", data }
      : failure("quota-exceeded", "The acceptance-criteria report exceeds the remote command result limit; run the check locally.");
  } catch (cause) {
    if (signal.aborted) return failure("cancelled", "The acceptance-criteria check was cancelled; no result is asserted.");
    // The TUI shows the check's own error in place (tui-shell.ts onRunCheck); the same words, refused.
    return failure("refused", `acceptance-criteria check failed: ${safe(context, cause instanceof Error ? cause.message : String(cause))}`);
  }
}

export function acCheckCommands(): NativeCommandContribution[] {
  return [{
    entry: { commandName: "ac.check", summary: "Check a local Flow's frozen acceptance criteria against its change (advisory, deterministic)", handlerId: "native.project.ac.check",
      inputSchema: acCheckInputSchema, resultSchema: { type: "string", maxLength: 32768 }, mutationClass: "read", states: ["idle", "busy", "paused"], busyPolicy: "read-only",
      confirmation: "none", availability: "available", reason: "shared-existing-ac-check-engine" },
    execute: (context, request) => executeAcCheck(context, request.arguments),
  }];
}
