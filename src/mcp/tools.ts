// Tool registry: MCP Tool name -> exactly ONE createXService() method
// (specification.md §6; M-2, M-3, M-10, NG-A4).
//
// Each entry is a THIN adapter: it (de)serializes JSON-RPC params into the typed
// service input, calls a single facade method, and returns the typed result. No
// business logic lives here. `src/mcp/` imports ONLY service facades + shared
// libs + the redact seam — never a module's internals (import-boundary test
// enforces this). Read-only unless `mutating` says otherwise; no mutating tool
// bypasses a deterministic gate.

import { getAffected, getCycles, getOrphans, loadGraph } from "../gdgraph/query";
import type { GraphData } from "../gdgraph/types";
import { createSecurityService, runScan } from "../security/service";
import { scanMcpManifest } from "../security/detect/mcp";
import { createMetaprojectAdapter } from "../harness/tool/metaproject-adapter";
import { createCodeHealthService } from "../health/service";
import { createGdWikiService } from "../wiki/service";
import { createFlowService } from "../flow/service";
import { runValidate } from "../standard/service";
import { readFile, writeFile } from "node:fs/promises";
import type { SecuritySource } from "../security/types";
import { toMcpTools } from "./metaproject-tools";
import { createLocalFwkReadService, normalizeFwkResult, createHarnessProposalLifecycleService, normalizeProposalLifecycleResult, createLocalCollaborationService, normalizeCollaborationResult, sessionEvidenceRef, proposalNotePath, findSession, WorkspaceService, localWorkspaceAuthorizationServer, newWorkspaceId, closeExternalSlate, readExternalSlate, reclaimStaleExternalSlates, writeExternalSlate, resolveOrCreateWorkspace, isSlateSeedKind, SEED_TEXT_MAX_LENGTH, redactSensitiveText, type ExternalSlate, type SlateSeed, type SlateSeedKind, type ResolveOrCreateResult } from "../sac/service";
import { randomUUID } from "node:crypto";
import type { JsonSchema, ToolEntry } from "./types";

function stringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * F-003 fix (flow 182 T7, review finding — count half; the length half is
 * `SEED_TEXT_MAX_LENGTH`, `../session/slate.ts`): a cap on how many Seeds one
 * external hand can accumulate on a single `ExternalSlate` before
 * `slate.writeSeed` starts rejecting further writes. Generous but bounded —
 * matching `SEED_TEXT_MAX_LENGTH`'s own "generous but bounded" spirit — a
 * normal task-local slate's Seed count is expected to be a handful to a few
 * dozen; 200 is comfortably above any realistic single-task usage while still
 * bounding how large one `ExternalSlate` JSON file (and, downstream, one
 * `runWrapUp` evidence dump) can grow from a single misbehaving/looping
 * caller. Rejected (thrown), never silently dropped — mirrors this file's own
 * `kind`/`text` rejection style just below.
 */
const MAX_EXTERNAL_SLATE_SEEDS = 200;

// Load the code graph, degrading to an empty graph when storage is absent (the
// graph tools then return empty results rather than throwing).
async function loadGraphSafe(cwd: string): Promise<GraphData> {
  try {
    return await loadGraph(cwd);
  } catch {
    return { nodes: [], edges: [] };
  }
}

const OBJECT_SCHEMA = (
  properties: Record<string, JsonSchema> = {},
  required: string[] = [],
): JsonSchema => ({
  type: "object",
  properties,
  ...(required.length > 0 ? { required } : {}),
  additionalProperties: false,
});

// A read-only FlowService: no tracker, no health gate. `list`/`get` never touch
// those deps, so a stub keeps `flow.status` deterministic and side-effect free.
function readOnlyFlowService(): ReturnType<typeof createFlowService> {
  return createFlowService({
    tracker: null,
    healthGate: async () => ({ status: "skipped", reasons: [] }),
    now: () => new Date(),
  });
}

