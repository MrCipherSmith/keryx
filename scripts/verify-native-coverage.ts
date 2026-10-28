/** Build-time native command coverage gate and embedded release descriptor generator.
 *   bun scripts/verify-native-coverage.ts --write    re-execute every audited variant, refresh the inventory subject, regenerate the descriptor
 *   bun scripts/verify-native-coverage.ts --check    re-execute; fail when the committed inventory or embedded descriptor is stale, missing or tampered
 *   bun scripts/verify-native-coverage.ts --release  as --check, and fail unless every required variant earned its receipt
 * Receipts come only from executing each variant through the local terminal adapter and the headless native host of a
 * production-assembled runtime in an isolated child (synthetic HOME/config, loopback provider, no inherited credentials).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { canonicalDigest, type Control } from "../src/remote-control/protocol";
import {
  buildNativeCoverageDescriptor, checkNativeCommandCoverage, currentNativeCoverageSubject, nativeParityReceiptDigest, parityReceiptId, receiptParity,
  registeredNativeCommandNames, validateNativeCoverageDescriptor,
  type NativeCoverageDescriptor, type NativeCoverageInventory, type NativeCoverageResult, type NativeCoverageVariant, type NativeNormalizedOutcome, type NativeParityReceipt,
} from "../src/session/commands/coverage";

type Json = Control["BoundedJson"];
type Args = { [key: string]: Json };
/** `before`: terminal lines the operator typed first in the same terminal (the shipped two-step forms, e.g. a rewind preview before its confirm). */
/** `operation`: the headless typed form is that frozen protocol operation (its body in `arguments`), not a CommandInvoke. */
export interface ParityCase { line: string; arguments: Args | null; before?: string[]; operation?: "remove-queue" | "edit-queue";
  scenario?: "active-turn" | "background-task" | "foreground-task" | "approval-waiter" | "question-waiter" | "bus-peer" | "rewind-checkpoint" | "queued-message" }
