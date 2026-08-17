import { optionValue } from "../lib/args";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { localWorkspaceAuthorizationServer, newWorkspaceId, WorkspaceService, type WorkspaceResource } from "../sac/workspace-service";
import { createLocalFwkReadService, diagnosePolicyReadiness, normalizeFwkResult } from "../sac/fwk-service";
import { formatFwkExplain } from "../sac/fwk-explain";
import { createHarnessProposalLifecycleService, createLocalProposalLifecycleService, normalizeProposalLifecycleResult } from "../sac/proposal-lifecycle";
import { createLocalCollaborationService } from "../sac/collaboration-service";
import { sessionEvidenceRef } from "../sac/session-wrap-up";
import { proposalNotePath } from "../sac/proposal-evidence";
import { mintConfirmToken } from "../sac/review-confirm-token";
import { findSession } from "../session/store";
import { buildCatchUp, type CatchUpReport } from "../sac/catch-up";

// Every kind a real writer now exists for: wiki-update -> wiki, memory-entry
// -> memory, everything else -> skill (see ownerFor in proposal-lifecycle.ts).
const PROPOSAL_KINDS = ["decision", "wiki-update", "memory-entry", "follow-up", "contract-change", "risk"] as const;

function service(): WorkspaceService {
  return new WorkspaceService({
    workspaceRoot: process.cwd(),
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
}

export async function workspaceCommand(args: string[]): Promise<void> {
  const subcommand = args[0];
  if (!subcommand || subcommand === "help" || args.includes("--help") || args.includes("-h")) return printHelp();
  try {
    if (subcommand === "create") {
      rejectUnknownOptions(args.slice(1), new Set(["--title", "--component"]));
      const title = optionValue(args, "--title");
      const component = optionValue(args, "--component");
      if (!title) throw new Error("Usage: keryx workspace create --title <title> [--component <workspace-relative-ref>]");
      const workspace = await service().create({ request: undefined, requestCorrelationId: randomUUID(), id: newWorkspaceId(), title, ...(component ? { component: { kind: "component" as const, uri: component } } : {}) });
      console.log(JSON.stringify(workspace, null, 2)); return;
    }
    if (subcommand === "list") {
      rejectUnknownOptions(args.slice(1), new Set(["--include-archived"]));
      const includeArchived = booleanFlag(args, "--include-archived");
      console.log(JSON.stringify(await service().list({ request: undefined, requestCorrelationId: randomUUID(), includeArchived }), null, 2)); return;
    }
    if (subcommand === "show") {
      rejectUnknownOptions(args.slice(2), new Set());
      const id = args[1]; if (!id) throw new Error("Usage: keryx workspace show <workspace-id>");
      console.log(JSON.stringify(await service().show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId: id }), null, 2)); return;
    }
    if (subcommand === "add-resource") {
      rejectUnknownOptions(args.slice(2), new Set(["--kind", "--uri", "--revision"]));
      const workspaceId = args[1]; const kind = optionValue(args, "--kind") as WorkspaceResource["kind"] | undefined; const uri = optionValue(args, "--uri"); const revision = optionValue(args, "--revision");
      if (!workspaceId || !kind || !uri) throw new Error("Usage: keryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]");
      console.log(JSON.stringify(await service().addResource({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, resource: { kind, uri, ...(revision ? { revision } : {}) } }), null, 2)); return;
    }
    if (subcommand === "archive") {
      rejectUnknownOptions(args.slice(2), new Set());
      const workspaceId = args[1]; if (!workspaceId) throw new Error("Usage: keryx workspace archive <workspace-id>");
      console.log(JSON.stringify(await service().archive({ request: undefined, requestCorrelationId: randomUUID(), workspaceId }), null, 2)); return;
    }
    if (subcommand === "remove-resource") {
      rejectUnknownOptions(args.slice(2), new Set(["--uri"]));
      const workspaceId = args[1]; const uri = optionValue(args, "--uri");
      if (!workspaceId || !uri) throw new Error("Usage: keryx workspace remove-resource <workspace-id> --uri <workspace-relative-ref>");
      console.log(JSON.stringify(await service().removeResource({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, uri }), null, 2)); return;
    }
    if (subcommand === "rename") {
      rejectUnknownOptions(args.slice(2), new Set(["--title"]));
      const workspaceId = args[1]; const title = optionValue(args, "--title");
      if (!workspaceId || !title) throw new Error("Usage: keryx workspace rename <workspace-id> --title <title>");
      console.log(JSON.stringify(await service().rename({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, title }), null, 2)); return;
    }
    if (subcommand === "overview") {
      rejectUnknownOptions(args.slice(2), new Set(["--max-items", "--max-tokens", "--explain"]));
      const workspaceId = args[1]; if (!workspaceId) throw new Error("Usage: keryx workspace overview <workspace-id> [--max-items N] [--max-tokens N] [--explain]");
      const maxItems = Number(optionValue(args, "--max-items") ?? "32"); const maxTokens = Number(optionValue(args, "--max-tokens") ?? "4096");
      if (!Number.isInteger(maxItems) || !Number.isInteger(maxTokens) || maxItems < 0 || maxTokens < 0) throw new Error("--max-items and --max-tokens must be non-negative integers");
      const result = await createLocalFwkReadService(process.cwd()).overview({ workspaceId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } });
      const normalized = normalizeFwkResult(result);
      console.log(JSON.stringify(normalized, null, 2));
      if (args.includes("--explain")) console.error(formatFwkExplain(normalized));
      return;
    }
    if (subcommand === "read") {
      rejectUnknownOptions(args.slice(3), new Set(["--max-items", "--max-tokens", "--explain"]));
      const workspaceId = args[1]; const itemId = args[2];
      if (!workspaceId || !itemId) throw new Error("Usage: keryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N] [--explain]");
      const maxItems = Number(optionValue(args, "--max-items") ?? "1"); const maxTokens = Number(optionValue(args, "--max-tokens") ?? "4096");
      if (!Number.isInteger(maxItems) || !Number.isInteger(maxTokens) || maxItems < 0 || maxTokens < 0) throw new Error("--max-items and --max-tokens must be non-negative integers");
      const result = await createLocalFwkReadService(process.cwd()).read({ workspaceId, itemId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } });
      const normalized = normalizeFwkResult(result);
      console.log(JSON.stringify(normalized, null, 2));
      if (args.includes("--explain")) console.error(formatFwkExplain(normalized));
      return;
    }
    if (subcommand === "propose") {
      rejectUnknownOptions(args.slice(2), new Set(["--kind", "--session", "--note", "--proposal-revision"]));
      const workspaceId = args[1];
      const kind = optionValue(args, "--kind");
      const sessionRef = optionValue(args, "--session");
      const note = optionValue(args, "--note");
      const proposalRevision = optionValue(args, "--proposal-revision") ?? "1";
      if (!workspaceId || !kind || !sessionRef) throw new Error(`Usage: keryx workspace propose <workspace-id> --kind <${PROPOSAL_KINDS.join("|")}> --session <session-id> [--note <one-line note>]`);
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown --kind "${kind}" — expected one of: ${PROPOSAL_KINDS.join(", ")}`);
      const cwd = process.cwd();
      // Resolve the human-friendly id/prefix to a canonical session id ONLY to build
      // a schema-valid `sourceRef` path — resolveSessionWrapUp independently re-looks
      // this session up itself and never trusts this resolution as evidence.
      const session = findSession(cwd, sessionRef);
      if (!session) throw new Error(`no session matching "${sessionRef}" in this project — use \`keryx sessions list\``);
      const { service, wrapUpAuthority, authorizationServer } = createHarnessProposalLifecycleService(cwd, { workspaceId, ...(note ? { note } : {}) });
      const requestCorrelationId = randomUUID();
      const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
      if (!actor) throw new Error("trusted ActorContext is required");
      const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: sessionEvidenceRef(workspaceId, session.id) });
      const proposal = await service.create({ request: undefined, requestCorrelationId, workspaceId, id: `proposal-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalRevision, kind: kind as never, wrapUp });
      // The note is not part of the frozen proposal schema (additionalProperties:
      // false) — it lives in a sidecar the memory owner-writer reads back at accept
      // time, since accept may happen in a different process/reviewer session.
      if (note) await writeFile(proposalNotePath(cwd, workspaceId, proposal.id), note, "utf8");
      console.log(JSON.stringify(normalizeProposalLifecycleResult(proposal), null, 2)); return;
    }
    if (subcommand === "confirm-review") {
      rejectUnknownOptions(args.slice(3), new Set());
      const workspaceId = args[1]; const proposalId = args[2];
      if (!workspaceId || !proposalId) throw new Error("Usage: keryx workspace confirm-review <workspace-id> <proposal-id>");
      // SLATE-20: mints the short-lived, single-use token `review --decision
      // accepted` requires. Deliberately its own separate shell command
      // (never an agent-native/MCP tool, never folded into `review` itself)
      // so accepting a proposal always takes two distinct approval-gated
      // shell_exec invocations, not one — an agent that only has MCP/tool
      // access, with no shell_exec at all, cannot mint this on its own.
      const { token, expiresAt } = await mintConfirmToken(process.cwd(), workspaceId, proposalId);
      console.log(JSON.stringify({ token, expiresAt }, null, 2)); return;
    }
    if (subcommand === "review") {
      rejectUnknownOptions(args.slice(3), new Set(["--decision", "--reason", "--idempotency-key", "--confirm-token"]));
      const workspaceId = args[1]; const proposalId = args[2]; const decision = optionValue(args, "--decision") as "accepted" | "rejected" | "dismissed" | undefined; const reason = optionValue(args, "--reason"); const idempotencyKey = optionValue(args, "--idempotency-key") ?? randomUUID(); const confirmToken = optionValue(args, "--confirm-token");
      if (!workspaceId || !proposalId || !decision) throw new Error("Usage: keryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed> [--reason <reason>] [--idempotency-key <key>] [--confirm-token <token>]");
      if (decision === "accepted" && !confirmToken) throw new Error("--decision accepted requires --confirm-token — run `keryx workspace confirm-review " + workspaceId + " " + proposalId + "` first");
      // Same composition as `propose`: an accept for any proposal kind must
      // see the real owner writer (memory/wiki/skill), or it lands in
      // "stale" for no real reason.
      // `interactive: true` — a human is directly invoking `keryx workspace
      // review` at the terminal (SLATE-8's unattended checkpoint; see
      // ProposalLifecycleService.review()'s gate).
      const result = await createHarnessProposalLifecycleService(process.cwd(), { workspaceId }).service.review({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, proposalId, decision, idempotencyKey, interactive: true, ...(reason ? { reason } : {}), ...(confirmToken ? { confirmToken } : {}) });
      console.log(JSON.stringify(normalizeProposalLifecycleResult(result), null, 2)); return;
    }
    if (subcommand === "collaboration") {
      rejectUnknownOptions(args.slice(2), new Set()); const workspaceId = args[1];
      if (!workspaceId) throw new Error("Usage: keryx workspace collaboration <workspace-id>");
      console.log(JSON.stringify(await createLocalCollaborationService(process.cwd()).overview({ workspaceId, request: undefined, requestCorrelationId: randomUUID() }), null, 2)); return;
    }
    if (subcommand === "policy-readiness") {
      rejectUnknownOptions(args.slice(1), new Set());
      const report = await diagnosePolicyReadiness(process.cwd());
      console.log(JSON.stringify(report, null, 2));
      if (!report.integrityReady) process.exitCode = 1;
      return;
    }
    if (subcommand === "catch-up") {
      rejectUnknownOptions(args.slice(1), new Set(["--workspace", "--json", "--include-lifecycle-flags"]));
      const workspaceId = optionValue(args, "--workspace");
      const includeLifecycleFlags = booleanFlagDefaultTrue(args, "--include-lifecycle-flags");
      const report = await buildCatchUp({ cwd: process.cwd(), ...(workspaceId ? { workspaceId } : {}) });
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else console.log(renderCatchUp(report, includeLifecycleFlags));
      return;
    }
    if (subcommand === "list-proposals") {
      rejectUnknownOptions(args.slice(2), new Set());
      const workspaceId = args[1];
      const cwd = process.cwd();
      const authorizationServer = localWorkspaceAuthorizationServer();
      const actor = await authorizationServer.actorContextFor(undefined, randomUUID());
      if (!actor) throw new Error("trusted ActorContext is required");
      if (workspaceId) {
        // Flow 165 review fix (F-001): unlike every other explicit-workspace-id
        // subcommand in this file (`show`, `add-resource`, `archive`, …), this
        // branch used to call `listProposedProposals(workspaceId)` directly
        // with no actor/ACL check — a caller with zero role in a workspace
        // could enumerate its pending proposals just by knowing/guessing the
        // id. `showForActor` is the same authorization gate `show` itself
        // uses (already throws `WorkspaceServiceError("access_denied", …)` on
        // no role); calling it here first, purely for its authorization side
        // effect, requires no new authorization plumbing.
        await service().showForActor({ actorContext: actor, workspaceId });
        console.log(JSON.stringify(await createLocalProposalLifecycleService(cwd).listProposedProposals(workspaceId), null, 2));
        return;
      }
      console.log(JSON.stringify(await createLocalProposalLifecycleService(cwd).listVisibleProposedProposals(actor), null, 2));
      return;
    }
    throw new Error(`Unknown workspace command: ${subcommand}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1;
  }
}

function rejectUnknownOptions(args: string[], allowed: Set<string>): void {
  for (const argument of args) {
    if (!argument.startsWith("--")) continue;
    const name = argument.split("=", 1)[0]!;
    if (!allowed.has(name)) throw new Error(`Unknown option: ${name}`);
  }
}

/**
 * A bare boolean flag (`--name`) or its explicit `--name=true`/`--name=false`
 * spelling. Unlike `optionValue` (built for value-taking options such as
 * `--title`), this never consumes a following bare word as the flag's value —
 * `--include-archived` has no positional argument to swallow.
 *
 * `--name=<anything else>` is a refused, explicit error rather than a silent
 * fallback to "flag absent": `args.includes("--include-archived")` previously
 * matched only the bare spelling, so `--include-archived=true` (the natural
 * spelling given every other option in this file uses `optionValue`'s `=`
 * form) silently behaved as if the flag were never passed — archived
 * workspaces stayed hidden with no error. See `optionValue`'s doc comment in
 * `src/lib/args.ts` for the prior incident this is the same class of bug as.
 */
function booleanFlag(args: string[], name: string): boolean {
  const bare = args.includes(name);
  const prefixed = args.find((argument) => argument.startsWith(`${name}=`));
  if (bare && prefixed) throw new Error(`${name} was given both bare and with a value — use one form`);
  if (bare) return true;
  if (!prefixed) return false;
  const value = prefixed.slice(name.length + 1);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Unknown value for ${name}: "${value}" — expected true or false`);
}

