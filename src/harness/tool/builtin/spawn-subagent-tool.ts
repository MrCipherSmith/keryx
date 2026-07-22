// Interactive `spawn_subagent` tool — wires MAE `spawnSubagent` into the shell agent.
//
// The model proposes a bounded child task. The host:
//   1) fail-closed spawn via RemainingBudgetLedger + spawnSubagent
//   2) runs a read-only (or general read-mostly) agent turn
//   3) returns a quarantined summary to the parent
//
// Risk: `delegate` (agent driver requires approval when an approver is present).

import { createHash, randomUUID } from "node:crypto";
import type { InteractiveTool, InteractiveToolResult } from "./interactive-tools";
import { builtinReadOnlyTools } from "./interactive-tools";
import { makeKeryxRunner, builtinMetaprojectTools } from "./metaproject-tools";
import { createMetaprojectAdapter } from "../metaproject-adapter";
import { RemainingBudgetLedger } from "../../child/ledger";
import { spawnSubagent, foldChildSummary, DEFAULT_MAX_CHILDREN } from "../../child/orchestrate";
import type { SubagentContext } from "../../child/orchestrate";
import type { PolicyProfile } from "../../policy/types";
import type { Provenance } from "../../session/types";
import { runAgentTurn, type AgentDeps, type AgentIO } from "../../../commands/agent";
import type { ProviderPort } from "../../provider/types";
import { emitSubagentFleet } from "../../../tui/subagent-bridge";

export type SubagentMode = "read_only" | "general";

/**
 * Hard cap on a child summary before it enters the parent's history.
 *
 * A child's text is `trustLevel: "derived"` and lands verbatim in the parent's
 * next prompt. Uncapped, a child (or a provider echoing attacker-controlled
 * text) can flood the parent's context: the flow-115 stress run returned
 * 1.5 MB this way. `quarantineChildSummary` flags instruction-shaped text but
 * deliberately never shortens it, so the bound has to be applied here.
 */
const MAX_CHILD_SUMMARY_CHARS = 16_000;

/** Bound a child summary, marking the cut so the parent can see it happened. */
function boundSummary(text: string): string {
  if (text.length <= MAX_CHILD_SUMMARY_CHARS) {
    return text;
  }
  const dropped = text.length - MAX_CHILD_SUMMARY_CHARS;
  return `${text.slice(0, MAX_CHILD_SUMMARY_CHARS)}\n…(truncated: ${dropped} more characters from the subagent)`;
}

export interface SpawnSubagentToolDeps {
  cwd: string;
  /** Parent provider/model (inherited by child unless MAE resolves otherwise). */
  getParentModel: () => { providerId: string; modelId: string; baseUrl?: string };
  /** Build a ProviderPort for a resolved provider/model. */
  makeProvider: (providerId: string, modelId: string, baseUrl?: string) => ProviderPort;
  /** Credentialed providers the child may use (detection allowlist). */
  getDetectedProviders: () => readonly { name: string }[];
  idSeq?: () => string;
  clock?: () => string;
  /** Parent run/session ids for MAE linkage (defaults generated once). */
  parentRunId?: string;
  parentSessionId?: string;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Parent shell policy. Network is `allow` because the interactive shell already
 * uses cloud LLM providers (deepseek/anthropic/…); children that *inherit* the
 * parent model must not fail G2 solely for tool-isolation.
 */
function parentShellPolicy(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0",
    fingerprint: sha256("shell-parent-policy:v1"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "ask", shell: "ask", network: "allow", delegate: "allow" },
    requiredControls: {
      isolation: "not-required",
      redactionFailure: "deny",
      networkBrokerFailure: "deny",
    },
  };
}

/**
 * Child "read-only tools" policy for shell spawns.
 *
 * IMPORTANT: MAE G2 denies *network-class LLM providers* when trustMode is
 * `read-only` OR network !== allow. That gate is about model/provider resolution,
 * not about tool risk. Shell subagents still need the parent's cloud model
 * (deepseek, anthropic, …) while forbidding write/shell/delegate *tools*.
 *
 * So we use trusted-local + network allow, but write/shell/delegate deny.
 * The tool list in invoke() remains read-only / metaproject-only.
 */
