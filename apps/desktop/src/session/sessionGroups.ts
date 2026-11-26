// How the session sidebar groups sessions: a Pinned group first, then by the
// day each was last active, newest first. Archived sessions are a view of
// their own, grouped by day too. Pure, no React.

import { sessionFlags, type SessionInfo } from "../acp/types";

export type SidebarView = "active" | "archived";

export const PINNED_GROUP = "Pinned";

export interface SessionGroup {
  /** Also the key the collapsed state is stored under. */
  label: string;
  /** In display order: a child session right after its parent (see `depthOf`). */
  sessions: SessionInfo[];
  /** How deep each session sits under a parent shown in the same group; absent = 0 (a root). */
  depths?: Readonly<Record<string, number>>;
}
/** The session this one was forked or started from, as keryx reports it (0.4.62+). */
export function parentOf(s: SessionInfo): string | undefined {
  return s._meta?.keryx?.parentSessionId;
}
export function depthOf(group: SessionGroup, sessionId: string): number {
  return group.depths?.[sessionId] ?? 0;
}
/**
 * Children (forks, sessions started from another) follow their parent one level deeper, in the
 * parent's group; siblings keep the given order. A child whose parent is not in `list` is a root.
 */
function asTree(list: readonly SessionInfo[]): { sessions: SessionInfo[]; depths: Record<string, number> } {
  const ids = new Set(list.map((s) => s.sessionId));
  const children = new Map<string, SessionInfo[]>();
  const roots: SessionInfo[] = [];
  for (const s of list) {
    const parent = parentOf(s);
    if (parent !== undefined && parent !== s.sessionId && ids.has(parent)) children.set(parent, [...(children.get(parent) ?? []), s]);
    else roots.push(s);
  }
  const sessions: SessionInfo[] = [];
  const depths: Record<string, number> = {};
  const placed = new Set<string>();
  const visit = (s: SessionInfo, depth: number) => {
    if (placed.has(s.sessionId)) return;
    placed.add(s.sessionId);
    sessions.push(s);
    if (depth > 0) depths[s.sessionId] = depth;
    for (const child of children.get(s.sessionId) ?? []) visit(child, depth + 1);
  };
  for (const s of roots) visit(s, 0);
  for (const s of list) visit(s, 0); // a parent cycle: listed, not dropped
  return { sessions, depths };
}

export function dayBucket(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "Older";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Older";
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (t >= start) return "Today";
  if (t >= start - 86400000) return "Yesterday";
  if (t >= start - 6 * 86400000) return "Previous 7 days";
  return new Date(t).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

const byRecent = (a: SessionInfo, b: SessionInfo): number => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

export function isArchived(s: SessionInfo): boolean {
  return sessionFlags(s).archivedAt !== undefined;
}

export function countViews(sessions: readonly SessionInfo[]): Record<SidebarView, number> {
  let archived = 0;
  for (const s of sessions) if (isArchived(s)) archived += 1;
  return { active: sessions.length - archived, archived };
}

/**
 * The groups of one view, in display order. The active view puts pinned
 * sessions first; a pinned session that is also archived shows only in the
 * archived view. Empty groups are left out.
 */
export function groupSessions(sessions: readonly SessionInfo[], view: SidebarView, now: Date = new Date()): SessionGroup[] {
  const visible = sessions.filter((s) => isArchived(s) === (view === "archived")).sort(byRecent);
  // A child is grouped with the root it descends from, so the tree is never split across days.
  const byId = new Map(visible.map((s) => [s.sessionId, s] as const));
  const roots = new Map<string, SessionInfo>();
  const rootOf = (s: SessionInfo): SessionInfo => {
    const known = roots.get(s.sessionId);
    if (known !== undefined) return known;
    const path: SessionInfo[] = [s];
    const seen = new Set<string>([s.sessionId]);
    let current = s;
    for (;;) {
      const parent = parentOf(current);
      const next = parent === undefined ? undefined : byId.get(parent);
      const root = next === undefined ? current : roots.get(next.sessionId);
      if (root !== undefined) {
        for (const member of path) roots.set(member.sessionId, root);
        return root;
      }
      // A parent cycle (a corrupt store): the session is its own root rather than lost. Only this
      // session is settled; each other member of the cycle settles the same way when asked.
      if (seen.has(next!.sessionId)) {
        roots.set(s.sessionId, s);
        return s;
      }
      seen.add(next!.sessionId);
      path.push(next!);
      current = next!;
    }
  };
  // Each root, then its descendants in the given (recent-first) order: one pass, no rescans.
  // Roots keep their own (recent-first) order, however recent their descendants are.
  const members = new Map<string, SessionInfo[]>();
  for (const s of visible) if (rootOf(s) === s) members.set(s.sessionId, [s]);
  for (const s of visible) {
    const root = rootOf(s);
    if (root !== s) members.get(root.sessionId)?.push(s);
  }
  const inView = [...members.values()].flat();
  const groups: SessionGroup[] = [];
  // A session pinned itself, or under a pinned root, shows in Pinned; a pinned child leaves its day group.
  const pinned = (s: SessionInfo) => sessionFlags(s).pinnedAt !== undefined || sessionFlags(rootOf(s)).pinnedAt !== undefined;
  const rest = view === "active" ? inView.filter((s) => !pinned(s)) : inView;
  if (view === "active") {
    const pinnedSessions = inView.filter(pinned);
    if (pinnedSessions.length > 0) groups.push({ label: PINNED_GROUP, sessions: pinnedSessions });
  }
  for (const s of rest) {
    const label = dayBucket(rootOf(s).updatedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.sessions.push(s);
    else groups.push({ label, sessions: [s] });
  }
  return groups.map((group) => {
    const tree = asTree(group.sessions);
    return Object.keys(tree.depths).length === 0 ? { ...group, sessions: tree.sessions } : { ...group, sessions: tree.sessions, depths: tree.depths };
  });
}
