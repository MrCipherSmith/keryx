// Agent-native Shared Agent Context (SAC) workspace lifecycle tools (SLATE-19,
// flow 166 Phase 2: cross-runtime agent-tool parity). Before this, `keryx
// workspace create/list/show/propose` were reachable ONLY from a separate CLI
// process (src/commands/workspace.ts) via `shell_exec` — an agent inside
// keryx-shell had no direct way to discover or bind a workspace, which is a
// prerequisite for SLATE-16/17's automatic resolve-or-create/re-evaluation
// (Phase 3) and SLATE-18's autonomous wrap-up dispatch (Phase 4). This gives
// keryx-shell's own interactive agent, and any other runtime wired through
// `buildInteractiveAgentTools`, the SAME workspace-lifecycle surface the CLI
// and the MCP `sac.propose` tool already have.
//
// Risk classification (`risk: "read"` on all four, deliberate — mirrors
// `slate-tool.ts`'s `slate_write_seed` reasoning exactly): a `risk`
// classification here tracks whether unreviewed model output can become
// something CONSEQUENTIAL without a human/gate in the loop, not whether bytes
// hit disk.
//   - `workspace_create` creates an empty container with no knowledge in it —
//     reversible via `keryx workspace archive`, and per SLATE-16's own design
//     intent the agent must be able to do this unattended, without asking
//     permission for every new workspace.
//   - `workspace_propose` creates a "proposed" record — never accepted
//     knowledge by itself, exactly like a Seed. The one consequential step,
//     ACCEPT, is independently gated by SLATE-20's confirm-token
//     (review-confirm-token.ts), which this tool has no path to obtain — a
//     token is mintable only by a real, approval-gated shell command. So a
//     model calling `workspace_propose` freely can still never accept its own
//     proposal.
//   - `workspace_list`/`workspace_show` are plain reads.
// `commands/agent.ts`'s `executeCall` only gates `risk === "shell" |
// "destructive"` behind approval; all four bypass that gate on purpose, the
// same way `slate_write_seed` does — see that file's own doc comment before
// revisiting this classification.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createHarnessProposalLifecycleService, localWorkspaceAuthorizationServer, newWorkspaceId, normalizeProposalLifecycleResult, proposalNotePath, sessionEvidenceRef, WorkspaceService } from "../../../sac/harness-facade";
import { writeSlate } from "../../../session/slate";
import { findSession } from "../../../session/store";
import type { InteractiveTool } from "./interactive-tools";

// Mirrors PROPOSAL_KINDS in src/commands/workspace.ts exactly — every kind a
// real owner writer exists for (ownerFor in proposal-lifecycle.ts).
const PROPOSAL_KINDS = ["decision", "wiki-update", "memory-entry", "follow-up", "contract-change", "risk"] as const;

function service(cwd: string): WorkspaceService {
  return new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
}

function errorOutput(prefix: string, cause: unknown): { output: string; isError: true } {
  return { output: `${prefix}: ${cause instanceof Error ? cause.message : String(cause)}`, isError: true };
}

export function workspaceCreateTool(cwd: string, getSessionDir?: () => string | undefined): InteractiveTool {
  return {
    definition: {
      name: "workspace_create",
      description:
        "Create a new Shared Agent Context (SAC) workspace to bind this session's work to. Call workspace_list FIRST and only create when no existing workspace already fits the current topic — a workspace is meant to persist and accumulate context across sessions, not to be created per-session. The created workspace is BOUND to this session's slate (its workspaceId is written to the slate), so wrap-up can propose into it. Input: { title: string, component?: string }. `component` is an optional workspace-relative path this workspace is scoped to.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" }, component: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const title = typeof input.title === "string" ? input.title.trim() : "";
      if (title.length === 0) return { output: "workspace_create requires a non-empty 'title'", isError: true };
      const component = typeof input.component === "string" && input.component.length > 0 ? input.component : undefined;
      try {
        const workspace = await service(cwd).create({
          request: undefined,
          requestCorrelationId: randomUUID(),
          id: newWorkspaceId(),
          title,
          ...(component ? { component: { kind: "component" as const, uri: component } } : {}),
        });
        // Flow 200 (lazy binding): bind the created workspace to the current
        // session's slate so wrap-up can propose into it without a second
        // manual bind. Best-effort — no active session (or a slate-write
        // failure) never fails the create itself.
        const dir = getSessionDir?.();
        if (dir !== undefined) {
          try {
            await writeSlate(dir, (prev) => ({
              anchors: prev?.anchors ?? { root: "", touched: [] },
              course: prev?.course ?? {},
              seeds: prev?.seeds ?? [],
              ...(prev !== undefined ? { workspaceId: prev.workspaceId } : {}),
              workspaceId: workspace.id,
            }));
          } catch {
            // ignored — the workspace exists; binding is best-effort
          }
        }
        return { output: JSON.stringify(workspace, null, 2), isError: false };
      } catch (cause) {
        return errorOutput("workspace_create failed", cause);
      }
    },
  };
}

