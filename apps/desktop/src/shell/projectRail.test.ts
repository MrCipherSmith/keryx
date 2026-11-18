import { describe, expect, test } from "bun:test";
import type { SessionMark } from "../session/reducer";
import { projectActivity, projectHue, projectInitials, railProjects, RAIL_MAX } from "./projectRail";

function mark(p: Partial<SessionMark>): SessionMark {
  return { busy: false, waiting: false, held: true, lostReason: null, title: null, running: 0, subagents: [], ...p };
}

describe("railProjects", () => {
  test("first use seeds from recents, oldest first, current included", () => {
    expect(railProjects("/a", ["/a", "/b", "/c"], null)).toEqual(["/c", "/b", "/a"]);
  });
  test("a stored list keeps its order; a new project is added at the end", () => {
    expect(railProjects("/b", ["/b", "/a"], ["/a", "/b"])).toEqual(["/a", "/b"]);
    expect(railProjects("/new", ["/new", "/a"], ["/a", "/b"])).toEqual(["/a", "/b", "/new"]);
  });
  test("keeps at most RAIL_MAX, never dropping the current project", () => {
    const stored = Array.from({ length: RAIL_MAX }, (_, i) => `/p${i}`);
    const list = railProjects("/new", [], stored);
    expect(list.length).toBe(RAIL_MAX);
    expect(list).toContain("/new");
    expect(list).not.toContain("/p0");
  });
});

describe("projectInitials", () => {
  test("two words give two initials, one word its first two letters", () => {
    expect(projectInitials("vantage-frontend")).toBe("VF");
    expect(projectInitials("keryx")).toBe("KE");
    expect(projectInitials("myApp")).toBe("MA");
    expect(projectInitials("___")).toBe("?");
  });
  test("hue is stable and in range", () => {
    expect(projectHue("/x/y")).toBe(projectHue("/x/y"));
    const hue = projectHue("/x/y");
    expect(hue >= 0 && hue < 360 && Number.isInteger(hue)).toBe(true);
  });
});

describe("projectActivity", () => {
  test("a waiting dialog wins over a running turn; nothing live is idle", () => {
    expect(projectActivity({ a: mark({ busy: true }), b: mark({ waiting: true }) })).toBe("action");
    expect(projectActivity({ a: mark({ busy: true }) })).toBe("busy");
    expect(projectActivity({ a: mark({ running: 2 }) })).toBe("busy");
    expect(projectActivity({ a: mark({}) })).toBe("idle");
    expect(projectActivity({})).toBe("idle");
  });
});
