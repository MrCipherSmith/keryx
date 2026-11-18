import { messageCount, sessionFlags, type SessionInfo } from "../acp/types";

const DAY_MS = 24 * 60 * 60 * 1000;

function time(s: SessionInfo): number {
  const t = s.updatedAt ? Date.parse(s.updatedAt) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/**
 * The session a project opens on: the newest empty one when there is one (so opening a project
 * again does not pile up blank sessions), else the newest one in use. Archived sessions are never
 * picked. Null means start a new session. A keryx that does not report message counts has no
 * "empty" sessions: its newest session is picked.
 */
export function pickStartSession(sessions: readonly SessionInfo[]): string | null {
  const open = sessions.filter((s) => sessionFlags(s).archivedAt === undefined).sort((a, b) => time(b) - time(a));
  const empty = open.find((s) => messageCount(s) === 0);
  return (empty ?? open[0])?.sessionId ?? null;
}

/**
 * Sessions to archive for inactivity: not archived, not pinned, untouched for `days` days, and not
 * in `keep` (the shown session, and any with a running turn or task). `days` <= 0 archives nothing.
 */
export function idleSessions(sessions: readonly SessionInfo[], now: number, days: number, keep: ReadonlySet<string>): string[] {
  if (!(days > 0)) return [];
  const cutoff = now - days * DAY_MS;
  return sessions
    .filter((s) => {
      const f = sessionFlags(s);
      if (f.archivedAt !== undefined || f.pinnedAt !== undefined || keep.has(s.sessionId)) return false;
      const t = time(s);
      return t > 0 && t < cutoff;
    })
    .map((s) => s.sessionId);
}