export function workspaceListTool(cwd: string): InteractiveTool {
  return {
    definition: {
      name: "workspace_list",
      description:
        "List Shared Agent Context (SAC) workspaces visible to this session. Call this FIRST — before workspace_create — to judge whether an existing workspace already covers the current topic.  Input: { includeArchived?: boolean }.",
      inputSchema: {
        type: "object",
        properties: { includeArchived: { type: "boolean" } },
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const includeArchived = input.includeArchived === true;
      try {
        const workspaces = await service(cwd).list({ request: undefined, requestCorrelationId: randomUUID(), includeArchived });
        return { output: JSON.stringify(workspaces, null, 2), isError: false };
      } catch (cause) {
        return errorOutput("workspace_list failed", cause);
      }
    },
  };
}

export function workspaceShowTool(cwd: string): InteractiveTool {
  return {
    definition: {
      name: "workspace_show",
      description:
        "Show one Shared Agent Context (SAC) workspace's manifest (title, members, resources, status) by id, discovered via workspace_list. Input: { workspaceId: string }.",
      inputSchema: {
        type: "object",
        properties: { workspaceId: { type: "string" } },
        required: ["workspaceId"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
      if (workspaceId.length === 0) return { output: "workspace_show requires a non-empty 'workspaceId'", isError: true };
      try {
        const workspace = await service(cwd).show({ request: undefined, requestCorrelationId: randomUUID(), workspaceId });
        return { output: JSON.stringify(workspace, null, 2), isError: false };
      } catch (cause) {
        return errorOutput("workspace_show failed", cause);
      }
    },
  };
}

/**
 * `getSessionDir` mirrors `slate-tool.ts`'s lazy-getter pattern (see
 * `interactive-agent-tools.ts`'s own doc comment on why it must be lazy, not
 * a snapshot). Used only to default `sessionId` when the model omits it — per
 * spec (SLATE-19), `sessionId` defaults to the CURRENT session, since that is
 * overwhelmingly the common case (an agent proposing from the session it is
 * already running in) and the model has no other way to name "this session"
 * without being told its own id out of band.
 */
export function workspaceProposeTool(cwd: string, getSessionDir: () => string | undefined): InteractiveTool {
  return {
    definition: {
      name: "workspace_propose",
      description:
        "Propose a decision/wiki-update/memory-entry/follow-up/contract-change/risk to a Shared Agent Context (SAC) workspace from a completed keryx session, for a human reviewer to accept later via `keryx workspace review` (never this tool or any other agent-native tool — accepting is always human-gated by a confirm token only a real terminal can mint). Input: { workspaceId: string, kind: 'decision'|'wiki-update'|'memory-entry'|'follow-up'|'contract-change'|'risk', sessionId?: string, note?: string }. `sessionId` defaults to the current session when omitted.",
      inputSchema: {
        type: "object",
        properties: {
          workspaceId: { type: "string" },
          kind: { type: "string", enum: [...PROPOSAL_KINDS] },
          sessionId: { type: "string" },
          note: { type: "string" },
        },
        required: ["workspaceId", "kind"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input) => {
      const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : "";
      const kind = typeof input.kind === "string" ? input.kind : "";
      const note = typeof input.note === "string" && input.note.length > 0 ? input.note : undefined;
      if (workspaceId.length === 0) return { output: "workspace_propose requires a non-empty 'workspaceId'", isError: true };
      if (!(PROPOSAL_KINDS as readonly string[]).includes(kind)) {
        return { output: `workspace_propose: unrecognized 'kind' — expected one of: ${PROPOSAL_KINDS.join(", ")}`, isError: true };
      }
      const explicitSessionId = typeof input.sessionId === "string" && input.sessionId.length > 0 ? input.sessionId : undefined;
      const sessionRef = explicitSessionId ?? path.basename(getSessionDir() ?? "");
      if (sessionRef.length === 0) {
        return { output: "workspace_propose: no 'sessionId' given and no active session in this run", isError: true };
      }
      try {
        // Resolve the human-friendly id/prefix to a canonical session id ONLY
        // to build a schema-valid `sourceRef` path — resolveSessionWrapUp
        // (inside wrapUpAuthority.issue below) independently re-looks this
        // session up itself and never trusts this resolution as evidence.
        // Mirrors src/commands/workspace.ts's `propose` handler exactly.
        const session = findSession(cwd, sessionRef);
        if (!session) return { output: `workspace_propose: no session matching "${sessionRef}" in this project`, isError: true };
        const { service: lifecycle, wrapUpAuthority, authorizationServer } = createHarnessProposalLifecycleService(cwd, { workspaceId, ...(note ? { note } : {}) });
        const requestCorrelationId = randomUUID();
        const actor = await authorizationServer.actorContextFor(undefined, requestCorrelationId);
        if (!actor) return { output: "workspace_propose: trusted ActorContext is required", isError: true };
        const wrapUp = await wrapUpAuthority.issue({ actor, source: "session", sourceRef: sessionEvidenceRef(workspaceId, session.id) });
        const proposal = await lifecycle.create({
          request: undefined,
          requestCorrelationId,
          workspaceId,
          id: `proposal-${randomUUID().replace(/-/g, "").slice(0, 16)}`,
          proposalRevision: "1",
          kind: kind as never,
          wrapUp,
        });
        // The note is not part of the frozen proposal schema — it lives in a
        // sidecar the memory/wiki/skill owner-writers read back at accept
        // time, since accept may happen in a different process/reviewer
        // session. Mirrors src/commands/workspace.ts's `propose` handler.
        if (note) await writeFile(proposalNotePath(cwd, workspaceId, proposal.id), note, "utf8");
        return { output: JSON.stringify(normalizeProposalLifecycleResult(proposal), null, 2), isError: false };
      } catch (cause) {
        return errorOutput("workspace_propose failed", cause);
      }
    },
  };
}