/**
 * Same parsing/validation as {@link booleanFlag}, but the ABSENT case
 * defaults to `true` instead of `false` — for `--include-lifecycle-flags`,
 * whose spec explicitly says "defaults to shown, not opt-in, since the
 * whole point is discoverability." An operator opts OUT with
 * `--include-lifecycle-flags=false`, never opts in.
 */
function booleanFlagDefaultTrue(args: string[], name: string): boolean {
  const bare = args.includes(name);
  const prefixed = args.find((argument) => argument.startsWith(`${name}=`));
  if (bare && prefixed) throw new Error(`${name} was given both bare and with a value — use one form`);
  if (bare) return true;
  if (!prefixed) return true;
  const value = prefixed.slice(name.length + 1);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Unknown value for ${name}: "${value}" — expected true or false`);
}

function printHelp(): void {
  console.log("keryx workspace create --title <title> [--component <workspace-relative-ref>]\nkeryx workspace list [--include-archived]\nkeryx workspace show <workspace-id>\nkeryx workspace add-resource <workspace-id> --kind <kind> --uri <workspace-relative-ref> [--revision <revision>]\nkeryx workspace archive <workspace-id>\nkeryx workspace remove-resource <workspace-id> --uri <workspace-relative-ref>\nkeryx workspace rename <workspace-id> --title <title>\nkeryx workspace overview <workspace-id> [--max-items N] [--max-tokens N] [--explain]\nkeryx workspace read <workspace-id> <item-id> [--max-items N] [--max-tokens N] [--explain]\nkeryx workspace propose <workspace-id> --kind <" + PROPOSAL_KINDS.join("|") + "> --session <session-id> [--note <one-line note>]\nkeryx workspace confirm-review <workspace-id> <proposal-id>\nkeryx workspace review <workspace-id> <proposal-id> --decision <accepted|rejected|dismissed> [--reason <reason>] [--idempotency-key <key>] [--confirm-token <token>]\nkeryx workspace collaboration <workspace-id>\nkeryx workspace policy-readiness\nkeryx workspace catch-up [--workspace <workspace-id>] [--json] [--include-lifecycle-flags]\nkeryx workspace list-proposals [<workspace-id>]");
}

/**
 * SLATE-10's human-facing catch-up rendering (agent-protocol.md's "Catch-up
 * protocol"): hard-separated headed sections (AC2's text-rendering mirror of
 * the already-separated `CatchUpReport` shape), each item as a structured
 * question + options + recommendation — never a raw JSON/diff dump. `--json`
 * (above) is the escape hatch for scripting.
 *
 * RP-13 FR3+FR4 (flow 168, Phase 2): a fifth section, `lifecycleFlags`, is
 * ALWAYS present in `report` (never gated inside `buildCatchUp` itself —
 * see that function's own doc comment) but only DISPLAYED here when
 * `includeLifecycleFlags` is true (default) — `--include-lifecycle-flags`
 * defaults to shown, per the spec's own "the whole point is
 * discoverability," so an operator opts OUT (`=false`), never in. A
 * workspace can legitimately appear in BOTH "Pending proposals" and this
 * section at once — the two are independent facts, and this rendering
 * never suppresses one because of the other.
 */
function renderCatchUp(report: CatchUpReport, includeLifecycleFlags = true): string {
  const sections: string[] = [];
  sections.push(renderSection("Pending proposals", report.proposals, (item) =>
    `- Accept, reject, or dismiss proposal ${item.proposalId} in workspace ${item.workspaceId}? ` +
    `Recommendation: ${item.fresh ? "evidence is fresh — review now (`keryx workspace review " + item.workspaceId + " " + item.proposalId + " --decision <accepted|rejected|dismissed>`)" : "evidence has drifted since this proposal was created — treat as stale, re-run wrap-up before deciding"}.`));
  sections.push(renderSection("Blocked sessions (stopped unattended)", report.blocked, (item) =>
    `- Session ${item.sessionId} stopped unattended (${item.terminalState.reason}) at ${item.terminalState.occurredAt}. Resume it, or archive and move on? ` +
    `Recommendation: \`keryx shell -r ${item.sessionId}\` to resume and unblock it.`));
  sections.push(renderSection("Unbound candidates (wrap-up ran, no workspace bound)", report.unboundCandidates, (item) =>
    `- Session ${item.sessionId} produced untriaged seeds with no workspace bound (${item.summary}). Bind to a workspace and propose, or discard? ` +
    `Recommendation: pick a workspace, then \`keryx workspace propose <workspace-id> --kind <kind> --session ${item.sessionId}\` (evidence: ${item.evidencePath}).`));
  sections.push(renderSection("Unknown (no resolution recorded)", report.unknown, (item) =>
    `- Session ${item.sessionId} was last seen ${item.lastSeenAt} with no proposal, terminal state, or unbound-candidate artifact recorded. Investigate, or ignore? ` +
    `Recommendation: \`keryx sessions list\` / \`keryx shell -r ${item.sessionId}\` to see what happened.`));
  if (includeLifecycleFlags) {
    sections.push(renderSection("Lifecycle flags (component no longer in the graph)", report.lifecycleFlags, (item) =>
      `- ${item.kind} \`${item.ref}\` scopes to \`${item.missingComponent}\`, which is no longer in the code graph (flagged ${item.flaggedAt}). Still relevant, or safe to clean up? ` +
      `Recommendation: this is report-only — nothing was archived/edited/removed automatically; ${item.kind === "workspace" ? "\`keryx workspace archive " + item.ref + "\`" : item.kind === "memory-entry" ? "\`keryx memory supersede\` or edit the entry directly" : "edit or remove the wiki page directly"} if you decide it's actually stale.`));
  }
  return sections.join("\n\n");
}

function renderSection<T>(title: string, items: readonly T[], describe: (item: T) => string): string {
  const lines = [`== ${title} ==`];
  if (items.length === 0) lines.push("(none)");
  else for (const item of items) lines.push(describe(item));
  return lines.join("\n");
}
