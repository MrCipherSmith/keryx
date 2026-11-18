import { describe, expect, test } from "bun:test";
import type { SessionInfo } from "../acp/types";
import { idleSessions, pickStartSession } from "./startup";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-19T12:00:00Z");

function s(id: string, daysAgo: number, keryx?: Record<string, unknown>): SessionInfo {
  return { sessionId: id, cwd: "/p", updatedAt: new Date(NOW - daysAgo * DAY).toISOString(), _meta: keryx ? { keryx } : undefined };
}

describe("pickStartSession", () => {
  test("opens the newest empty session before any used one", () => {
    expect(pickStartSession([s("used", 0, { messageCount: 4 }), s("emptyOld", 3, { messageCount: 0 }), s("emptyNew", 1, { messageCount: 0 })])).toBe("emptyNew");
  });
  test("without an empty session, opens the newest one in use", () => {
    expect(pickStartSession([s("older", 2, { messageCount: 2 }), s("newer", 1, { messageCount: 9 })])).toBe("newer");
  });
  test("never opens an archived session; none left means a new one", () => {
    const archived = { messageCount: 0, archivedAt: "2026-11-01T00:00:00Z" };
    expect(pickStartSession([s("a", 0, archived), s("b", 5, { messageCount: 3 })])).toBe("b");
    expect(pickStartSession([s("a", 0, archived)])).toBeNull();
    expect(pickStartSession([])).toBeNull();
  });
  test("a keryx without message counts opens its newest session", () => {
    expect(pickStartSession([s("old", 4), s("new", 1)])).toBe("new");
  });
});

describe("idleSessions", () => {
  test("archives sessions untouched for longer than the window", () => {
    expect(idleSessions([s("fresh", 1), s("stale", 5), s("edge", 3.9)], NOW, 4, new Set())).toEqual(["stale"]);
  });
  test("keeps pinned, archived, kept and undated sessions", () => {
    const list = [
      s("pinned", 9, { pinnedAt: "2026-11-01T00:00:00Z" }),
      s("archived", 9, { archivedAt: "2026-11-01T00:00:00Z" }),
      s("shown", 9),
      { sessionId: "undated", cwd: "/p" },
      s("stale", 9),
    ];
    expect(idleSessions(list, NOW, 4, new Set(["shown"]))).toEqual(["stale"]);
  });
  test("zero days turns retention off", () => {
    expect(idleSessions([s("stale", 30)], NOW, 0, new Set())).toEqual([]);
  });
});