export interface ParityOutcome { variantId: string; handlerName: string | null; local: NativeNormalizedOutcome; headless: NativeNormalizedOutcome | null }
export interface ParityRun { catalogue: Control["CommandCatalogue"]; outcomes: ParityOutcome[] }
export const INVENTORY_PATH = "output/hub-remote-sessions/native-command-coverage.json";
export const DESCRIPTOR_PATH = "src/session/native-coverage.generated.ts";
const CANDIDATE = "local-candidate";
const RUN = { runId: "parity-run", turnId: "parity-turn" };
const RUN_ASSOCIATION: Control["FlowAssociation"] = { mode: "ad-hoc", profileConsentVersion: 1 };
const PULL = "https://github.com/owner/repo/pull/1";
const APPROVAL_TURN = "PARITY-APPROVAL: create approved.txt";
const QUESTION_TURN = "PARITY-QUESTION: ask the operator before continuing";
const REWIND_TURN = "PARITY-REWIND: create rewound.txt and finish";
const PEER_SESSION = "30000000-0000-4000-8000-000000000001";
const WORKSPACE = "workspace-parity";
/** Exact parsed terminal syntax and the typed native request for each required variant. `arguments: null` = no typed form exists. */
export const PARITY_CASES: Readonly<Record<string, ParityCase>> = {
  "help.default": { line: "/help", arguments: {} },
  "model.list": { line: "/model", arguments: {} },
  "model.select": { line: `/model ${CANDIDATE}`, arguments: { candidateId: CANDIDATE } },
  "connect.list": { line: "/connect", arguments: {} },
  "connect.test": { line: `/connect test ${CANDIDATE}`, arguments: { id: CANDIDATE } },
  "connect.select": { line: `/connect select ${CANDIDATE}`, arguments: { id: CANDIDATE } },
  "search-provider.list": { line: "/search-provider", arguments: {} },
  "search-connect.list": { line: "/search-connect", arguments: {} },
  "search-connect.select": { line: "/search-connect select", arguments: null },
  "new.default": { line: "/new", arguments: {} },
  "goal.-workspace": { line: "/goal Ship the fixture --workspace ws", arguments: { text: "Ship the fixture", workspaceId: "ws" } },
  "goal.-auto": { line: "/goal Ship the fixture --auto 3", arguments: { text: "Ship the fixture", autoRounds: 3 } },
  "goal.auto-rounds": { line: "/goal Ship the fixture --auto 2", arguments: { text: "Ship the fixture", autoRounds: 2 } },
  "resume.picker": { line: "/resume", arguments: {} },
  "sessions.picker": { line: "/sessions", arguments: {} },
  "sessions.open": { line: "/sessions open other-session", arguments: { sessionId: "other-session", expectedSessionVersion: 1 } },
  "sessions.resume": { line: "/sessions resume other-session", arguments: { sessionId: "other-session", expectedSessionVersion: 1, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedHistoryVersion: 1, expectedWorkspaceBaseline: "0".repeat(64) } },
  "sessions.fork": { line: "/sessions fork", arguments: { throughHistoryCursor: 0, expectedHistoryVersion: 1, targetCheckoutId: "checkout", expectedInventoryVersion: 1, expectedHeadSha: "0".repeat(40), title: "Fork" } },
  "status.default": { line: "/status", arguments: {} },
  "status.questions-list": { line: "/questions.list", arguments: {} },
  "status.questions-answer": { line: "/questions.answer {questionId} yes", arguments: { questionId: "{questionId}", runId: "held-run", turnId: "held-turn", fingerprint: "{fingerprint}", answers: { kind: "option", choice: "yes" } }, scenario: "question-waiter" },
  "flows.list": { line: "/flows", arguments: {} },
  "flows.detail": { line: "/flows {flow}", arguments: { flowId: "{flow}" } },
  "flows.ac-cached": { line: "/ac {flow}", arguments: { flowId: "{flow}" } },
  "flows.ac-check": { line: "/ac flow-1 check", arguments: null },
  "doctor.report": { line: "/doctor", arguments: {} },
  "setup.init": { line: "/setup init", arguments: { scenario: "init" } },
  "setup.refresh": { line: "/setup refresh", arguments: { scenario: "refresh" } },
  "setup.repair": { line: "/setup repair", arguments: { scenario: "repair" } },
  "ac.cached": { line: "/ac", arguments: {} },
  "ac.check": { line: "/ac check", arguments: null },
  "workspace.overview": { line: "/workspace", arguments: {} },
  "workspace.slates": { line: `/workspace ${WORKSPACE}`, arguments: { workspaceId: WORKSPACE } },
  "workspace.slate-detail": { line: "/workspace ws slate", arguments: null },
  "review.catch-up": { line: "/review", arguments: {} },
  "review.layers": { line: "/review layers", arguments: { section: "layers" } },
  "review.parity": { line: "/review parity", arguments: { section: "parity" } },
  "review.readiness": { line: "/review readiness", arguments: { section: "readiness" } },
  "reviews.metrics": { line: "/reviews", arguments: {} },
  "reviews.depth": { line: "/reviews depth", arguments: { section: "depth" } },
  "remote-control.on": { line: "/remote-control on", arguments: {} },
  "remote-control.name": { line: "/remote-control fixture", arguments: { name: "fixture" } },
  "remote-control.off": { line: "/remote-control off", arguments: {} },
  "remote-control.status": { line: "/remote-control status", arguments: {} },
  "history.N-1-20": { line: "/history 5", arguments: { count: 5 } },
  "channels.status": { line: "/channels", arguments: {} },
  "intake.status": { line: "/intake", arguments: {} },
  "intake.list": { line: "/intake list", arguments: {} },
  "trail.count": { line: "/trail 5", arguments: { count: 5 } },
  "trail.tool-NAME": { line: "/trail tool=read_file", arguments: { tool: "read_file" } },
  "trail.file-TEXT": { line: "/trail file=note.txt", arguments: { file: "note.txt" } },
  "trail.from-STEP": { line: "/trail from=1", arguments: { from: 1 } },
  "trail.to-STEP": { line: "/trail to=2", arguments: { to: 2 } },
  "notes.key": { line: "/notes key", arguments: { key: "key" } },
  "product.report": { line: "/product", arguments: {} },
  "governance.inspection": { line: "/governance", arguments: {} },
  "triggers.list": { line: "/triggers", arguments: {} },
  "triggers.detail": { line: "/triggers nightly", arguments: { name: "nightly" } },
  "triggers.run": { line: "/triggers nightly run", arguments: null },
  "triggers.confirm-run": { line: "/triggers nightly run --confirm", arguments: null },
  "routing.inspection": { line: "/routing", arguments: {} },
  "routing.configure": { line: `/routing configure on profile=local candidates=${CANDIDATE} fallback=${CANDIDATE}`, arguments: { enabled: true, profileId: "local", candidateIds: [CANDIDATE], fallbackCandidateId: CANDIDATE } },
  "routing.category-assignments": { line: "/routing categories", arguments: null },
  "schedules.list": { line: "/schedules", arguments: {} },
  "autoreview.list": { line: "/autoreview", arguments: {} },
  "autoreview.ls": { line: "/autoreview ls", arguments: {} },
  "autoreview.start-budget-minutes-budget-tokens": { line: `/autoreview start ${PULL} --budget-minutes 5 --budget-tokens 1000`, arguments: { ref: PULL, budgetMinutes: 5, budgetTokens: 1000 } },
  "autoreview.start": { line: `/autoreview start ${PULL} --budget-minutes 5 --budget-tokens 1000`, arguments: { ref: PULL, budgetMinutes: 5, budgetTokens: 1000 } },
  "autoreview.stop": { line: "/autoreview stop 1", arguments: { selector: "1" } },
  "autoreview.arbiter": { line: "/autoreview arbiter latest", arguments: { selector: "latest" } },
  "approvals.list": { line: "/approvals", arguments: {} },
  "approvals.allow-once": { line: "/approvals allow-once {approvalId}", arguments: { approvalId: "{approvalId}", runId: "held-run", turnId: "held-turn", fingerprint: "{fingerprint}", policyDigest: "{policyDigest}" }, scenario: "approval-waiter" },
  "approvals.deny": { line: "/approvals deny {approvalId}", arguments: { approvalId: "{approvalId}", runId: "held-run", turnId: "held-turn", fingerprint: "{fingerprint}", policyDigest: "{policyDigest}" }, scenario: "approval-waiter" },
  "permissions.list": { line: "/permissions", arguments: {} },
  "decisions.show": { line: "/decisions", arguments: {} },
  "decisions.arms": { line: "/decisions arms", arguments: { section: "arms" } },
  "decisions.reason": { line: "/decisions reason the fixture said so", arguments: null },
  "decisions.change": { line: "/decisions change option-b", arguments: null },
  "ci.list": { line: "/ci", arguments: {} },
  "ci.detail": { line: "/ci 1", arguments: null },
  "ci.triage": { line: "/ci triage 1 build", arguments: { runId: "1", jobName: "build" } },
  "ci.retry": { line: "/ci retry 1 build", arguments: null },
  "conform.setup": { line: "/conform", arguments: {} },
  "conform.reference-select": { line: "/conform reference docs/reference.md", arguments: null },
  "conform.target-diff": { line: "/conform target diff", arguments: null },
  "conform.target-pr": { line: "/conform target pr 1", arguments: null },
  "conform.target-report": { line: "/conform target report", arguments: null },
  "conform.run": { line: "/conform run docs/reference.md diff", arguments: { referencePath: "docs/reference.md", targetKind: "diff" } },
  "conform.clause-detail": { line: "/conform clause 1", arguments: null },
  "risk.working-diff": { line: "/risk", arguments: {} },
  "scenarios.working-diff": { line: "/scenarios", arguments: {} },
  "jevrules.working-diff": { line: "/jevrules", arguments: {} },
  "staledocs.working-diff": { line: "/staledocs", arguments: {} },
  "opencomments.repo-pr": { line: "/opencomments owner/repo#1", arguments: null },
  "contract.working-diff": { line: "/contract Fixture contract", arguments: { description: "Fixture contract" } },
  "triage.latest-review": { line: "/triage", arguments: {} },
  "flow.origin-show": { line: "/flow origin {flow}", arguments: { flowId: "{flow}" } },
  "flow.origin-set-reason": { line: "/flow origin set flow-1 --reason fixture", arguments: null },
  "flow.origin-summary": { line: "/flow origin", arguments: null },
  "flow.origin-set-reason-quote-source": { line: "/flow origin set flow-1 --reason fixture --quote source", arguments: null },
  "guard.inspection": { line: "/guard", arguments: {} },
  "guard.measured-details": { line: "/guard details", arguments: null },
  "route.inspection": { line: "/route", arguments: {} },
  "route.on": { line: "/route on", arguments: { enabled: true } },
  "route.off": { line: "/route off", arguments: { enabled: false } },
  "route.set": { line: "/route on", arguments: { enabled: true } },
  "editguard.inspection": { line: "/editguard", arguments: {} },
  "editguard.threshold-and-recent-flags": { line: "/editguard status", arguments: {} },
  "projectctx.status": { line: "/projectctx", arguments: {} },
  "projectctx.refs": { line: "/projectctx refs", arguments: {} },
  "projectctx.warn": { line: "/projectctx warn", arguments: null },
  "projectctx.block": { line: "/projectctx block", arguments: null },
  "projectctx.last-resolve-details": { line: "/projectctx last", arguments: {} },
  "projectctx.reference-details": { line: "/projectctx references", arguments: {} },
  "external.status": { line: "/external", arguments: {} },
  "external-agents.status": { line: "/external-agents", arguments: {} },
  "jevprofile.inspection": { line: "/jevprofile", arguments: {} },
  "jevprofile.entries": { line: "/jevprofile entries", arguments: {} },
  "mcp.status": { line: "/mcp", arguments: {} },
  "mcp.disconnect": { line: "/mcp disconnect fixture", arguments: { name: "fixture" } },
  "mcp.trust-list": { line: "/mcp trust list", arguments: {} },
  "mcp.trust-revoke-fqn": { line: "/mcp trust revoke fixture__tool", arguments: { fqn: "fixture__tool" } },
  "mcp.trust-revoke-all": { line: "/mcp trust revoke all", arguments: {} },
  "compact.default": { line: "/compact", arguments: {} },
  "compact.focus": { line: "/compact keep the API notes", arguments: null },
  "rewind.picker": { line: "/rewind", arguments: {} },
  "rewind.files": { line: "/rewind 1 files", arguments: { seq: 1, mode: "files", expectedHistoryVersion: "{#historyVersion}" }, scenario: "rewind-checkpoint" },
  "rewind.history": { line: "/rewind 1 history", arguments: { seq: 1, mode: "history", expectedHistoryVersion: "{#historyVersion}" }, scenario: "rewind-checkpoint" },
  "rewind.both": { line: "/rewind 1 both", arguments: { seq: 1, mode: "both", expectedHistoryVersion: "{#historyVersion}" }, scenario: "rewind-checkpoint" },
  "rewind.preview": { line: "/rewind.preview 1 files", arguments: { seq: 1, mode: "files", expectedHistoryVersion: "{#historyVersion}" }, scenario: "rewind-checkpoint" },
  "rewind.apply": { line: "/rewind confirm", before: ["/rewind 1 files"], arguments: { seq: 1, mode: "files", expectedHistoryVersion: "{#historyVersion}", previewDigest: "{previewDigest}", workspaceBaseline: "{workspaceBaseline}" }, scenario: "rewind-checkpoint" },
  "settings.read": { line: "/settings", arguments: {} },
  "mode.show": { line: "/mode", arguments: {} },
  "mode.ask": { line: "/mode ask", arguments: null },
  "reasoning.show": { line: "/reasoning", arguments: {} },
  "reasoning.off": { line: "/reasoning off", arguments: { effort: "none" } },
  "reasoning.minimal": { line: "/reasoning minimal", arguments: { effort: "minimal" } },
  "reasoning.low": { line: "/reasoning low", arguments: { effort: "low" } },
  "reasoning.medium": { line: "/reasoning medium", arguments: { effort: "medium" } },
  "reasoning.high": { line: "/reasoning high", arguments: { effort: "high" } },
  "reasoning.xhigh": { line: "/reasoning xhigh", arguments: { effort: "xhigh" } },
  "reasoning.max": { line: "/reasoning max", arguments: { effort: "max" } },
  "plan.show": { line: "/plan", arguments: {} },
  "plan.on": { line: "/plan on", arguments: { enabled: true } },
  "plan.off": { line: "/plan off", arguments: { enabled: false } },
  "plan.set": { line: "/plan on", arguments: { enabled: true } },
  "clear.default": { line: "/clear", arguments: {} },
  "interrupt.default": { line: "/interrupt", arguments: {}, scenario: "active-turn" },
  "queue.list": { line: "/queue", arguments: {} },
  "queue.remove-N": { line: "/queue remove 1", operation: "remove-queue", arguments: { expectedSessionVersion: "{#sessionVersion}", controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, queueItemId: "{queueItemId}", expectedQueueVersion: "{#queueVersion}", expectedItemVersion: "{#itemVersion}" }, scenario: "queued-message" },
  "queue.edit-N": { line: "/queue edit 1 Edited behind the held turn", operation: "edit-queue", arguments: { expectedSessionVersion: "{#sessionVersion}", controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, queueItemId: "{queueItemId}", expectedQueueVersion: "{#queueVersion}", expectedItemVersion: "{#itemVersion}", text: "Edited behind the held turn" }, scenario: "queued-message" },
  "queue.force-N": { line: "/queue force 1", arguments: null, scenario: "queued-message" },
  "queue.edit": { line: "/queue edit", arguments: null, scenario: "queued-message" },
  "queue.remove": { line: "/queue remove", operation: "remove-queue", arguments: { expectedSessionVersion: "{#sessionVersion}", controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, queueItemId: "{queueItemId}", expectedQueueVersion: "{#queueVersion}", expectedItemVersion: "{#itemVersion}" }, scenario: "queued-message" },
  "queue.force": { line: "/queue force", arguments: null, scenario: "queued-message" },
  "tasks.list": { line: "/tasks", arguments: {}, scenario: "background-task" },
  "tasks.output-task-id-cursor": { line: "/tasks output {task} 0", arguments: { taskId: "{task}", cursor: 0 }, scenario: "background-task" },
  "tasks.kill-task-id": { line: "/tasks kill {task}", arguments: { taskId: "{task}" }, scenario: "background-task" },
  "tasks.output": { line: "/tasks output {task}", arguments: { taskId: "{task}" }, scenario: "background-task" },
  "tasks.kill": { line: "/tasks kill {task}", arguments: { taskId: "{task}" }, scenario: "background-task" },
  "demote.task-id": { line: "/demote {task}", arguments: { taskId: "{task}" }, scenario: "foreground-task" },
  "bus.modal": { line: "/bus", arguments: {}, scenario: "bus-peer" },
  "bus.-name-text": { line: "/bus @peer hello", arguments: { to: "@peer", text: "hello" }, scenario: "bus-peer" },
  "bus.send": { line: "/bus send @peer hello", arguments: { to: "@peer", text: "hello" }, scenario: "bus-peer" },
  "bus.ask": { line: "/bus ask @peer hello", arguments: { to: "@peer", text: "hello" }, scenario: "bus-peer" },
  "bus.reply": { line: "/bus reply 1 hello", arguments: { id: "1", text: "hello" } },
  "bus.name": { line: "/bus name fixture", arguments: { name: "fixture" }, scenario: "bus-peer" },
  "bus.pause-scope-ttl": { line: "/bus pause @peer --scope turns --ttl 5m hold", arguments: { to: "@peer", scope: "turns", ttlMinutes: 5, reason: "hold" }, scenario: "bus-peer" },
  "bus.pause": { line: "/bus pause @peer hold", arguments: { to: "@peer", scope: "turns", reason: "hold" }, scenario: "bus-peer" },
  "bus.resume": { line: "/bus resume lease-1", arguments: { leaseId: "lease-1" } },
  "bus.override": { line: "/bus override lease-1", arguments: { leaseId: "lease-1" } },
  "exit.default": { line: "/exit", arguments: {} },
  "exit.quit-alias": { line: "/quit", arguments: {} },
};
/** Variant-specific facts a refusal outcome cannot carry by itself. Every one stays a required, visible gap. */
const REWIND_SNAPSHOT_GAP = "No native rewind snapshot exists to select: in the production-assembled fixture session the approved apply_patch turn is fenced as workspace-conflict because the shell hook runtime writes .metaproject/data/security/impact-evidence/ (outside the keryx init ignore block) into the owned checkout, and with that path ignored the native recorder still reports \"A complete checkpoint is unavailable for this turn\".";
const KNOWN_GAPS: Readonly<Record<string, string>> = {
  "connect.test": "Configured OpenAI-compatible endpoints probe through the shared driver; anthropic, gemini, ollama and openai-codex have no shared native probe.",
  ...Object.fromEntries(["rewind.files", "rewind.history", "rewind.both", "rewind.preview", "rewind.apply"].map((id) => [id, REWIND_SNAPSHOT_GAP])),
};
const JEV = new Set(["risk.working-diff", "scenarios.working-diff", "jevrules.working-diff", "staledocs.working-diff", "opencomments.repo-pr", "contract.working-diff", "triage.latest-review", "ci.triage", "ci.retry", "conform.run"]);
/** Boundary rows execute their parsed syntax too, so every pin is backed by an executed receipt; they are never counted as earned parity. */
export function parityCaseFor(row: NativeCoverageVariant): ParityCase {
  const explicit = PARITY_CASES[row.id];
  if (explicit !== undefined) return explicit;
  const rest = row.id.slice(row.commandName.length + 1).replaceAll(/[.-]+/g, " ").trim();
  return { line: `/${row.commandName}${rest === "default" || rest === "" ? "" : ` ${rest}`}`, arguments: row.handlerName === null || row.classification === "required" ? null : {} };
}
function outcomeOf(receipt: unknown, replace: (text: string) => string): NativeNormalizedOutcome {
  if (receipt === null || typeof receipt !== "object") return { status: "invalid", errorCode: "invalid-receipt", confirmation: false, resultDigest: null };
  const value = receipt as Record<string, unknown>;
  const status = typeof value.status === "string" ? value.status : "invalid";
  const errorCode = typeof value.errorCode === "string" ? value.errorCode : typeof value.reason === "string" && status !== "applied" ? value.reason : null;
  const confirmation = value.confirmation !== undefined && value.confirmation !== null;
  const raw = "result" in value ? value.result : "kind" in value ? value.kind : null;
  return { status, errorCode, confirmation, resultDigest: raw === null || raw === undefined ? null : createHash("sha256").update(replace(typeof raw === "string" ? raw : JSON.stringify(raw))).digest("hex") };
}

