/** Test support ONLY, run as a child process by host.production.test.ts so the production composition reads a synthetic HOME/XDG
 * and nothing of the real user's configuration. One production-assembled native coding turn with the real hook runtime (hooks on,
 * built-in command hooks resolved through PATH to this checkout's CLI) in a real temporary Git checkout, then every native rewind
 * read and the confirmed apply on the checkpoint that turn recorded. Prints one JSON observation; asserts nothing itself. */
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSessionHost } from "./host";
import { assembleNativeSessionRuntime } from "./native-runtime-production";
import { resolveLocalProfile } from "../harness/policy/profiles";
import { callRound, okReply, scriptedProvider } from "../commands/agent.test-helpers";
import { canonicalDigest, type Control } from "../remote-control/protocol";
import { acquireCheckoutLease, currentCheckoutHead } from "../lib/hub-machine/checkout-lease";
import { createOwnedWorkspace, validateOwnedEffectPaths } from "../lib/hub-machine/workspace";
import { MachineError } from "../lib/hub-machine/errors";
import { syncMetaprojectIgnoreRules } from "../lib/metaproject-gitignore";

export interface ProductionTurnObservation {
  admitted: string; state: string; note: string; messages: string[]; status: string[];
  checkpoints: number; previews: Record<string, { status: string; ok: boolean }>; applied: string; restored: string; finalState: string;
}
const [checkout, dataLayout] = [process.argv[2] === "initialized" ? "initialized" : "plain", process.argv[3] === "symlinked" ? "symlinked" : "default"];
const root = realpathSync(process.env.KERYX_PRODUCTION_TURN_ROOT ?? "");
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`fixture git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
};
const cwd = join(root, "checkout"); mkdirSync(cwd);
writeFileSync(join(cwd, "note.txt"), "before\n");
if (checkout === "initialized") { mkdirSync(join(cwd, ".metaproject")); writeFileSync(join(cwd, ".metaproject", "index.md"), "# Metaproject Index\n"); }
git(cwd, "init", "-q"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "fixture");
// `keryx init` writes its managed block to the clone's info/exclude; a plain checkout has none.
if (checkout === "initialized" && (await syncMetaprojectIgnoreRules(cwd)).status !== "written") throw new Error("keryx ignore rules were not written");
// The native session data dir: none given, so the host and the session store resolve their own production default (~/.local/share/keryx
// under the synthetic HOME), or one reached through a symlink. The fixture never resolves the shared directory itself.
let dataDir: string | undefined;
if (dataLayout === "symlinked") { mkdirSync(join(root, "state-real")); symlinkSync(join(root, "state-real"), join(root, "state-link")); dataDir = join(root, "state-link"); }
const configDir = join(root, "config"); mkdirSync(configDir);
const lease = acquireCheckoutLease(cwd, { hubId: "hub", runId: "production-turn", daemonId: "daemon" });
const workspace = createOwnedWorkspace(cwd, () => lease.assertOwnership());
const profile = resolveLocalProfile("monitored-trusted-local"); const digest = profile.fingerprint; const candidate = "local-candidate";
const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [{ candidateId: candidate, providerId: "fixture-local", modelId: "fixture-model",
  reasoningEfforts: ["none"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" }] };
// A supervised shell call (the ctx-guard Bash hook) and a patch (the Edit hooks: output scan, impact evidence) in one turn, as a coding turn makes them.
const provider = scriptedProvider([callRound("shell", "shell_exec", JSON.stringify({ command: "echo production-turn" })), callRound("edit", "apply_patch", JSON.stringify({ patch: "--- a/note.txt\n+++ b/note.txt\n@@ -1 +1 @@\n-before\n+after\n" })), okReply, okReply]);
const assembled = await assembleNativeSessionRuntime({ cwd, configDir, sessionId: "production-turn", profile, providerId: "fixture-local", modelId: "fixture-model", availability,
  allowedTools: ["read_file", "apply_patch", "shell_exec"], maxToolCalls: 5, maxRounds: 5, providerFactory: () => provider.provider,
  approve: async (_tool, _input, meta) => meta === undefined ? false : { approved: true, fingerprint: meta.fingerprint } });
if (!assembled.ok) throw new Error(`native assembly refused: ${assembled.error.code}`);
const record: Control["SessionRecord"] = { sessionId: "production-turn", projectId: "project", machineId: "machine", checkoutId: "checkout", agentProfileId: "native", title: "Production turn", version: 1, historyVersion: 1, state: "idle",
  config: { configVersion: 1, baselineCandidateId: candidate, reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: [candidate], fallbackCandidateId: candidate }, policyDigest: digest, capabilityDigest: digest },
  controller: { controllerLeaseId: "controller", sessionId: "production-turn", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "held" },
  activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: workspace.baseline().digest, forkedFromSessionId: null,
  capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
const host = await createSessionHost({ cwd, ...(dataDir === undefined ? {} : { dataDir }), configDir, record, runtime: assembled.value,
  workspace: { ...workspace, rewind: {
    ownership: () => { lease.assertOwnership(); const baseline = workspace.baseline(); const head = currentCheckoutHead(cwd); if (head !== baseline.head) throw new MachineError("workspace-conflict"); return { nonce: lease.nonce, gitHead: head, paths: Object.keys(baseline.files) }; },
    validatePaths: async (paths, signal) => { signal.throwIfAborted(); lease.assertOwnership(); validateOwnedEffectPaths(cwd, paths); signal.throwIfAborted(); } } },
  authorizeController: async () => true, authorizeQueued: async () => true, authorizeAction: async () => true, authorizeSelection: async () => true, authorizeInspection: async () => true, authorizeOwnedControl: async () => true });
const controller = { controllerLeaseId: "controller", expectedControllerVersion: 1 };
const settle = async () => { for (let attempt = 0; attempt < 2000; attempt++) { const state = await host.inspect(); if (state.state !== "busy" && state.state !== "paused") return state; await Bun.sleep(10); } throw new Error("native host never settled"); };
let sequence = 0;
const command = async (commandName: string, args: Control["CommandInvoke"]["arguments"]): Promise<Control["CommandOutcome"]> => {
  const current = await host.inspect(); const id = `command-${++sequence}`;
  const request: Control["CommandInvoke"] = { commandName, arguments: args, catalogueDigest: (await host.catalogue()).catalogueDigest, expectedSessionVersion: current.version, expectedConfigVersion: current.config.configVersion, controller, busyPolicy: "reject" };
  const operation = { kind: "command" as const, operationId: id, payloadDigest: canonicalDigest(request), actorId: "human", request, runId: `run-${id}`, turnId: `turn-${id}`, association: { mode: "ad-hoc" as const, profileConsentVersion: 1 } };
  const outcome = await host.apply(operation) as Control["CommandOutcome"];
  if (outcome.status !== "confirmation-required" || outcome.confirmation === null) return outcome;
  const answer: Control["CommandConfirmation"] = { expectedSessionVersion: (await host.inspect()).version, controller, confirmationId: outcome.confirmation.confirmationId, operationDigest: outcome.confirmation.operationDigest, policyDigest: digest, decision: "allow-once" };
  await host.apply({ kind: "confirm-command", operationId: `confirm-${id}`, payloadDigest: canonicalDigest(answer), actorId: "human", request: answer }); await settle();
  return await host.apply(operation) as Control["CommandOutcome"];
};
const parsed = (outcome: Control["CommandOutcome"]): { ok?: boolean; status?: string; data?: Record<string, unknown> } => { try { return typeof outcome.result === "string" ? JSON.parse(outcome.result) : {}; } catch { return {}; } };
try {
  const current = await host.inspect();
  const request: Control["StartTurnRequest"] = { sessionId: current.sessionId, expectedSessionVersion: current.version, controller, expectedConfigVersion: 1, expectedHistoryVersion: current.historyVersion,
    expectedWorkspaceBaseline: current.workspaceBaseline, association: { mode: "ad-hoc", profileConsentVersion: 1 }, messageId: "edit-note", text: "Change note.txt to after" };
  const admitted = await host.apply({ kind: "message", operationId: "edit-note", payloadDigest: canonicalDigest(request), actorId: "human", runId: "run-edit", turnId: "turn-edit", request });
  const ended = await settle(); const note = readFileSync(join(cwd, "note.txt"), "utf8");
  const listed = parsed(await command("rewind", {}));
  const checkpoints = Array.isArray(listed.data) ? listed.data.length : 0;
  const previews: ProductionTurnObservation["previews"] = {}; let pins: Record<string, unknown> | undefined;
  for (const mode of ["files", "history", "both"]) {
    const preview = await command("rewind.preview", { seq: 1, mode, expectedHistoryVersion: (await host.inspect()).historyVersion });
    const body = parsed(preview); previews[mode] = { status: preview.status, ok: body.ok === true };
    if (mode === "both" && body.ok === true) pins = body.data;
  }
  const applied = pins === undefined ? "no-preview" : (await command("rewind.apply", { seq: 1, mode: "both", expectedHistoryVersion: Number(pins.historyVersion), previewDigest: String(pins.previewDigest), workspaceBaseline: String(pins.workspaceBaseline) })).status;
  const finalState = (await settle()).state;
  const observation: ProductionTurnObservation = { admitted: admitted.status, state: ended.state, note, messages: (await host.history()).messages.map((message) => `${message.role}: ${message.text}`),
    status: git(cwd, "status", "--porcelain=v1", "-uall").split("\n").filter((line) => line.length > 0), checkpoints, previews, applied, restored: readFileSync(join(cwd, "note.txt"), "utf8"), finalState };
  process.stdout.write(`${JSON.stringify(observation)}\n`);
} finally { await host.dispose(); lease.release(lease.nonce); }
