// Pure logic for the four tree-view nodes (spec.md §2.4, AC5). Zero `vscode`
// import — same house pattern as `status-logic.ts`/`status-bar-logic.ts`:
// parse CLI shell-out output/JSON into plain node-shape objects, leave the
// `vscode.TreeDataProvider`/`TreeItem` construction to `tree-view.ts`.
//
// Data source decision (T9, same rationale as T7's status bar): `GET
// /v1/projects` and turn-history routes on `keryx serve`'s HTTP backend are
// off by default here, so this shells the equivalent read-only CLI surfaces
// through the existing `runKeryx` seam instead:
//   - Projects        -> `keryx projects list --json`      (global project registry)
//   - Recent Turns     -> `keryx sessions list --json`       (per-project shell sessions;
//     the closest existing "turn history" surface — `keryx serve`'s
//     `/v1/turns/*` routes read from the same underlying session/turn store
//     per spec.md Finding 2, but the CLI's own turn-listing surface is
//     `sessions list`, not a separate `turns` subcommand)
//   - Needs Your Attention -> `keryx flow list --json` (in-progress flows,
//     from `src/commands/flow.ts`'s undocumented-but-real `--json` flag) +
//     `keryx workspace catch-up --json` (SAC pending proposals — a
//     purpose-built, already project-scoped endpoint, `src/commands/
//     workspace.ts`'s `catch-up` subcommand)
//
// AC5's explicit requirement: when a project has NEITHER flow nor sac
// configured, render a real, legible empty-state node/message — see
// `needsAttentionItems()`'s "not-configured" branch below, and the dedicated
// test in `tree-view-logic.test.ts`.

import type { KeryxStatusState } from "./status-logic";

// --- Status node -----------------------------------------------------------

/** Label for the single Status tree node, reusing `status-logic.ts`'s 3-state interpretation. */
export function statusNodeLabel(state: KeryxStatusState): string {
  switch (state) {
    case "not-initialized":
      return "Not initialized";
    case "incomplete":
      return "Incomplete";
    case "ready":
      return "Ready";
  }
}

// --- Projects node -----------------------------------------------------------

export interface ProjectRecord {
  readonly projectId: string;
  readonly path: string;
  readonly displayName: string;
  readonly state: string;
}

export interface ProjectsListResponse {
  readonly projects?: ProjectRecord[];
}

/** Parse `keryx projects list --json`'s stdout into a flat, display-ready list. */
export function parseProjectsList(stdout: string): ProjectRecord[] {
  try {
    const parsed = JSON.parse(stdout) as ProjectsListResponse;
    return Array.isArray(parsed.projects) ? parsed.projects : [];
  } catch {
    // A stale/garbled binary must not crash the tree view — render empty
    // rather than throw; the Status node already surfaces CLI health.
    return [];
  }
}

export interface ProjectNodeItem {
  readonly label: string;
  readonly description: string;
  readonly path: string;
}

/** Shape each project record into what the Projects node should render. */
export function projectNodeItems(projects: readonly ProjectRecord[]): ProjectNodeItem[] {
  return projects.map((project) => ({
    label: project.displayName,
    description: project.state === "missing" ? `${project.path} (missing)` : project.path,
    path: project.path,
  }));
}

// --- Recent Turns node -----------------------------------------------------------

export interface SessionRecord {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly messageCount: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface SessionsListResponse {
  readonly sessions?: SessionRecord[];
}

export const RECENT_TURNS_LIMIT = 10;

/** Parse `keryx sessions list --json`'s stdout, capped and sorted most-recent-first. */
export function parseRecentTurns(stdout: string, limit = RECENT_TURNS_LIMIT): SessionRecord[] {
  let sessions: SessionRecord[];
  try {
    const parsed = JSON.parse(stdout) as SessionsListResponse;
    sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
  return [...sessions]
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, limit);
}

export interface RecentTurnNodeItem {
  readonly label: string;
  readonly description: string;
  readonly sessionId: string;
}

/** Shape each session into what the Recent Turns node should render. */
export function recentTurnNodeItems(sessions: readonly SessionRecord[]): RecentTurnNodeItem[] {
  return sessions.map((session) => ({
    label: session.title || "(untitled)",
    description: `${session.messageCount} msgs · ${session.provider ?? "unknown provider"}`,
    sessionId: session.id,
  }));
}

// --- Needs Your Attention node -----------------------------------------------------------

export interface FlowListEntry {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly tasksDone: number;
  readonly tasksTotal: number;
}

export interface FlowListResponse extends Array<FlowListEntry> {}

/** Parse `keryx flow list --json`'s stdout, keeping only in-progress flows. */
export function parseInProgressFlows(stdout: string): FlowListEntry[] {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as FlowListEntry[]).filter((entry) => entry.status === "in-progress");
  } catch {
    return [];
  }
}