/**
 * Underlying `slate.open` implementation, extracted from the MCP tool entry
 * below (flow 182 T5, fixing a T3 gap) so it can be called two ways:
 *  - the registered `slate.open` MCP tool calls it with `resolveWorkspace`
 *    left unset, getting the REAL `resolveOrCreateWorkspace` (real
 *    `workspace_list`/`workspace_create` tool calls, a real bounded model
 *    turn) — production behavior is unchanged by this seam existing.
 *  - `slate-tools.test.ts` imports and calls this function DIRECTLY to
 *    inject a deterministic fake resolver. There is no way to pass a
 *    function through the MCP `invoke(cwd, params, context)` boundary
 *    (params are JSON-RPC-shaped data, never callables) the way
 *    `sac.*`/other tools are exercised in `sac-tools.test.ts` — unlike
 *    `runGoalCommand` (`src/commands/goal-command.ts`), which every test in
 *    `goal-command.test.ts` already calls directly and can pass a
 *    `resolveWorkspace` argument to. This mirrors that exact seam shape
 *    (`RunGoalCommandParams.resolveWorkspace`) rather than reinventing one:
 *    an optional resolver, defaulting to the real SLATE-16 procedure.
 *
 * specification.md's v3 MCP surface section: "`slate.open`'s no-`workspaceId`
 * path calls SLATE-16's existing resolve-or-create procedure, not a new
 * one." AC5 (this flow's frozen acceptance-criteria.md) names that exact
 * path as a legitimate binding source alongside an explicit `slate.open`
 * `workspaceId` param. On `resolved.ok === false` (any reason —
 * `no_credential`/`ambiguous`/`error`), `workspaceId` stays unset exactly as
 * the pre-fix fallback already did — this never throws and never blocks
 * `slate.open` itself, mirroring `runGoalCommand`'s identical "a resolver
 * that fails/is ambiguous never blocks /goal" behavior for the same
 * SLATE-16 call.
 */
export interface HandleSlateOpenParams {
  cwd: string;
  externalSessionId: string;
  workspaceId?: string;
  anchors?: unknown;
  resolveWorkspace?: (input: { cwd: string; topicHint: string }) => Promise<ResolveOrCreateResult>;
}

export async function handleSlateOpen(params: HandleSlateOpenParams): Promise<ExternalSlate> {
  const { cwd, externalSessionId, resolveWorkspace } = params;
  if (externalSessionId.length === 0) throw new Error("slate.open requires a non-empty 'externalSessionId'");
  await reclaimStaleExternalSlates(cwd);
  // AC-35: idempotent per id — a second `slate.open` for an id that already
  // has a live external slate returns it completely unmodified, never a
  // second file, never an error, and never re-resolves a workspace.
  const existing = await readExternalSlate(cwd, externalSessionId);
  if (existing) return existing;
  const rawAnchors = (params.anchors && typeof params.anchors === "object" ? params.anchors : {}) as {
    root?: unknown;
    touched?: unknown;
    note?: unknown;
  };
  // AC-36: exactly what the caller supplied — no tree/runtime/fence, no
  // tree-walk/worktree-resolve/runtime-probing of a process this harness
  // does not control.
  const anchors = {
    root: typeof rawAnchors.root === "string" ? rawAnchors.root : "",
    ...(Array.isArray(rawAnchors.touched) ? { touched: rawAnchors.touched.filter((t): t is string => typeof t === "string") } : {}),
    ...(typeof rawAnchors.note === "string" ? { note: rawAnchors.note } : {}),
  };
  let workspaceId = params.workspaceId;
  if (workspaceId === undefined) {
    // SLATE-16: an explicit `workspaceId` param always wins (checked above,
    // unchanged); when omitted, resolve-or-create now actually runs instead
    // of leaving it unset unconditionally (the T3 gap this fixes) — mirrors
    // `goal-command.ts`'s own `/goal` wiring for the identical procedure.
    //
    // Finding 2 fix (flow 182 T7, logic review): this call used to have no
    // try/catch at all — if `resolver` genuinely THREW (not just returned
    // `{ok:false,...}`; e.g. a real network error inside a real model-turn
    // call), the exception propagated straight out of `handleSlateOpen`,
    // never writing an `ExternalSlate` at all and silently losing the
    // caller's `anchors` even though `slate.open` was called with valid
    // params — contradicting this function's own doc comment's claim to
    // mirror `runGoalCommand`'s (`src/commands/goal-command.ts`) identical
    // "a resolver that fails/is ambiguous never blocks /goal" behavior for
    // this same SLATE-16 call, which `goal-command.ts` actually implements
    // via a try/catch around this exact call (see that file's own review
    // finding 3 comment). Degrading to "leave `workspaceId` unset" on a
    // thrown error — the same outcome an `ok: false` result already
    // produces — actually replicates that cited precedent instead of just
    // citing it.
    const resolver = resolveWorkspace ?? resolveOrCreateWorkspace;
    const topicHint = anchors.note ?? (anchors.root.length > 0 ? anchors.root : externalSessionId);
    try {
      const resolved = await resolver({ cwd, topicHint });
      if (resolved.ok) workspaceId = resolved.workspaceId;
    } catch {
      // Fail-open for `slate.open` itself, fail-closed for the bind: never
      // block opening this hand's own slate over a resolver failure —
      // `workspaceId` simply stays unset, identical to an `ok: false` result.
    }
  }
  return writeExternalSlate(cwd, externalSessionId, () => ({
    externalSessionId,
    ...(workspaceId ? { workspaceId } : {}),
    anchors,
    seeds: [],
    lastWriteAt: new Date().toISOString(),
  }));
}