/** Child-process side: runs inside the isolated environment only. Every owner is the production one, composed as the machine bridge composes it. */
async function runHarness(input: { cases: { variantId: string; handlerName: string | null; case: ParityCase }[] }): Promise<ParityRun> {
  const { createSessionHost } = await import("../src/session/host");
  const { assembleNativeSessionRuntime } = await import("../src/session/native-runtime-production");
  const { resolveLocalProfile } = await import("../src/harness/policy/profiles");
  const { createTerminalSessionAdapter } = await import("../src/session/commands/terminal-adapter");
  const { startHub } = await import("../src/hub/server");
  const { readScopedHubFlows } = await import("../src/lib/hub-machine/client");
  const { createOwnedWorkspace, validateOwnedEffectPaths } = await import("../src/lib/hub-machine/workspace");
  const { acquireCheckoutLease, currentCheckoutHead } = await import("../src/lib/hub-machine/checkout-lease");
  const { MachineError } = await import("../src/lib/hub-machine/errors");
  const { renderMetaprojectGitignoreBlock } = await import("../src/lib/metaproject-gitignore");
  const { WorkspaceService, localWorkspaceAuthorizationServer } = await import("../src/sac/workspace-service");
  const root = await mkdtemp(join(tmpdir(), "native-parity-"));
  const held = new Set<() => void>();
  // A first-round model request for a marked turn streams one real tool call; every other model request is held open until its owner aborts it.
  const toolCall = (name: string, args: unknown) => new Response([
    `data: ${JSON.stringify({ id: "parity", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call-parity", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "parity", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`, "data: [DONE]\n\n"].join(""), { headers: { "Content-Type": "text/event-stream" } });
  const finalText = (content: string) => new Response([
    `data: ${JSON.stringify({ id: "parity", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "parity", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`, "data: [DONE]\n\n"].join(""), { headers: { "Content-Type": "text/event-stream" } });
  let requests = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
    requests++;
    if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "fixture-model" }] });
    const body = await request.json().catch(() => undefined) as { messages?: { role?: string; content?: unknown }[] } | undefined;
    // Only the first round of a marked turn: once a tool result is in the request, the turn is past its tool call.
    const messages = body?.messages ?? []; const asked = JSON.stringify(messages.filter((message) => message.role === "user").map((message) => message.content));
    const pastTool = messages.some((message) => message.role === "tool"); const text = pastTool ? "" : asked;
    // The rewind fixture turn is the one turn that completes: its patch, then a final answer once the tool result is in.
    if (asked.includes(REWIND_TURN)) return pastTool ? finalText("rewound.txt created")
      : toolCall("apply_patch", { patch: "diff --git a/rewound.txt b/rewound.txt\nnew file mode 100644\n--- /dev/null\n+++ b/rewound.txt\n@@ -0,0 +1 @@\n+rewound\n" });
    if (text.includes(APPROVAL_TURN)) return toolCall("apply_patch", { patch: "diff --git a/approved.txt b/approved.txt\nnew file mode 100644\n--- /dev/null\n+++ b/approved.txt\n@@ -0,0 +1 @@\n+approved\n" });
    if (text.includes(QUESTION_TURN)) return toolCall("ask_user", { question: "Proceed with the parity fixture?", options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }] });
    return new Promise<Response>((done) => { const finish = () => { held.delete(finish); done(new Response(null, { status: 503 })); }; held.add(finish); request.signal.addEventListener("abort", finish, { once: true }); });
  } });
  // A real in-process Hub v2 with a paired machine: canonical project reads go through the bridge's own scoped reader.
  const token = (role: string) => `parity-${role}-${createHash("sha256").update(`${role}:${root}`).digest("hex")}`;
  const stops: (() => Promise<void>)[] = [];
  const hub = startHub({ dataDir: join(root, "hub"), operatorToken: token("operator"), reviewerToken: token("reviewer"), agentToken: token("agent"), port: 0, host: "127.0.0.1" });
  try {
    const origin = hub.url.origin;
    const call = async <T>(path: string, method: string, body?: unknown, cookie?: string): Promise<{ value: T; response: Response }> => {
      const headers = new Headers({ Origin: origin });
      if (cookie !== undefined) headers.set("Cookie", cookie);
      if (method !== "GET") headers.set("Idempotency-Key", randomUUID());
      if (body !== undefined) headers.set("Content-Type", "application/json");
      const response = await fetch(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (response.status !== 200) throw new Error(`fixture Hub ${method} ${path} -> ${response.status}`);
      return { value: await response.json() as T, response };
    };
    const login = await call<unknown>("/hub/v1/session", "POST", { token: token("operator") });
    const cookie = login.response.headers.get("set-cookie")?.split(";")[0]; if (cookie === undefined) throw new Error("fixture Hub login set no cookie");
    const project = (await call<{ id: string; version: number }>("/hub/v1/projects", "POST", { name: "Native parity" }, cookie)).value;
    // One canonical Flow both paths select by id: a spec document, then the Flow pinned to it.
    const imported = (await call<{ documents: { id: string; kind: string }[] }>(`/hub/v1/projects/${project.id}/import`, "POST", { expectedVersion: project.version, sourceRevision: "native-parity",
      documents: [{ path: "openspec/specs/parity/spec.md", kind: "spec", content: "# Native parity\nBoth paths read one canonical Flow." }] }, cookie)).value;
    const spec = imported.documents.find((document) => document.kind === "spec"); if (spec === undefined) throw new Error("fixture Hub imported no spec document");
    const flow = (await call<{ id: string }>(`/hub/v1/projects/${project.id}/flows`, "POST", { title: "Native parity Flow", specDocumentId: spec.id, criteria: ["Both paths read the same canonical Flow"] }, cookie)).value;
    /** Fixture identities every case may name; both paths see the same canonical subject. */
    const shared: Record<string, string> = { flow: flow.id };
    const pairing = (await call<{ code: string }>("/hub/v2/machines/pairings", "POST", { displayName: "Native parity machine", projectIds: [project.id] }, cookie)).value;
    const machine = (await call<{ machineId: string; secret: string }>("/hub/v2/machines/enroll", "POST", { code: pairing.code, agentVersion: "native-parity", ledgerId: "native-parity-ledger" })).value;
    // As on a real machine, the session config dir is the user-global keryx dir (here the isolated synthetic XDG one), which the provider registry also reads.
    const configDir = (await import("../src/lib/config-dir")).ensureKeryxConfigDir();
    if (!configDir.startsWith(process.env.XDG_DATA_HOME ?? "\u0000")) throw new Error("parity harness must run with an isolated XDG_DATA_HOME");
    // A real streamable-HTTP MCP fixture, configured user-scoped the way an operator adds one: the production assembly binds it from that local approval alone.
    const { startMockHttpMcpServer } = await import("../fixtures/mcp-servers/http-server");
    const mcp = await startMockHttpMcpServer();
    stops.push(() => mcp.stop());
    await writeFile(join(configDir, "mcp-servers.json"), JSON.stringify({ schemaVersion: 1, servers: { fixture: { url: mcp.url } } }));
    await writeFile(join(configDir, "llm-providers.json"), JSON.stringify({ schemaVersion: 1, providers: { local: { name: "fixture-local", label: "Fixture local", baseUrl: `http://127.0.0.1:${server.port}`, requiresApiKey: false, models: ["fixture-model"] } } }));
    const profile = resolveLocalProfile("monitored-trusted-local"); const digest = profile.fingerprint;
    const availability: Control["RoutingAvailability"] = { version: 1, policyDigest: digest, capabilityDigest: digest, profileIds: ["local"], candidates: [{ candidateId: CANDIDATE, providerId: "fixture-local", modelId: "fixture-model",
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], available: true, reason: "none", privacyClass: "approved-egress", costClass: "metered" }] };
    // Identical committed checkouts (fixed identity and dates, no global config or hooks) so both paths see the same owned baseline.
    const gitEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? root, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Parity", GIT_AUTHOR_EMAIL: "parity@example.invalid", GIT_COMMITTER_NAME: "Parity", GIT_COMMITTER_EMAIL: "parity@example.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" };
    const checkout = async (name: string) => {
      // A Keryx-initialized checkout: the managed ignore block `keryx init` writes keeps runtime-internal .metaproject/data writes out of the owned baseline.
      const cwd = join(root, `checkout-${name}`); await mkdir(cwd); await writeFile(join(cwd, "seed.txt"), "seed\n"); await writeFile(join(cwd, ".gitignore"), renderMetaprojectGitignoreBlock());
      // Committed project content the drill-down inspectors select: one configured trigger and one workspace, created through their own services.
      await mkdir(join(cwd, ".metaproject"));
      await writeFile(join(cwd, ".metaproject", "triggers.json"), JSON.stringify({ schemaVersion: 1, triggers: [{ name: "nightly", on: { kind: "schedule", cron: "0 2 * * *" }, action: { kind: "rebuild" } }] }));
      await new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), now: () => new Date("2026-01-01T00:00:00Z"),
        strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } }).create({ request: undefined, requestCorrelationId: "native-parity-correlation-0001", id: WORKSPACE, title: "Native parity workspace" });
      for (const args of [["init", "-q"], ["add", "seed.txt", ".gitignore", ".metaproject"], ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-qm", "parity fixture"]]) {
        if (await Bun.spawn(["git", ...args], { cwd, env: gitEnv, stdout: "ignore", stderr: "ignore" }).exited !== 0) throw new Error(`fixture git ${args.at(-1)} failed`);
      }
      return cwd;
    };
    let serial = 0;
    const host = async (allowedTools: readonly string[] = ["read_file"]) => {
      const name = `h${++serial}`;
      const cwd = await checkout(name);
      const lease = acquireCheckoutLease(cwd, { hubId: "native-parity", runId: `parity-${name}`, daemonId: "native-parity" });
      const workspace = createOwnedWorkspace(cwd, () => lease.assertOwnership());
      const peerInstances: string[] = [];
      const assembled = await assembleNativeSessionRuntime({ cwd, configDir, sessionId: `parity-${name}`, profile, providerId: "fixture-local", modelId: "fixture-model", availability: structuredClone(availability), allowedTools, maxToolCalls: 5, maxRounds: 5,
        locallyApprovedBus: { allowedCheckoutPaths: [cwd], allowedPeerSessionIds: [PEER_SESSION], allowedControlInstanceIds: () => peerInstances } });
      if (!assembled.ok) throw new Error(`native assembly refused: ${assembled.error.code}`);
      const record: Control["SessionRecord"] = { sessionId: "parity-session", projectId: project.id, machineId: machine.machineId, checkoutId: "checkout", agentProfileId: "native", title: "Parity", version: 1, historyVersion: 1, state: "idle",
        config: { configVersion: 1, baselineCandidateId: CANDIDATE, reasoningEffort: "none", routing: { enabled: false, profileId: "local", candidateIds: [CANDIDATE], fallbackCandidateId: CANDIDATE }, policyDigest: digest, capabilityDigest: digest },
        controller: { controllerLeaseId: "controller", sessionId: "parity-session", version: 1, actorId: "human", actorKind: "human-operator", expiresAt: new Date(Date.now() + 600_000).toISOString(), state: "held" },
        activeRunId: null, activeTurnId: null, nextTurnOrdinal: 1, historyCursor: 0, sessionEventCursor: 0, queueVersion: 0, workspaceBaseline: workspace.baseline().digest, forkedFromSessionId: null,
        capabilities: { literalText: true, attachments: false, attachmentReason: "typed-artifact-contract-required", commandCatalogue: true, modelRouting: true } };
      const dataDir = join(root, `state-${name}`);
      const value = await createSessionHost({ cwd, dataDir, configDir, record, runtime: assembled.value, inspectionMode: "hub-remote",
        projectContext: { source: "hub-canonical", listFlows: () => readScopedHubFlows({ hubUrl: origin, secret: machine.secret, projectId: project.id }), readFlow: (flowId) => readScopedHubFlows({ hubUrl: origin, secret: machine.secret, projectId: project.id, flowId }) },
        workspace: { ...workspace, rewind: {
          ownership: () => { lease.assertOwnership(); const baseline = workspace.baseline(); const head = currentCheckoutHead(cwd); if (head !== baseline.head) throw new MachineError("workspace-conflict"); return { nonce: lease.nonce, gitHead: head, paths: Object.keys(baseline.files) }; },
          validatePaths: async (paths, signal) => { signal.throwIfAborted(); lease.assertOwnership(); if (currentCheckoutHead(cwd) !== workspace.baseline().head) throw new MachineError("workspace-conflict"); validateOwnedEffectPaths(cwd, paths); signal.throwIfAborted(); },
        } },
        authorizeController: async () => true, authorizeQueued: async () => true, authorizeAction: async () => true, authorizeSelection: async () => true, authorizeInspection: async () => true, authorizeOwnedControl: async () => true });
      const tasks: string[] = [];
      const observed: string[] = []; value.subscribeTurnOutcome((observation) => { observed.push(`${observation.kind}:${"reason" in observation ? observation.reason : ""}:${"text" in observation ? observation.text.slice(0, 200) : ""}`); });
      const replace = (text: string) => tasks.reduce((current, task) => current.replaceAll(task, "<owned>"), text).replaceAll(value.nativeSessionId(), "<native-session>").replaceAll(dataDir, "<state>").replaceAll(cwd, "<checkout>")
        .replaceAll(/"(pid|ageMs)":\d+/g, "\"$1\":0").replaceAll(/"(previewDigest|snapshotDigest|workspaceBaseline)":"[0-9a-f]{64}"/g, "\"$1\":\"<digest>\"").replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
      return { host: value, runtime: assembled.value, tasks, observed, cwd, peerInstances, replace };
    };
    type Hosted = Awaited<ReturnType<typeof host>>;
    const busy = async (target: Hosted["host"], text = "Hold this turn open") => {
      const current = await target.inspect();
      const request: Control["StartTurnRequest"] = { sessionId: current.sessionId, expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: current.config.configVersion,
        expectedHistoryVersion: current.historyVersion, expectedWorkspaceBaseline: current.workspaceBaseline, association: { mode: "ad-hoc", profileConsentVersion: 1 }, messageId: "held-turn", text };
      const admitted = await target.apply({ kind: "message", operationId: "held-turn", payloadDigest: canonicalDigest(request), actorId: "human", runId: "held-run", turnId: "held-turn", request });
      if (admitted.status !== "admitted") throw new Error(`held turn was not admitted: ${admitted.status}`);
      // The owned run must be the session's active run before either path interrupts, or admission timing decides the outcome.
      for (let attempt = 0; attempt < 500; attempt++) { const state = await target.inspect(); if (state.state === "busy" && state.activeRunId === "held-run") return; await Bun.sleep(10); }
      throw new Error("held turn never became the active owned run");
    };
    /** A real supervised shell task in the session's own job registry, started the way shell_exec starts one. */
    const ownedTask = async (target: Hosted, phase: "background" | "foreground") => {
      const started = await target.runtime.withJobOwner({ kind: "session", identity: target.host.nativeSessionId() }, () => target.runtime.jobs.start("sleep 30", { phase, description: "native parity task" }));
      if (!started.ok) throw new Error(`owned task did not start: ${started.error}`);
      target.tasks.push(started.jobId); return { task: started.jobId };
    };
    /** The live turn's own approval waiter, created by the native policy broker for the real apply_patch call. */
    const approvalWaiter = async (target: Hosted) => {
      await busy(target.host, APPROVAL_TURN);
      for (let attempt = 0; attempt < 500; attempt++) {
        const pending = target.host.pendingApprovals()[0];
        if (pending !== undefined) { target.tasks.push(pending.approvalId, pending.fingerprint); return { approvalId: pending.approvalId, fingerprint: pending.fingerprint, policyDigest: pending.policyDigest }; }
        await Bun.sleep(10);
      }
      throw new Error(`the live turn raised no approval waiter: ${JSON.stringify((await target.host.events()).events.map((event) => event.kind === "message" ? `message:${event.message.text.slice(0, 160)}` : event.kind)).slice(0, 1500)} requests=${requests} observed=${JSON.stringify(target.observed).slice(0, 1500)}`);
    };
    /** The live turn's own ask_user question, read back through the typed questions.list reader. */
    const questionWaiter = async (target: Hosted) => {
      await busy(target.host, QUESTION_TURN); let last = "";
      for (let attempt = 0; attempt < 500; attempt++) {
        const current = await target.host.inspect(); const subject = await target.host.catalogue();
        const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: current.config.configVersion,
          catalogueDigest: subject.catalogueDigest, commandName: "questions.list", arguments: {}, busyPolicy: "reject" };
        const listed = await target.host.apply({ kind: "command", operationId: randomUUID(), payloadDigest: canonicalDigest(request), actorId: "human", request });
        const pending = "result" in listed && Array.isArray(listed.result) ? listed.result[0] : undefined; last = JSON.stringify(listed).slice(0, 600);
        if (pending !== null && typeof pending === "object" && !Array.isArray(pending) && typeof pending.questionId === "string" && typeof pending.fingerprint === "string") {
          target.tasks.push(pending.questionId, pending.fingerprint); return { questionId: pending.questionId, fingerprint: pending.fingerprint };
        }
        await Bun.sleep(10);
      }
      throw new Error(`the live turn raised no question: last=${last} requests=${requests} observed=${JSON.stringify(target.observed).slice(0, 1500)} status=${new TextDecoder().decode(Bun.spawnSync(["git", "-C", target.cwd, "status", "--porcelain=v1", "-uall", "--ignored"], { env: gitEnv }).stdout)}`);
    };
    /** One typed command on a host, exactly as a headless client sends it (fixture setup only; never a parity outcome). */
    const typedCommand = async (target: Hosted, commandName: string, args: Args) => {
      const current = await target.host.inspect(); const subject = await target.host.catalogue();
      const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: current.config.configVersion,
        catalogueDigest: subject.catalogueDigest, commandName, arguments: args, busyPolicy: "reject" };
      return target.host.apply({ kind: "command", operationId: randomUUID(), payloadDigest: canonicalDigest(request), actorId: "human", request });
    };
    /**
     * An owned turn with one approved apply_patch, run to its end: the rewind snapshot the variants select. The fixture never
     * fabricates a snapshot: when the turn ends without one, the pins stay unresolvable and both paths execute against that state.
     */
    const rewindCheckpoint = async (target: Hosted): Promise<Record<string, string>> => {
      await busy(target.host, REWIND_TURN);
      let pending: ReturnType<Hosted["host"]["pendingApprovals"]>[number] | undefined;
      for (let attempt = 0; attempt < 500 && pending === undefined; attempt++) { pending = target.host.pendingApprovals()[0]; if (pending === undefined) await Bun.sleep(10); }
      if (pending !== undefined) await typedCommand(target, "approvals.allow-once", { approvalId: pending.approvalId, runId: pending.runId, turnId: pending.turnId, fingerprint: pending.fingerprint, policyDigest: pending.policyDigest });
      let ended: Control["SessionRecord"] | undefined;
      for (let attempt = 0; attempt < 1000 && ended === undefined; attempt++) { const state = await target.host.inspect(); if (state.state !== "busy" && state.activeRunId === null) ended = state; else await Bun.sleep(10); }
      if (ended === undefined) throw new Error(`the rewind fixture turn never ended: ${JSON.stringify(target.observed).slice(0, 1500)}`);
      const unresolved = { historyVersion: String(ended.historyVersion), previewDigest: "0".repeat(64), workspaceBaseline: ended.workspaceBaseline };
      const preview = await typedCommand(target, "rewind.preview", { seq: 1, mode: "files", expectedHistoryVersion: ended.historyVersion });
      if (!("result" in preview) || typeof preview.result !== "string") return unresolved;
      const parsed = JSON.parse(preview.result) as { ok?: boolean; data?: { previewDigest?: string; workspaceBaseline?: string } };
      return parsed.ok === true && parsed.data?.previewDigest !== undefined && parsed.data.workspaceBaseline !== undefined
        ? { historyVersion: String(ended.historyVersion), previewDigest: parsed.data.previewDigest, workspaceBaseline: parsed.data.workspaceBaseline } : unresolved;
    };
    /** An owned turn held open with one literal message queued behind it: the qN item the queue variants select, with its exact versions. */
    const queuedMessage = async (target: Hosted): Promise<Record<string, string>> => {
      await busy(target.host);
      const current = await target.host.inspect();
      const request: Control["StartTurnRequest"] = { sessionId: current.sessionId, expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 }, expectedConfigVersion: current.config.configVersion,
        expectedHistoryVersion: current.historyVersion, expectedWorkspaceBaseline: current.workspaceBaseline, association: RUN_ASSOCIATION, messageId: "queued-message", text: "Queued behind the held turn" };
      const queued = await target.host.apply({ kind: "message", operationId: "queued-message", payloadDigest: canonicalDigest(request), actorId: "human", runId: "queued-run", turnId: "queued-turn", request });
      if (queued.status !== "queued") throw new Error(`the fixture message was not queued: ${queued.status}`);
      const page = await target.host.queue(); const item = page.items.find((entry) => entry.operationId === "queued-message");
      if (item === undefined) throw new Error("the queued fixture message is not in the queue");
      target.tasks.push(item.queueItemId);
      return { sessionVersion: String((await target.host.inspect()).version), queueItemId: item.queueItemId, queueVersion: String(page.queueVersion), itemVersion: String(item.version) };
    };
    /** A real separate process joined to this checkout's local bus as `@peer` (a bus instance is per process). */
    const busPeer = async (target: Hosted): Promise<Record<string, string>> => {
      const script = `const { joinBus } = await import(${JSON.stringify(join(import.meta.dir, "../src/bus/client.ts"))}); const peer = await joinBus({ cwd: ${JSON.stringify(target.cwd)}, sessionId: ${JSON.stringify(PEER_SESSION)}, surface: "headless", env: {}, status: () => ({ status: "idle", activity: "parity peer" }), onEvent: () => {}, onPeers: () => {} }); if ("disabled" in peer) process.exit(3); await peer.rename("peer"); console.log(peer.instanceId); setInterval(() => {}, 1000);`;
      const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], { env: { ...gitEnv }, stdout: "pipe", stderr: "ignore" });
      peerProcesses.push(child);
      const reader = child.stdout.getReader(); const first = await reader.read(); reader.releaseLock();
      const instanceId = new TextDecoder().decode(first.value).trim(); if (!/^[0-9a-f-]{36}$/.test(instanceId)) throw new Error("bus peer did not join");
      target.peerInstances.push(instanceId); target.tasks.push(instanceId);
      for (let attempt = 0; attempt < 300; attempt++) { if (target.runtime.integrationPort()?.bus?.peers().some((peer) => peer.record.name === "peer" && peer.state === "live")) return {}; await Bun.sleep(20); }
      throw new Error("the session bus never observed the live peer");
    };
    const peerProcesses: Bun.Subprocess<"ignore", "pipe", "ignore">[] = [];
    // `{#name}` as a whole value binds a numeric slot as a number; `{name}` substitutes text.
    const bind = (value: Json, slots: Readonly<Record<string, string>>): Json => typeof value === "string" && /^\{#\w+\}$/.test(value) && slots[value.slice(2, -1)] !== undefined ? Number(slots[value.slice(2, -1)])
      : typeof value === "string" ? Object.entries(slots).reduce((current, [key, slot]) => current.replaceAll(`{${key}}`, slot), value)
      : Array.isArray(value) ? value.map((item) => bind(item, slots)) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item, slots)])) : value;
    let catalogue: Control["CommandCatalogue"] | undefined;
    const outcomes: ParityOutcome[] = [];
    for (const item of input.cases) {
      const tools = item.case.scenario === "approval-waiter" || item.case.scenario === "rewind-checkpoint" ? ["read_file", "apply_patch"] : item.case.scenario === "question-waiter" ? ["read_file", "ask_user"] : undefined;
      const [local, headless] = await Promise.all([host(tools), host(tools)]);
      try {
        const subject = await headless.host.catalogue();
        if (catalogue === undefined) catalogue = subject;
        else if (catalogue.catalogueDigest !== subject.catalogueDigest || (await local.host.catalogue()).catalogueDigest !== subject.catalogueDigest) throw new Error("parity subject catalogue changed between hosts");
        const scenario = item.case.scenario;
        if (scenario === "active-turn") await Promise.all([busy(local.host), busy(headless.host)]);
        const owned = (target: Hosted): Promise<Record<string, string>> => scenario === "background-task" || scenario === "foreground-task" ? ownedTask(target, scenario === "background-task" ? "background" : "foreground")
          : scenario === "approval-waiter" ? approvalWaiter(target) : scenario === "rewind-checkpoint" ? rewindCheckpoint(target) : scenario === "queued-message" ? queuedMessage(target) : scenario === "question-waiter" ? questionWaiter(target) : scenario === "bus-peer" ? busPeer(target) : Promise.resolve({});
        const [localOwned, headlessOwned] = await Promise.all([owned(local), owned(headless)]);
        const localSlots = { ...shared, ...localOwned }; const headlessSlots = { ...shared, ...headlessOwned };
        // The operator's explicit work mode is the same ad-hoc association the headless request carries.
        const terminal = createTerminalSessionAdapter(local.host, { actorId: "human", controllerLeaseId: "controller", controllerVersion: 1, work: RUN_ASSOCIATION });
        const typed = item.case.arguments === null ? null : bind(item.case.arguments, headlessSlots) as Args;
        // The operator's earlier lines in this same terminal (e.g. the preview a confirm applies) run first; only the final line is the outcome.
        for (const earlier of item.case.before ?? []) await terminal.execute(String(bind(earlier, localSlots)));
        // Both paths start from the same state at the same moment; neither waits on the other's side effects.
        const [localOutcome, headlessOutcome] = await Promise.all([
          terminal.execute(String(bind(item.case.line, localSlots))).then((receipt) => outcomeOf(receipt, local.replace)),
          (async (): Promise<NativeNormalizedOutcome | null> => {
            if (typed === null || item.handlerName === null) return null;
            const operation = item.case.operation;
            if (operation === "remove-queue") return outcomeOf(await headless.host.apply({ kind: operation, operationId: randomUUID(), payloadDigest: canonicalDigest(typed), actorId: "human", request: typed as unknown as Control["QueueRemove"] }), headless.replace);
            if (operation === "edit-queue") return outcomeOf(await headless.host.apply({ kind: operation, operationId: randomUUID(), payloadDigest: canonicalDigest(typed), actorId: "human", request: typed as unknown as Control["QueueEdit"] }), headless.replace);
            const current = await headless.host.inspect(); const entry = subject.entries.find((row) => row.commandName === item.handlerName);
            const request: Control["CommandInvoke"] = { expectedSessionVersion: current.version, controller: { controllerLeaseId: "controller", expectedControllerVersion: 1 },
              expectedConfigVersion: current.config.configVersion, catalogueDigest: subject.catalogueDigest, commandName: item.handlerName, arguments: typed, busyPolicy: "reject" };
            return outcomeOf(await headless.host.apply({ kind: "command", operationId: randomUUID(), payloadDigest: canonicalDigest(request), actorId: "human", request,
              ...(entry?.mutationClass === "workspace" ? { ...RUN, association: RUN_ASSOCIATION } : {}) }), headless.replace);
          })(),
        ]);
        outcomes.push({ variantId: item.variantId, handlerName: item.handlerName, local: localOutcome, headless: headlessOutcome });
      } finally {
        for (const finish of [...held]) finish();
        await Promise.all([local.host.dispose("native-parity"), headless.host.dispose("native-parity")]);
        for (const child of peerProcesses.splice(0)) { child.kill(); await child.exited; }
      }
    }
    if (catalogue === undefined) throw new Error("no parity case executed");
    return { catalogue, outcomes };
  } finally { for (const stop of stops) await stop(); server.stop(true); await hub.stop(true); await rm(root, { recursive: true, force: true }); }
}

