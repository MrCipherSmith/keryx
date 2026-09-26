import { describe, expect, test } from "bun:test";
import { EDIT_GUARD_COMMAND, formatEditGuardLines, isEditGuardCommand, renderEditGuardSidebarValue, type EditGuardStatusSnapshot } from "./jev-edit-guard-inspector";

function snapshot(overrides: Partial<EditGuardStatusSnapshot> = {}): EditGuardStatusSnapshot {
  return {
    enabled: false,
    threshold: 0.5,
    maxCalls: 24,
    today: { calls: 0, flagged: 0, costUsd: 0 },
    recentFlags: [],
    ...overrides,
  };
}

describe("isEditGuardCommand", () => {
  test("matches the bare command and with trailing args", () => {
    expect(isEditGuardCommand("/editguard")).toBe(true);
    expect(isEditGuardCommand("/editguard on")).toBe(true);
    expect(isEditGuardCommand("  /editguard  ")).toBe(true);
  });
  test("does not match another command", () => {
    expect(isEditGuardCommand("/guard")).toBe(false);
    expect(isEditGuardCommand("/route")).toBe(false);
    expect(isEditGuardCommand("editguard")).toBe(false);
  });
  test("the exported token matches the constant used elsewhere", () => {
    expect(EDIT_GUARD_COMMAND).toBe("/editguard");
  });
});

describe("formatEditGuardLines", () => {
  test("shows on/off, threshold, max-calls and today's counts", () => {
    const lines = formatEditGuardLines(snapshot({ enabled: true, threshold: 0.5, maxCalls: 24, today: { calls: 3, flagged: 1, costUsd: 0.0012 } }));
    const text = lines.join("\n");
    expect(text).toContain("on");
    expect(text).toContain("threshold 0.5");
    expect(text).toContain("max 24 call(s)/edit");
    expect(text).toContain("3 Jev call(s), 1 flag(s)");
  });

  test("recent flags are listed with file, clause and probability", () => {
    const lines = formatEditGuardLines(
      snapshot({
        recentFlags: [{ file: "src/a.ts", line: 10, ruleId: "rules/core/foo.mdc", clauseId: "heading-1", probability: 0.73, at: "2026-06-01T00:00:00.000Z" }],
      }),
    );
    const text = lines.join("\n");
    expect(text).toContain("src/a.ts:10");
    expect(text).toContain("rules/core/foo.mdc#heading-1");
    expect(text).toContain("0.73");
  });

  test("says so when there are no recent flags", () => {
    const text = formatEditGuardLines(snapshot()).join("\n");
    expect(text).toContain("none yet");
  });
});

describe("renderEditGuardSidebarValue", () => {
  test("undefined (nothing rendered) while off", () => {
    expect(renderEditGuardSidebarValue(snapshot({ enabled: false }))).toBeUndefined();
  });
  test("on with today's counts, no flagged clause when zero", () => {
    expect(renderEditGuardSidebarValue(snapshot({ enabled: true, today: { calls: 4, flagged: 0, costUsd: 0 } }))).toBe("on · 4 checked today");
  });
  test("on with a flagged count appended when non-zero", () => {
    expect(renderEditGuardSidebarValue(snapshot({ enabled: true, today: { calls: 4, flagged: 2, costUsd: 0 } }))).toBe("on · 4 checked today, 2 flagged");
  });
});