export function buildToolRegistry(): ToolEntry[] {
  // Unified metaproject read tools, projected from the single METAPROJECT_OPERATIONS
  // source (flow 038) via `toMcpTools` (flow 040). These are additive and read-only
  // (M-10): the historical hardcoded adapters below expose the same underlying
  // reads under their own legacy names/shapes and are preserved for test + shape
  // stability (see the flow 040 journal). No name collides with a legacy adapter.
  return [
    ...toMcpTools(),
    { name: "sac.collaboration", module: "sac", description: "Read the collaboration references and activity for one Shared Agent Context workspace — who is participating and what has moved recently, redacted to what this actor may see. Local stdio only: over HTTP it returns `sac_transport_denied` without reading anything, because HTTP has no verified principal and must not inherit the local OS actor. Returns references and activity, not the items themselves — use sac.overview to enumerate items and sac.read to fetch one. Discover the workspaceId with sac.workspaceList.", inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" } }, ["workspaceId"]), mutating: false, async invoke(cwd, params, context) { if (context?.transport === "http") return { code: "sac_transport_denied" as const }; return normalizeCollaborationResult(await createLocalCollaborationService(cwd).overview({ workspaceId: stringParam(params, "workspaceId") ?? "", request: undefined, requestCorrelationId: randomUUID() })); } },
    {
      name: "sac.overview", module: "sac", description: "Enumerate the items in one Shared Agent Context workspace, bounded by a budget: `maxItems` defaults to 32, `maxTokens` to 4096. The budget is all-or-nothing, not a page: this tool passes no optional ids, so every candidate is required, and a workspace that does not fit returns `{ code: \"context_overflow\", requiredId }` with no manifest and no receipt at all. Branch on a `code` field before reading the manifest, and raise the budget or narrow the workspace rather than expecting a partial result. Returned items carry their full `statement` — the same content `sac.read` returns, not a summary of it. Local stdio only: over HTTP it returns `sac_transport_denied` without reading anything.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, maxItems: { type: "number" }, maxTokens: { type: "number" } }, ["workspaceId"]),
      mutating: false,
      async invoke(cwd, params, context) {
        // v1 SAC is local-stdio only. HTTP has no verified principal policy and
        // must never inherit a local OS actor.
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        const maxItems = typeof params.maxItems === "number" ? params.maxItems : 32;
        const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : 4096;
        return normalizeFwkResult(await createLocalFwkReadService(cwd).overview({ workspaceId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } }));
      },
    },
    {
      name: "sac.read", module: "sac", description: "Fetch one item from a Shared Agent Context workspace by `itemId`, narrowing an overview to a single id with the whole budget behind it. Ids do not appear in the overview manifest: they are in the receipt, at `receipt.contextAssembly.selected`, each prefixed `./ids/` — strip that prefix to get the `itemId`. Content is never returned partially: an item larger than `maxTokens` (default 4096) is refused with `{ code: \"context_overflow\", requiredId }`, so raise the budget and retry rather than treating a short result as truncated. Reads one item and does not search — there is no query parameter. Local stdio only: over HTTP it returns `sac_transport_denied` without reading anything.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, itemId: { type: "string" }, maxItems: { type: "number" }, maxTokens: { type: "number" } }, ["workspaceId", "itemId"]),
      mutating: false,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        const itemId = stringParam(params, "itemId") ?? "";
        const maxItems = typeof params.maxItems === "number" ? params.maxItems : 1;
        const maxTokens = typeof params.maxTokens === "number" ? params.maxTokens : 4096;
        return normalizeFwkResult(await createLocalFwkReadService(cwd).read({ workspaceId, itemId, request: undefined, requestCorrelationId: randomUUID(), budget: { maxItems, maxTokens } }));
      },
    },
    {
      name: "sac.propose", module: "sac", description: "Create a real SAC proposal from a completed keryx session, for a reviewer to accept via sac.review.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, kind: { type: "string", description: "decision | wiki-update | memory-entry | follow-up | contract-change | risk" }, sessionId: { type: "string" }, note: { type: "string" }, proposalRevision: { type: "string" } }, ["workspaceId", "kind", "sessionId"]),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        const kind = stringParam(params, "kind") ?? "";
        const sessionRef = stringParam(params, "sessionId") ?? "";
        const note = stringParam(params, "note");
        const proposalRevision = stringParam(params, "proposalRevision") ?? "1";
        // Resolve the human-friendly id/prefix to a canonical session id ONLY to
        // build a schema-valid `sourceRef` path — resolveSessionWrapUp (inside
        // wrapUpAuthority.issue below) independently re-looks this session up
        // itself and never trusts this resolution as evidence. Mirrors
        // src/commands/workspace.ts's `propose` handler exactly.
        const session = findSession(cwd, sessionRef);
        if (!session) throw new Error(`no session matching "${sessionRef}" in this project`);
        const { service, wrapUpAuthority, authorizationServer } = createHarnessProposalLifecycleService(cwd, { workspaceId, ...(note ? { note } : {}) });
        const requestCorrelationId = randomUUID();
        const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
        if (!actor) throw new Error("trusted ActorContext is required");
        const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: sessionEvidenceRef(workspaceId, session.id) });
        const proposal = await service.create({ request: undefined, requestCorrelationId, workspaceId, id: `proposal-${randomUUID().replace(/-/g, "").slice(0, 16)}`, proposalRevision, kind: kind as never, wrapUp });
        // The note is not part of the frozen proposal schema — it lives in a
        // sidecar the memory/wiki/skill owner-writers read back at accept time,
        // since accept may happen in a different process/reviewer session.
        if (note) await writeFile(proposalNotePath(cwd, workspaceId, proposal.id), note, "utf8");
        return normalizeProposalLifecycleResult(proposal);
      },
    },
    {
      name: "sac.review", module: "sac", description: "Record a terminal SAC review decision through the guarded owner-writer seam. Accepting requires confirmToken, minted by running `keryx workspace confirm-review <workspace-id> <proposal-id>` in a real, approval-gated shell — this tool cannot mint one itself.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" }, proposalId: { type: "string" }, decision: { type: "string" }, reason: { type: "string" }, idempotencyKey: { type: "string" }, confirmToken: { type: "string", description: "Required when decision is \"accepted\" — mint via `keryx workspace confirm-review <workspace-id> <proposal-id>`." } }, ["workspaceId", "proposalId", "decision"]),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? ""; const proposalId = stringParam(params, "proposalId") ?? ""; const decision = stringParam(params, "decision") as "accepted" | "rejected" | "dismissed"; const reason = stringParam(params, "reason"); const idempotencyKey = stringParam(params, "idempotencyKey") ?? randomUUID(); const confirmToken = stringParam(params, "confirmToken");
        // Same composition as sac.propose: an accept must see the real owner
        // writer (memory/wiki/skill), or it lands in "stale" for no real reason.
        // `interactive: true` — matches current MCP trust posture (a human is
        // driving this tool call; SLATE-8's spec explicitly scopes the
        // stdio-transport trust gap as a separate, not-fixed-here concern, so
        // this does not invent a stricter MCP-specific policy). SLATE-20 adds
        // a second, independent gate on top: `decision: "accepted"` also
        // requires `confirmToken`, which only `keryx workspace confirm-review`
        // (a real shell command, never exposed as a tool here) can mint — a
        // caller with only MCP tool access, no shell_exec, cannot accept on
        // its own even though `interactive: true` alone would have let it.
        const result = await createHarnessProposalLifecycleService(cwd, { workspaceId }).service.review({ request: undefined, requestCorrelationId: randomUUID(), workspaceId, proposalId, decision, idempotencyKey, interactive: true, ...(reason ? { reason } : {}), ...(confirmToken ? { confirmToken } : {}) });
        return normalizeProposalLifecycleResult(result);
      },
    },
    // SLATE-19b: MCP parallel of the keryx-shell workspace_list/workspace_create/
    // workspace_show interactive tools (workspace-lifecycle-tool.ts) — before this,
    // Claude Code/Codex/any other MCP client had sac.propose/sac.review but no way
    // to discover or create a SAC workspace at all, unlike keryx-shell's own
    // interactive agent. Same WorkspaceService the CLI (workspace.ts) and the
    // keryx-shell tools already use — no shadow state, same records either surface
    // produces. `sac.workspaceList`/`sac.workspaceShow` are plain reads;
    // `sac.workspaceCreate` writes a new empty workspace container (no knowledge in
    // it, reversible via `keryx workspace archive`) and is gated the same way
    // `sac.propose`/`sac.review` already are — local-stdio only, since v1 SAC has no
    // verified HTTP principal policy.
    {
      name: "sac.workspaceList", module: "sac", description: "List Shared Agent Context (SAC) workspaces visible to this actor — call this before sac.workspaceCreate to check whether an existing workspace already fits.",
      inputSchema: OBJECT_SCHEMA({ includeArchived: { type: "boolean" } }, []),
      mutating: false,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const includeArchived = params.includeArchived === true;
        const workspaces = await new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } }).list({ request: undefined, requestCorrelationId: randomUUID(), includeArchived });
        return workspaces;
      },
    },
    {
      name: "sac.workspaceShow", module: "sac", description: "Show one Shared Agent Context (SAC) workspace's manifest (title, members, resources, status) by id, discovered via sac.workspaceList.",
      inputSchema: OBJECT_SCHEMA({ workspaceId: { type: "string" } }, ["workspaceId"]),
      mutating: false,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const workspaceId = stringParam(params, "workspaceId") ?? "";
        return await new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } }).show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId });
      },
    },
    {
      name: "sac.workspaceCreate", module: "sac", description: "Create a new Shared Agent Context (SAC) workspace. Call sac.workspaceList FIRST and only create when no existing workspace already fits the current topic — a workspace is meant to persist and accumulate context across sessions.",
      inputSchema: OBJECT_SCHEMA({ title: { type: "string" }, component: { type: "string" } }, ["title"]),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "sac_transport_denied" as const };
        const title = stringParam(params, "title")?.trim() ?? "";
        if (title.length === 0) throw new Error("sac.workspaceCreate requires a non-empty 'title'");
        const component = stringParam(params, "component");
        const workspace = await new WorkspaceService({ workspaceRoot: cwd, authorizationServer: localWorkspaceAuthorizationServer(), strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" } }).create({ request: undefined, requestCorrelationId: randomUUID(), id: newWorkspaceId(), title, ...(component ? { component: { kind: "component" as const, uri: component } } : {}) });
        return workspace;
      },
    },
    // SLATE-22..26 (v3, flow 182 T3): a private, MCP-opened Slate for any
    // external-hand (non-keryx-process) MCP client — Claude Code, Codex, any
    // other harness — scoped to `(cwd, externalSessionId)` and never shared
    // with a different `externalSessionId` (AC-34/AC-40). Same stateless-
    // tool-with-a-storage-side-effect shape `sac.workspaceCreate` already
    // uses; local-stdio only, matching every `sac.*` tool above (v1 SAC has
    // no verified HTTP principal policy).
    {
      name: "slate.open",
      module: "slate",
      description:
        "Open (or idempotently re-open) this external hand's own private, task-local Slate — never readable/writable by a different externalSessionId. `anchors` is stored verbatim (root/touched/note), never harness-enriched.",
      inputSchema: OBJECT_SCHEMA(
        {
          externalSessionId: { type: "string" },
          workspaceId: { type: "string", description: "Bind this slate to an already-known SAC workspace up front; omit to stay unbound (slate.close then preserves Seeds as a local unbound-candidate artifact)." },
          anchors: {
            type: "object",
            description: "{ root: string, touched?: string[], note?: string } — this hand's own self-report, stored exactly as given.",
            properties: { root: { type: "string" }, touched: { type: "array", items: { type: "string" } }, note: { type: "string" } },
          },
        },
        ["externalSessionId"],
      ),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "slate_transport_denied" as const };
        const externalSessionId = stringParam(params, "externalSessionId") ?? "";
        const workspaceId = stringParam(params, "workspaceId");
        // Real call path: `resolveWorkspace` is left unset — `handleSlateOpen`
        // defaults to the REAL `resolveOrCreateWorkspace` (SLATE-16). See
        // `handleSlateOpen`'s own doc comment for why the injectable seam
        // lives there rather than here.
        return handleSlateOpen({
          cwd,
          externalSessionId,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          anchors: params.anchors,
        });
      },
    },
    {
      name: "slate.writeSeed",
      module: "slate",
      description:
        "Append a draft Seed (task-local hypothesis, not yet reviewed knowledge) to this external hand's own Slate. `origin`/`trust` are always server-set — a caller-supplied value for either is never used.",
      inputSchema: OBJECT_SCHEMA(
        { externalSessionId: { type: "string" }, text: { type: "string" }, kind: { type: "string", description: "decision | wiki-update | memory-entry | follow-up | contract-change | risk" } },
        ["externalSessionId", "text"],
      ),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "slate_transport_denied" as const };
        const externalSessionId = stringParam(params, "externalSessionId") ?? "";
        const rawText = stringParam(params, "text") ?? "";
        if (externalSessionId.length === 0) throw new Error("slate.writeSeed requires a non-empty 'externalSessionId'");
        if (rawText.length === 0) throw new Error("slate.writeSeed requires a non-empty 'text'");
        // F-001/F-003 fix (flow 182 T7, BLOCKER security review finding): a
        // bare `text.length` check used to be the only guard here — no cap at
        // all, unlike the sibling keryx-native `slate_write_seed` tool
        // (`slate-tool.ts`), which enforces `SEED_TEXT_MAX_LENGTH` via its
        // input schema's `maxLength` (enforced by `executeCall`'s pre-invoke
        // schema validation, `commands/agent.ts`). That protection does NOT
        // exist for MCP tool calls at all — `src/mcp/dispatch.ts`'s
        // `dispatchCallTool` never enforces any tool's `inputSchema`
        // server-side (schemas there are advisory/client-discovery-only) — so
        // this handler must validate at runtime itself, exactly like
        // `slate-tool.ts`'s `invoke` already does for the keryx-native path.
        // Rejected (thrown), never silently truncated.
        if (rawText.length > SEED_TEXT_MAX_LENGTH) {
          throw new Error(`slate.writeSeed: 'text' exceeds the ${SEED_TEXT_MAX_LENGTH}-character limit (got ${rawText.length})`);
        }
        await reclaimStaleExternalSlates(cwd);
        const rawKind = stringParam(params, "kind");
        // F-001 fix (flow 182 T7, BLOCKER security review finding): `kind`
        // used to be a bare `as SlateSeedKind` cast with ZERO runtime
        // validation. It flows through `closeExternalSlate` ->
        // `runWrapUp` -> `resolveMachineWrapUp` (`src/sac/machine-wrap-up.ts`),
        // which builds evidence filenames as `${input.kind}.${shortHash}.
        // diff.txt` etc. and writes them via `writeFileAtomic` with no path-
        // containment check of its own — a caller sending
        // `kind: "../../../../../../tmp/pwned"` got an arbitrary-path file
        // write with attacker-controlled content, a second, distinct
        // path-traversal/arbitrary-file-write vuln in this same diff (T6 only
        // fixed the `externalSessionId` one). `isSlateSeedKind` (promoted to
        // `../session/slate.ts` by this same fix, shared with
        // `slate-tool.ts`'s already-correct runtime guard) rejects the WHOLE
        // call — never silently drops or coerces an invalid `kind` — mirroring
        // `slate-tool.ts`'s own rejection shape/spirit.
        let kind: SlateSeedKind | undefined;
        if (rawKind !== undefined) {
          if (!isSlateSeedKind(rawKind)) {
            throw new Error(`slate.writeSeed: unrecognized 'kind' "${rawKind}"`);
          }
          kind = rawKind;
        }
        // F-002 fix (flow 182 T7, MAJOR security review finding): `text` used
        // to be stored verbatim — a regression vs. the sibling keryx-native
        // `slate_write_seed` tool (`slate-tool.ts`), which already redacts
        // Seed text via `redactSensitiveText` before it ever touches disk.
        // Redacting here, before the `SlateSeed` is even constructed, closes
        // the same gap for the external-hand path: a leaked secret an
        // external hand's Seed text happens to echo never lands in
        // `.keryx/external-slates/*.json` at all.
        const text = redactSensitiveText(rawText);
        const ts = new Date().toISOString();
        // AC-37: `origin`/`trust` are minted here, unconditionally — `params`
        // may carry caller-supplied `origin`/`trust` fields (a spoof
        // attempt, or an honest no-op), neither is ever read. `origin.harness`
        // identifies this MCP tool surface itself (every caller reaches
        // Slate v3 through the identical `slate.writeSeed` handler — there is
        // no lower-level signal here to distinguish which literal external
        // process is calling), a deliberate, documented judgment call: the
        // frozen test suite (`slate-tools.test.ts`, AC4) only requires a
        // non-empty, server-derived, non-spoofable, call-to-call-stable
        // string, not a specific literal.
        const seed: SlateSeed = {
          id: `seed-${randomUUID()}`,
          text,
          ts,
          ...(kind ? { kind } : {}),
          origin: { harness: "mcp-external" },
          trust: "external-unverified",
        };
        return writeExternalSlate(cwd, externalSessionId, (prev) => {
          if (!prev) throw new Error(`slate.writeSeed: no open external slate for "${externalSessionId}" — call slate.open first`);
          if (prev.closedAt !== undefined) throw new Error(`slate.writeSeed: external slate "${externalSessionId}" is already closed`);
          // F-003 fix (flow 182 T7, MAJOR security review finding — count
          // half): no cap on `seeds.length` existed at all. Rejected
          // (thrown), never silently dropped — mirrors `text`/`kind`'s own
          // rejection style just above. Checked inside this same
          // read-modify-write lock hold (`writeExternalSlate`'s own
          // `withFileLock`), so two concurrent writers racing right at the
          // cap can never both squeeze one extra Seed past it.
          if (prev.seeds.length >= MAX_EXTERNAL_SLATE_SEEDS) {
            throw new Error(`slate.writeSeed: external slate "${externalSessionId}" already has ${MAX_EXTERNAL_SLATE_SEEDS} seeds (the maximum) — close it and open a fresh one`);
          }
          return { ...prev, seeds: [...prev.seeds, seed], lastWriteAt: ts };
        });
      },
    },
    {
      name: "slate.close",
      module: "slate",
      description:
        "Close this external hand's Slate: dispatches into the existing SAC propose/review pipeline (mirrors SLATE-18's autonomous workspace_propose) when a workspaceId is bound, else preserves its Seeds as a local unbound-candidate artifact — never a proposal against a guessed workspaceId.",
      inputSchema: OBJECT_SCHEMA({ externalSessionId: { type: "string" } }, ["externalSessionId"]),
      mutating: true,
      async invoke(cwd, params, context) {
        if (context?.transport === "http") return { code: "slate_transport_denied" as const };
        const externalSessionId = stringParam(params, "externalSessionId") ?? "";
        if (externalSessionId.length === 0) throw new Error("slate.close requires a non-empty 'externalSessionId'");
        await reclaimStaleExternalSlates(cwd);
        const existing = await readExternalSlate(cwd, externalSessionId);
        if (!existing) return { externalSessionId, closed: true, alreadyClosed: true };
        await closeExternalSlate(cwd, externalSessionId, "external-slate-close");
        return { externalSessionId, closed: true };
      },
    },
    {
      name: "gdgraph.affected",
      module: "gdgraph",
      description:
        "List the dependencies and dependents of a file from the code graph (blast radius). " +
        "Reads the built graph, so results are as old as the last `keryx gdgraph build` and " +
        "reflect no file added, renamed, deleted or re-imported since it — a blast radius " +
        "computed after such a change under-reports. With no graph built at all the result is " +
        "empty rather than an error, so an empty result means either no dependents or no graph.",
      inputSchema: OBJECT_SCHEMA(
        {
          file: { type: "string", description: "Project-relative file path." },
          depth: { type: "number", description: "Reserved; traversal depth." },
        },
        ["file"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const file = stringParam(params, "file") ?? "";
        const graph = await loadGraphSafe(cwd);
        return getAffected(graph, file);
      },
    },
    {
      name: "gdgraph.cycles",
      module: "gdgraph",
      description:
        "Return the import cycles in the code graph, each as an ordered list of file paths. " +
        "Cycles closed only through a dynamic `await import()` are deliberately excluded: they " +
        "resolve at call time, not module-load time, so they are not the load-order cycle this " +
        "query answers. Reads the built graph, so results are as old as the last `keryx gdgraph " +
        "build` and reflect no edit made since it. When no graph has been built at all the " +
        "result is an empty list rather than an error, so an empty result means either no " +
        "cycles or no graph — confirm a build exists before reporting `no cycles`. Returns the " +
        "cycles only: it does not rank them by severity and does not suggest where to break one.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return getCycles(await loadGraphSafe(cwd));
      },
    },
    {
      name: "gdgraph.orphans",
      module: "gdgraph",
      description:
        "Return the sorted paths of files the graph connects to nothing — no resolved import in " +
        "either direction. Unresolved edges do not count as connections, so a file whose only " +
        "imports failed to resolve is reported as an orphan; check before treating a hit as dead " +
        "code. Zero-degree only: a real entry point that imports anything has outbound edges and " +
        "will NOT appear here, so absence from this list is no evidence a file is reachable. " +
        "Reads the built graph, so results are as old as the last `keryx gdgraph build`, and " +
        "with no graph built at all the result is an empty list rather than an error.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return getOrphans(await loadGraphSafe(cwd));
      },
    },
    {
      name: "security.check",
      module: "security",
      description:
        "Run the security engine over supplied content and return a leak-safe decision.",
      inputSchema: OBJECT_SCHEMA(
        {
          content: { type: "string" },
          source: { type: "string", description: "Trust level of the content." },
        },
        ["content"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const content = stringParam(params, "content") ?? "";
        const source = (stringParam(params, "source") ?? "untrusted-external") as SecuritySource;
        return createSecurityService(cwd).check({ content, source });
      },
    },
    {
      name: "security.scan",
      module: "security",
      description:
        "Scan a file for secrets/PII/injection and write a committable security report.",
      inputSchema: OBJECT_SCHEMA({
        path: { type: "string", description: "File to scan." },
        content: { type: "string", description: "Inline content to scan instead of a path." },
      }),
      mutating: true, // writes a committable report; not a flow-gate bypass
      async invoke(cwd, params) {
        const filePath = stringParam(params, "path");
        const inline = stringParam(params, "content");
        const content = inline ?? (filePath ? await readFile(filePath, "utf8") : "");
        const result = await runScan(cwd, {
          content,
          source: "trusted-project",
          ...(filePath ? { path: filePath } : {}),
        });
        return { decision: result.decision, report: result.report };
      },
    },
    {
      name: "security.scan-mcp",
      module: "security",
      description:
        "Scan an MCP tool manifest for tool-poisoning, line-jumping, and rug-pull threats (E3).",
      inputSchema: OBJECT_SCHEMA({
        manifest: { type: "object", description: "Parsed MCP manifest object." },
      }),
      mutating: false,
      async invoke(_cwd, params) {
        return scanMcpManifest(params.manifest);
      },
    },
    {
      name: "flow.status",
      module: "flow",
      description:
        "Read-only flow status: list all flows, or fetch one flow by id. Never mutates a flow.",
      inputSchema: OBJECT_SCHEMA({
        id: { type: "string", description: "Flow id to fetch; omit to list all." },
      }),
      mutating: false,
      async invoke(cwd, params) {
        const id = stringParam(params, "id");
        const service = readOnlyFlowService();
        return id ? service.get({ cwd, id }) : service.list({ cwd });
      },
    },
    {
      name: "memory.search",
      module: "memory",
      description:
        "Deterministic ranked search over long-term project memory — lessons, decisions and " +
        "constraints recorded by past sessions. Automatic recall is bounded to entries that are " +
        "both `accepted` and current: drafts, rejected and superseded entries are never returned, " +
        "so an empty result means nothing accepted matched, not that the project has no memory on " +
        "the topic. The query must be non-empty and at most 4096 UTF-8 bytes, and the result count " +
        "is capped. Invalid input comes back as an `error` field on a normal result with empty " +
        "`hits` — it does not throw, so check `error` before reading `hits`.",
      inputSchema: OBJECT_SCHEMA(
        {
          query: { type: "string" },
        },
        ["query"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const query = stringParam(params, "query") ?? "";
        return createMetaprojectAdapter(cwd).memorySearch({ query });
      },
    },
    {
      name: "health.gate",
      module: "health",
      description:
        "Return the quality-gate outcome (`status`, `exitCode`, `reasons`) from the stored Code " +
        "Health report. This reads the last report and never runs the gate itself, so the verdict " +
        "is only as fresh as the last `keryx health run` — read `lastRunAt` from health.status " +
        "before reporting it as the current state. When no report exists at all it returns " +
        "`status: \"fail\"` with the reason ``no report; run `keryx health run` first`` " +
        "(backticks included, so match the literal exactly): that is an absent gate, not a " +
        "failing one, and must not be reported as a quality failure. `strictWarn` makes a " +
        "`warn` status exit non-zero. Returns the verdict and its reasons, not per-file " +
        "findings — those come from the `keryx health explain <file-or-module>` CLI command; " +
        "there is no MCP tool for them.",
      inputSchema: OBJECT_SCHEMA({
        strictWarn: { type: "boolean" },
      }),
      mutating: false,
      async invoke(cwd, params) {
        const strictWarn = params.strictWarn === true;
        return createCodeHealthService().gate({ cwd, strictWarn });
      },
    },
    {
      name: "health.status",
      module: "health",
      description:
        "Summarise the stored Code Health report: whether health is configured (`enabled`), when " +
        "it last ran (`lastRunAt`), the gate status, per-source statuses, the project score and " +
        "the counts of declining and regressed scopes. It reads the last report and never runs " +
        "the checks, so `lastRunAt` is the staleness signal — check it before quoting any figure " +
        "here as current. With no report at all, `lastRunAt`, `gate` and `projectScore` are " +
        "`null`, but `regressions`, `decliningScopes` and `regressedScopes` come back `0`: a " +
        "zero here means no report was found, NOT that there are no regressions, so gate on " +
        "`lastRunAt !== null` before reading any count. Returns aggregates only, never per-file " +
        "findings.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return createCodeHealthService().status({ cwd });
      },
    },
    {
      name: "wiki.query",
      module: "wiki",
      description:
        "Query the local wiki. mode=status (default, read-only) | validate | check-links.",
      inputSchema: OBJECT_SCHEMA({
        mode: { type: "string", enum: ["status", "validate", "check-links"] },
      }),
      mutating: false,
      async invoke(cwd, params) {
        const service = createGdWikiService();
        const mode = stringParam(params, "mode") ?? "status";
        if (mode === "validate") {
          return service.validate({ cwd });
        }
        if (mode === "check-links") {
          return service.checkLinks({ cwd });
        }
        return service.status({ cwd });
      },
    },
    {
      name: "wiki.ask",
      module: "wiki",
      description:
        "Ask a question answered deterministically from the project's own wiki + memory, with citations.",
      inputSchema: OBJECT_SCHEMA(
        {
          question: { type: "string", description: "The natural-language question." },
          k: { type: "number", description: "Max citations to return." },
        },
        ["question"],
      ),
      mutating: false,
      async invoke(cwd, params) {
        const question = stringParam(params, "question") ?? "";
        const k = typeof params.k === "number" ? params.k : undefined;
        return createGdWikiService().ask({ cwd, question, ...(k ? { k } : {}) });
      },
    },
    {
      name: "standard.validate",
      module: "standard",
      description:
        "Validate this workspace's `.metaproject` layout against the Metaproject Standard — " +
        "manifest, required files, module declarations and their consistency — and return the " +
        "structured findings. This checks the Metaproject scaffolding, not the project's code: it " +
        "says nothing about lint, types, tests or code quality, which belong to health.gate and " +
        "health.status. It runs the checks live rather than reading a stored report, so the result " +
        "always reflects the current working tree. Read-only: it reports problems and never fixes " +
        "them.",
      inputSchema: OBJECT_SCHEMA(),
      mutating: false,
      async invoke(cwd) {
        return runValidate(cwd);
      },
    },
  ];
}