async function sha256(root: string, file: string): Promise<string> {
  try { return createHash("sha256").update(await readFile(join(root, file), "utf8")).digest("hex"); } catch { return ""; }
}
async function sourceHashes(root: string, inventory: NativeCoverageInventory): Promise<Map<string, string>> {
  const paths = new Set(inventory.commands.flatMap((command) => command.sources.map((source) => source.path)));
  return new Map(await Promise.all([...paths].map(async (file) => [file, await sha256(root, file)] as const)));
}
/** Executes every audited variant in an isolated child: synthetic HOME/XDG/config and data dirs, no inherited credentials or ambient configuration. */
export async function collectParityRun(root: string, inventory: NativeCoverageInventory, only?: readonly string[]): Promise<ParityRun> {
  const work = await mkdtemp(join(tmpdir(), "native-parity-run-"));
  try {
    const home = join(work, "home"); const xdg = join(work, "xdg"); await mkdir(join(xdg, "keryx"), { recursive: true }); await mkdir(home);
    // The doctor version probe would otherwise reach the public registry; a fresh synthetic failure backoff keeps it local.
    await writeFile(join(xdg, "keryx", "version-check.json"), JSON.stringify({ failureAt: Date.now() }));
    const rows = inventory.variants.filter((row) => only === undefined || only.includes(row.id));
    const input = join(work, "cases.json"); const output = join(work, "outcomes.json");
    await writeFile(input, JSON.stringify({ cases: rows.map((row) => ({ variantId: row.id, handlerName: row.handlerName, case: parityCaseFor(row) })) }));
    const child = Bun.spawn([process.execPath, "--no-env-file", join(root, "scripts/verify-native-coverage.ts"), "--harness", input, output], { cwd: root, stdout: "pipe", stderr: "pipe",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_DATA_HOME: xdg, XDG_CONFIG_HOME: join(work, "xdg-config"), KERYX_DATA_DIR: join(work, "data"), TMPDIR: work, LANG: "C.UTF-8" } });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    if (code !== 0) throw new NativeCoverageGateError("parity-harness-failed", stderr.slice(-2000));
    return JSON.parse(await readFile(output, "utf8")) as ParityRun;
  } finally { await rm(work, { recursive: true, force: true }); }
}
export class NativeCoverageGateError extends Error { constructor(readonly code: string, detail = "") { super(detail.length === 0 ? code : `${code}: ${detail}`); this.name = "NativeCoverageGateError"; } }
export function receiptsFor(inventory: NativeCoverageInventory, run: ParityRun, hashes: ReadonlyMap<string, string>): NativeParityReceipt[] {
  return run.outcomes.map((outcome) => {
    const row = inventory.variants.find((variant) => variant.id === outcome.variantId); if (row === undefined) throw new NativeCoverageGateError("unknown-parity-variant", outcome.variantId);
    const command = inventory.commands.find((entry) => entry.commandName === row.commandName); const parity = parityCaseFor(row);
    const body: Omit<NativeParityReceipt, "receiptDigest"> = { schema: 1, id: parityReceiptId(row.id), variantId: row.id, commandName: row.commandName, handlerName: row.handlerName, catalogueDigest: run.catalogue.catalogueDigest,
      sources: (command?.sources ?? []).map((source) => ({ ...source, sha256: hashes.get(source.path) ?? "" })),
      local: { line: parity.line, outcome: outcome.local }, headless: { arguments: outcome.headless === null ? null : parity.arguments, outcome: outcome.headless, ...(parity.operation === undefined ? {} : { operation: parity.operation }) } };
    return { ...body, receiptDigest: nativeParityReceiptDigest(body) };
  });
}
function describe(outcome: NativeNormalizedOutcome | null): string { return outcome === null ? "not sent" : `${outcome.status}${outcome.errorCode === null ? "" : `/${outcome.errorCode}`}`; }
/** Refreshes the audit subject from executed receipts only: pins move to the hashes the receipts ran against, and status follows observed parity. */
export function refreshInventory(inventory: NativeCoverageInventory, receipts: readonly NativeParityReceipt[], catalogue: Control["CommandCatalogue"], hashes: ReadonlyMap<string, string>): NativeCoverageInventory {
  const next = structuredClone(inventory);
  for (const command of next.commands) {
    command.expectedVariants = [...new Set(command.expectedVariants)];
    if (command.expectedVariants.every((id) => receipts.some((receipt) => receipt.variantId === id))) command.sources = command.sources.map((source) => ({ ...source, sha256: hashes.get(source.path) ?? source.sha256 }));
  }
  for (const row of next.variants) {
    const entry = catalogue.entries.find((item) => item.commandName === row.handlerName);
    if (entry !== undefined) { row.inputSchema = entry.inputSchema; row.resultSchema = entry.resultSchema; row.busyPolicy = entry.busyPolicy; row.confirmation = entry.confirmation; }
    if (row.classification !== "required") continue;
    row.proofIds = [parityReceiptId(row.id)];
    const receipt = receipts.find((item) => item.variantId === row.id);
    const parity = receipt === undefined ? { matched: false, admitted: false } : receiptParity(receipt);
    const known = KNOWN_GAPS[row.id] ?? (JEV.has(row.id) ? "Jev analysis execution needs explicit local Jev setup and consent; none is configured in the native subject." : undefined);
    if (parity.admitted && entry?.availability === "available") { row.status = "implemented"; row.reason = "Exact-source local terminal and headless host outcomes match and the shared handler accepts the variant."; continue; }
    row.status = "unimplemented";
    const observed = receipt === undefined ? "no receipt" : `local ${describe(receipt.local.outcome)}, headless ${describe(receipt.headless.outcome)}`;
    row.reason = known !== undefined ? `${known} Observed: ${observed}.`
      : row.handlerName === null || entry === undefined ? `No native handler exists for this parsed action. Observed: ${observed}.`
      : entry.availability !== "available" ? `${entry.availability}: ${entry.reason}. Observed: ${observed}.`
      : receipt?.headless.outcome === null ? `No typed native request expresses this parsed action; the terminal adapter alone reports ${describe(receipt.local.outcome)}.`
      : parity.matched ? `Both paths refuse the variant (${observed}).`
      : `The local terminal adapter and the headless host disagree (${observed}).`;
  }
  return next;
}
export interface NativeCoverageVerification { inventory: NativeCoverageInventory; refreshed: NativeCoverageInventory; receipts: NativeParityReceipt[]; result: NativeCoverageResult; descriptor: NativeCoverageDescriptor; catalogue: Control["CommandCatalogue"] }
/** Executes, refreshes and guards. `useRefreshed` = --write semantics; otherwise the committed inventory is judged as it stands. */
export async function verifyNativeCoverage(root: string, options: { useRefreshed: boolean; inventory?: NativeCoverageInventory }): Promise<NativeCoverageVerification> {
  const inventory = options.inventory ?? await readInventory(root);
  const before = await sourceHashes(root, inventory);
  const run = await collectParityRun(root, inventory);
  const after = await sourceHashes(root, inventory);
  if ([...before].some(([file, hash]) => after.get(file) !== hash)) throw new NativeCoverageGateError("source-changed-during-parity-run");
  return judgeNativeCoverage(root, inventory, run, before, options.useRefreshed);
}
export async function readInventory(root: string): Promise<NativeCoverageInventory> { return JSON.parse(await readFile(join(root, INVENTORY_PATH), "utf8")) as NativeCoverageInventory; }
export { sourceHashes };
/** Judges one executed run: receipts bind the hashes the run executed against; the guard then judges the committed or refreshed audit. */
export async function judgeNativeCoverage(root: string, inventory: NativeCoverageInventory, run: ParityRun, hashes: ReadonlyMap<string, string>, useRefreshed: boolean): Promise<NativeCoverageVerification> {
  const receipts = receiptsFor(inventory, run, hashes);
  const refreshed = refreshInventory(inventory, receipts, run.catalogue, hashes);
  const judged = useRefreshed ? refreshed : inventory;
  const registryNames = registeredNativeCommandNames();
  const result = await checkNativeCommandCoverage({ cwd: root, registryNames, catalogue: run.catalogue, inventory: judged, receipts });
  const descriptor = buildNativeCoverageDescriptor({ registryNames, catalogue: run.catalogue, contractCatalogue: currentNativeCoverageSubject().catalogue, inventory: coreInventory(judged), result });
  return { inventory, refreshed, receipts, result, descriptor, catalogue: run.catalogue };
}
/** The audited subject without derived report fields, so a report refresh never changes the descriptor. */
export function coreInventory(inventory: NativeCoverageInventory): NativeCoverageInventory {
  return { schema: inventory.schema, registryDigest: inventory.registryDigest, commands: inventory.commands, variants: inventory.variants };
}
export function renderDescriptorModule(descriptor: NativeCoverageDescriptor): string {
  return `// Generated by scripts/verify-native-coverage.ts --write from executed local/headless parity receipts. Do not edit:\n`
    + `// the runtime refuses a descriptor that does not hash to its own body or that names another registry or command contract.\n`
    + `export const NATIVE_COVERAGE_DESCRIPTOR: unknown = ${JSON.stringify(descriptor, null, 2)};\n`;
}
/** Release/package guard: the embedded descriptor must validate and equal the one re-derived from a fresh execution of the committed inventory. */
export function checkEmbeddedDescriptor(verification: Pick<NativeCoverageVerification, "inventory" | "refreshed" | "descriptor">, embedded: unknown, release: boolean): { ok: true; descriptor: NativeCoverageDescriptor } | { ok: false; code: string } {
  const valid = validateNativeCoverageDescriptor(embedded, currentNativeCoverageSubject());
  if (!valid.ok) return { ok: false, code: valid.code };
  if (canonicalDigest(coreInventory(verification.inventory)) !== canonicalDigest(coreInventory(verification.refreshed))) return { ok: false, code: "inventory-stale" };
  if (valid.descriptor.descriptorDigest !== verification.descriptor.descriptorDigest) return { ok: false, code: "descriptor-stale" };
  if (release && !valid.releaseReady) return { ok: false, code: "not-release-ready" };
  return { ok: true, descriptor: valid.descriptor };
}
async function embeddedDescriptor(root: string): Promise<unknown> {
  try { return (await import(join(root, DESCRIPTOR_PATH)) as { NATIVE_COVERAGE_DESCRIPTOR?: unknown }).NATIVE_COVERAGE_DESCRIPTOR; } catch { return undefined; }
}
function summary(verification: NativeCoverageVerification) {
  const { descriptor } = verification;
  return { releaseReady: descriptor.releaseReady, counts: descriptor.counts, requiredGaps: descriptor.requiredGaps.map((gap) => `${gap.variantId}:${gap.code}`), otherBlockers: descriptor.otherBlockers.map((row) => `${row.code}:${row.subject}`) };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--harness" && args.length === 3) {
    const input = JSON.parse(await readFile(args[1]!, "utf8")) as Parameters<typeof runHarness>[0];
    await writeFile(args[2]!, JSON.stringify(await runHarness(input)));
  } else if (args.length === 1 && ["--write", "--check", "--release"].includes(args[0]!)) {
    const root = resolve(import.meta.dir, "..");
    const mode = args[0]!;
    const verification = await verifyNativeCoverage(root, { useRefreshed: mode === "--write" });
    if (mode === "--write") {
      const report = { ...verification.refreshed, catalogueSubject: { digest: verification.catalogue.catalogueDigest, contractDigest: verification.descriptor.contractDigest, entryCount: verification.catalogue.entries.length },
        summary: { registered: verification.result.registeredCommands, variants: verification.refreshed.variants.length, earned: verification.descriptor.counts.earned, requiredGaps: verification.descriptor.counts.requiredGaps, releaseReady: verification.descriptor.releaseReady },
        receipts: verification.receipts.map((receipt) => ({ variantId: receipt.variantId, local: receipt.local.line, localOutcome: describe(receipt.local.outcome), headlessOutcome: describe(receipt.headless.outcome), matched: receiptParity(receipt).matched, receiptDigest: receipt.receiptDigest })),
        lastCheck: verification.result };
      const previous = JSON.parse(await readFile(join(root, INVENTORY_PATH), "utf8")) as Record<string, unknown>;
      await writeFile(join(root, INVENTORY_PATH), JSON.stringify({ ...previous, ...report }, null, 2) + "\n");
      await writeFile(join(root, DESCRIPTOR_PATH), renderDescriptorModule(verification.descriptor));
      console.log(JSON.stringify(summary(verification), null, 2));
    } else {
      const checked = checkEmbeddedDescriptor(verification, await embeddedDescriptor(root), mode === "--release");
      console.log(JSON.stringify({ ...summary(verification), embedded: checked.ok ? "current" : checked.code }, null, 2));
      if (!checked.ok) { console.error(`native coverage ${mode.slice(2)} refused: ${checked.code}`); process.exit(1); }
    }
  } else {
    console.error("Usage: bun scripts/verify-native-coverage.ts --write | --check | --release");
    process.exit(2);
  }
}