function childReadOnlyPolicy(): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId: "monitored-trusted-local",
    profileVersion: "1.0.0-shell-child-tools-ro",
    fingerprint: sha256("shell-child-tools-readonly:v2"),
    trustMode: "trusted-local",
    defaults: { read: "allow", write: "deny", shell: "deny", network: "allow", delegate: "deny" },
    requiredControls: {
      isolation: "not-required",
      redactionFailure: "deny",
      networkBrokerFailure: "deny",
    },
  };
}

/**
 * Create the `spawn_subagent` tool bound to a live shell host.
 * One ledger is shared across all spawns for this tool instance (one shell run).
 */
export function createSpawnSubagentTool(deps: SpawnSubagentToolDeps): InteractiveTool {
  const idSeq = deps.idSeq ?? (() => randomUUID());
  const clock = deps.clock ?? (() => new Date().toISOString());
  const parentRunId = deps.parentRunId ?? idSeq();
  const parentSessionId = deps.parentSessionId ?? idSeq();
  const ledger = new RemainingBudgetLedger(
    { maxRuntimeMs: 15 * 60_000, maxToolCalls: 48 },
    { maxChildren: DEFAULT_MAX_CHILDREN },
  );
  const parentProvenance: Provenance = {
    provenanceId: idSeq(),
    trustLevel: "trusted",
    sourceKind: "keryx-shell",
  };
  let childSeq = 0;

  return {
    definition: {
      name: "spawn_subagent",
      description:
        "Spawn a bounded subagent to work on a focused subtask in parallel-safe isolation " +
        "(MAE multi-agent). Use for independent investigations, reviews, or research while " +
        "you continue the main plan. Input: { task: string, mode?: 'read_only'|'general', " +
        "label?: string, max_tool_calls?: number }. Default mode is read_only (no shell). " +
        "Returns the child's summary. Prefer one clear task per spawn; do not spawn for " +
        "trivial questions (answer yourself).",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          mode: { type: "string", enum: ["read_only", "general"] },
          label: { type: "string" },
          max_tool_calls: { type: "number" },
        },
        required: ["task"],
        additionalProperties: false,
      },
      risk: "delegate",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const task = typeof input.task === "string" ? input.task.trim() : "";
      if (task.length === 0) {
        return { output: "spawn_subagent requires a non-empty 'task'", isError: true };
      }
      const mode: SubagentMode = input.mode === "general" ? "general" : "read_only";
      const maxToolCalls =
        typeof input.max_tool_calls === "number" && input.max_tool_calls > 0
          ? Math.min(16, Math.floor(input.max_tool_calls))
          : 6;
      const labelRaw = typeof input.label === "string" ? input.label.trim() : "";
      childSeq += 1;
      const workerId = `sub:${childSeq}`;
      const label =
        labelRaw.length > 0
          ? labelRaw.length > 18
            ? `${labelRaw.slice(0, 15)}…`
            : labelRaw
          : `sub-${childSeq}`;

      const parent = deps.getParentModel();
      const detected = deps.getDetectedProviders();
      const ctx: SubagentContext = {
        parentRunId,
        parentSessionId,
        parentProvenance,
        contextManifestHash: sha256(`${parentRunId}:${parentSessionId}`),
        canonicalContractVersion: "1.0.0",
        parentModel: { providerId: parent.providerId, modelId: parent.modelId },
        parentPolicy: parentShellPolicy(),
        ledger,
        detected: detected.length > 0 ? detected : [{ name: parent.providerId }],
        config: { maxTreeDepth: 2, maxChildren: DEFAULT_MAX_CHILDREN },
      };

      const attemptId = idSeq();
      const branchId = idSeq();
      const reservationId = idSeq();
      const artifactHash = sha256(task);
      const spawned = spawnSubagent(
        {
          attempt: { attemptId, number: childSeq },
          branchId,
          budgetRequest: {
            reservationId,
            maxRuntimeMs: 5 * 60_000,
            maxToolCalls,
          },
          policyRequest: childReadOnlyPolicy(),
          durableResultArtifact: {
            artifactId: idSeq(),
            kind: "final-report",
            hash: artifactHash,
          },
        },
        ctx,
        { idSeq, clock },
      );

      if (!spawned.ok) {
        emitSubagentFleet({
          id: workerId,
          kind: "upsert",
          label,
          status: "failed",
          detail: "denied",
        });
        return {
          output: `spawn_subagent denied by MAE: ${spawned.reason}`,
          isError: true,
        };
      }

      const runModel = spawned.runModel ?? {
        provider: parent.providerId,
        model: parent.modelId,
      };
      emitSubagentFleet({
        kind: "upsert",
        id: workerId,
        label,
        status: "running",
        detail: mode === "read_only" ? "read-only" : "general",
        model: `${runModel.provider}/${runModel.model}`,
      });

      const cwd = deps.cwd;
      const tools =
        mode === "read_only"
          ? [
              ...builtinReadOnlyTools(cwd),
              ...builtinMetaprojectTools(cwd, makeKeryxRunner(cwd), createMetaprojectAdapter(cwd)),
            ]
          : [
              // v1 general: still no shell_exec (parent owns mutations)
              ...builtinReadOnlyTools(cwd),
              ...builtinMetaprojectTools(cwd, makeKeryxRunner(cwd), createMetaprojectAdapter(cwd)),
            ];

      const provider = deps.makeProvider(
        runModel.provider,
        runModel.model,
        parent.baseUrl,
      );
      const childDeps: AgentDeps = {
        provider,
        providerId: runModel.provider,
        modelId: runModel.model,
        tools,
        systemInstruction:
          "You are a keryx subagent. Complete ONLY the assigned task. " +
          "Be concise. Use tools when needed. Do not spawn further subagents. " +
          "End with a short factual summary the parent can use.",
        idSeq: () => idSeq(),
        maxToolCalls: spawned.reservation.maxToolCalls ?? maxToolCalls,
      };

      let assistant = "";
      const io: AgentIO = {
        write: (s) => {
          assistant += s;
        },
        onAssistantText: (text) => {
          assistant = text;
        },
        onToolCall: (name) => {
          emitSubagentFleet({
            kind: "upsert",
            id: workerId,
            label,
            status: "running",
            detail: name.length > 14 ? `${name.slice(0, 12)}…` : name,
            model: `${runModel.provider}/${runModel.model}`,
          });
        },
        // SECURITY-CRITICAL INVARIANT — do not relax without an ADR.
        // `mode` is chosen by the MODEL and `read_only` is auto-approved with no
        // prompt, so a child's privilege level is effectively self-selected.
        // That is only sound because a child can never execute shell: the tool
        // list omits shell_exec, the child policy sets shell/write/delegate to
        // deny, and this approver refuses unconditionally. Removing any one of
        // the three turns a model-chosen field into a privilege escalation.
        // Pinned by spawn-subagent-isolation.test.ts.
        requestApproval: async () => false,
      };

      try {
        const history: import("../../provider/types").NormalizedMessage[] = [];
        const userLine =
          `## Subagent task (${mode})\n` +
          `${task}\n\n` +
          `Return a concise summary of findings and any recommended next steps for the parent agent.`;
        await runAgentTurn(io, childDeps, history, userLine);
        const raw =
          assistant.trim().length > 0
            ? assistant.trim()
            : history
                .filter((m) => m.role === "assistant")
                .map((m) => m.content)
                .join("\n")
                .trim() || "(subagent produced no text)";
        const folded = foldChildSummary(raw);
        emitSubagentFleet({
          kind: "upsert",
          id: workerId,
          label,
          status: "done",
          detail: "done",
          model: `${runModel.provider}/${runModel.model}`,
        });
        // Drop from fleet after a short delay so the panel stays readable.
        setTimeout(() => emitSubagentFleet({ kind: "remove", id: workerId }), 15_000);
        return {
          output:
            `subagent ${label} (${workerId}) ${mode} via ${runModel.provider}/${runModel.model}\n` +
            `MAE reservation: tools≤${spawned.reservation.maxToolCalls ?? maxToolCalls} ` +
            `runtime≤${spawned.reservation.maxRuntimeMs}ms children=${ledger.childCount}\n` +
            `--- summary ---\n${boundSummary(folded.text)}`,
          isError: false,
        };
      } catch (cause) {
        const msg = cause instanceof Error ? cause.message : String(cause);
        emitSubagentFleet({
          kind: "upsert",
          id: workerId,
          label,
          status: "failed",
          detail: "error",
        });
        return { output: `subagent ${label} failed: ${msg}`, isError: true };
      }
    },
  };
}