export interface SacProposalEntry {
  readonly type: string;
  readonly workspaceId: string;
  readonly proposalId: string;
  readonly [key: string]: unknown;
}

export interface WorkspaceCatchUpResponse {
  readonly proposals?: SacProposalEntry[];
}

/** Parse `keryx workspace catch-up --json`'s stdout into its pending-proposal list. */
export function parsePendingProposals(stdout: string): SacProposalEntry[] {
  try {
    const parsed = JSON.parse(stdout) as WorkspaceCatchUpResponse;
    return Array.isArray(parsed.proposals) ? parsed.proposals : [];
  } catch {
    return [];
  }
}

export type NeedsAttentionItem =
  | { readonly kind: "flow"; readonly label: string; readonly description: string; readonly flowId: string }
  | {
      readonly kind: "sac-proposal";
      readonly label: string;
      readonly description: string;
      readonly workspaceId: string;
      readonly proposalId: string;
    }
  | { readonly kind: "empty"; readonly label: string; readonly description: string };

/**
 * AC5: merge in-progress flow tasks and pending SAC proposals into one
 * sorted list, sorted flows-before-proposals (an active implementation task
 * is more actionable than a pending review, per this task's dispatch brief —
 * a real UX call the specification itself left TBD). When BOTH sources are
 * empty, return a single explicit empty-state item rather than an empty
 * array, so the tree node can render a legible message instead of looking
 * blank/broken.
 */
export function needsAttentionItems(
  inProgressFlows: readonly FlowListEntry[],
  pendingProposals: readonly SacProposalEntry[],
): NeedsAttentionItem[] {
  const items: NeedsAttentionItem[] = [];

  for (const flow of inProgressFlows) {
    items.push({
      kind: "flow",
      label: `Flow ${flow.id}: ${flow.title}`,
      description: `${flow.tasksDone}/${flow.tasksTotal} tasks`,
      flowId: flow.id,
    });
  }

  for (const proposal of pendingProposals) {
    items.push({
      kind: "sac-proposal",
      label: "Pending SAC proposal",
      description: proposal.type,
      workspaceId: proposal.workspaceId,
      proposalId: proposal.proposalId,
    });
  }

  if (items.length === 0) {
    return [
      {
        kind: "empty",
        label: "Nothing needs your attention",
        description: "No active flow tasks and no pending SAC proposals for this project.",
      },
    ];
  }

  return items;
}

/** True when neither flow nor sac has anything actionable — the AC5 empty state. */
export function isNeedsAttentionEmpty(items: readonly NeedsAttentionItem[]): boolean {
  return items.length === 1 && items[0]?.kind === "empty";
}

/** A command line to type into an integrated terminal for one item's click. */
export interface TerminalAction {
  readonly text: string;
  /** false leaves the line typed but un-submitted — for a proposal, `--decision`
   * still needs a real value (accepted/rejected/dismissed) the human picks;
   * auto-running the bare command would just fail. */
  readonly execute: boolean;
}

/** The click action for one Needs Your Attention item, or undefined for the
 * empty state (nothing to act on). */
export function needsAttentionAction(item: NeedsAttentionItem): TerminalAction | undefined {
  switch (item.kind) {
    case "flow":
      return { text: `keryx flow status ${item.flowId}`, execute: true };
    case "sac-proposal":
      return { text: `keryx workspace review ${item.workspaceId} ${item.proposalId} --decision `, execute: false };
    case "empty":
      return undefined;
  }
}
