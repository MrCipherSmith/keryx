import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../acp/types";
import { countViews, dayBucket, depthOf, groupSessions, PINNED_GROUP } from "./sessionGroups";

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

test("a child session follows its parent, in the parent's group, one level deeper per generation", () => {
  const child = (id: string, parent: string, updatedAt: string, extra: Record<string, unknown> = {}) =>
    ({ sessionId: id, cwd: "/p", updatedAt, _meta: { keryx: { parentSessionId: parent, ...extra } } });
  const list = [
    { sessionId: "root", cwd: "/p", updatedAt: at(40) },
    child("fork", "root", at(0, 10)),
    child("fork-of-fork", "fork", at(0, 9)),
    { sessionId: "other", cwd: "/p", updatedAt: at(0, 8) },
    child("orphan", "deleted", at(0, 11)),
  ];
  const groups = groupSessions(list, "active", NOW);
  const all = groups.flatMap((g) => g.sessions.map((s) => `${"-".repeat(depthOf(g, s.sessionId))}${s.sessionId}`));
  expect(all).toEqual(["orphan", "other", "root", "-fork", "--fork-of-fork"]);
  // The tree is grouped by its root's day, so the fresh fork is not split from its 40-day-old parent.
  expect(groups.find((g) => g.sessions.some((s) => s.sessionId === "fork"))?.label).toBe(dayBucket(at(40), NOW));
  // A pinned root brings its children into Pinned; an archived child leaves the active tree.
  const pinned = groupSessions([{ sessionId: "root", cwd: "/p", updatedAt: at(1), _meta: { keryx: { pinnedAt: at(1) } } }, child("fork", "root", at(0))], "active", NOW);
  expect(pinned[0]).toMatchObject({ label: PINNED_GROUP, depths: { fork: 1 } });
  const archived = groupSessions([{ sessionId: "root", cwd: "/p", updatedAt: at(1) }, child("fork", "root", at(0), { archivedAt: at(0) })], "active", NOW);
  expect(archived.flatMap((g) => g.sessions.map((s) => s.sessionId))).toEqual(["root"]);
  // A pinned child shows in Pinned even when its root is not, and leaves the root's day group.
  const pinnedChild = groupSessions([{ sessionId: "root", cwd: "/p", updatedAt: at(1) }, child("fork", "root", at(0), { pinnedAt: at(0) })], "active", NOW);
  expect(pinnedChild.map((g) => [g.label, g.sessions.map((s) => s.sessionId)])).toEqual([[PINNED_GROUP, ["fork"]], [dayBucket(at(1), NOW), ["root"]]]);
});

test("a long chain of children groups in one pass", () => {
  const chain = Array.from({ length: 3000 }, (_, i) => ({
    sessionId: `s${i}`, cwd: "/p", updatedAt: at(0, i % 20),
    ...(i === 0 ? {} : { _meta: { keryx: { parentSessionId: `s${i - 1}` } } }),
  }));
  const started = performance.now();
  const groups = groupSessions(chain, "active", NOW);
  expect(groups.flatMap((g) => g.sessions).length).toBe(3000);
  expect(groups).toHaveLength(1);
  // Quadratic root resolution took seconds here; one pass takes milliseconds.
  expect(performance.now() - started < 1000).toBe(true);
});

test("a parent cycle keeps every session listed", () => {
  const cyc = (id: string, parent: string) => ({ sessionId: id, cwd: "/p", updatedAt: at(0), _meta: { keryx: { parentSessionId: parent } } });
  expect(groupSessions([cyc("a", "b"), cyc("b", "a")], "active", NOW).flatMap((g) => g.sessions).length).toBe(2);
});
