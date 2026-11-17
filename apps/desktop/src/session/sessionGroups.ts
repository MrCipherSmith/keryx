// How the session sidebar groups sessions: a Pinned group first, then by the
// day each was last active, newest first. Archived sessions are a view of
// their own, grouped by day too. Pure, no React.

import { sessionFlags, type SessionInfo } from "../acp/types";

export type SidebarView = "active" | "archived";

export const PINNED_GROUP = "Pinned";

export interface SessionGroup {
  /** Also the key the collapsed state is stored under. */
  label: string;
  sessions: SessionInfo[];
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
  const inView = sessions.filter((s) => isArchived(s) === (view === "archived")).sort(byRecent);
  const groups: SessionGroup[] = [];
  const rest = view === "active" ? inView.filter((s) => sessionFlags(s).pinnedAt === undefined) : inView;
  if (view === "active") {
    const pinned = inView.filter((s) => sessionFlags(s).pinnedAt !== undefined);
    if (pinned.length > 0) groups.push({ label: PINNED_GROUP, sessions: pinned });
  }
  for (const s of rest) {
    const label = dayBucket(s.updatedAt, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.sessions.push(s);
    else groups.push({ label, sessions: [s] });
  }
  return groups;
}
