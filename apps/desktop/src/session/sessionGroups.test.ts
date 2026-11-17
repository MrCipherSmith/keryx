import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../acp/types";
import { countViews, dayBucket, groupSessions, PINNED_GROUP } from "./sessionGroups";

const NOW = new Date(2026, 10, 17, 15, 0, 0);
const at = (daysAgo: number, hour = 12): string => new Date(2026, 10, 17 - daysAgo, hour).toISOString();

function s(id: string, updatedAt: string, flags: { archivedAt?: string; pinnedAt?: string } = {}): SessionInfo {
  return { sessionId: id, cwd: "/p", title: id, updatedAt, ...(Object.keys(flags).length ? { _meta: { keryx: flags } } : {}) };
}

describe("session groups", () => {
  test("active view: Pinned first, then days, newest first; archived ones are left out", () => {
    const list = [
      s("old", at(40)),
      s("today-early", at(0, 9)),
      s("pinned-old", at(30), { pinnedAt: at(1) }),
      s("today-late", at(0, 14)),
      s("yesterday", at(1)),
      s("archived", at(0), { archivedAt: at(0) }),
    ];
    const groups = groupSessions(list, "active", NOW);
    expect(groups.map((g) => g.label)).toEqual([PINNED_GROUP, "Today", "Yesterday", dayBucket(at(40), NOW)]);
    expect(groups[1]!.sessions.map((x) => x.sessionId)).toEqual(["today-late", "today-early"]);
    expect(groups.flatMap((g) => g.sessions).some((x) => x.sessionId === "archived")).toBe(false);
  });

  test("archived view holds only archived sessions, pinned or not, by day", () => {
    const list = [s("a", at(0), { archivedAt: at(0), pinnedAt: at(0) }), s("b", at(3), { archivedAt: at(0) }), s("c", at(0))];
    const groups = groupSessions(list, "archived", NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Previous 7 days"]);
    expect(countViews(list)).toEqual({ active: 1, archived: 2 });
  });

  test("no pinned sessions: no Pinned group", () => {
    expect(groupSessions([s("a", at(0))], "active", NOW).map((g) => g.label)).toEqual(["Today"]);
  });
});
