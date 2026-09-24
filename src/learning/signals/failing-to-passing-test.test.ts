import { describe, expect, test } from "bun:test";
import { failingToPassingTestSignal, normalizeTestCommand } from "./failing-to-passing-test";
import type { ObservationLine } from "./types";
import type { ObservationEvent } from "../types";

const PROJECT = { identity: "a".repeat(64), identityKind: "remote-hash" as const };

function line(overrides: Partial<ObservationEvent>, file = "2026-09-24.jsonl", n = 1): ObservationLine {
  const event: ObservationEvent = {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Bash",
    inputDigest: "b".repeat(64),
    inputPreview: "bun test src/foo.test.ts",
    outputPreview: null,
    sessionId: "sess-1",
    toolUseId: "tu-1",
    cwdHash: "c".repeat(64),
    project: PROJECT,
    observedAt: "2026-09-24T00:00:00.000Z",
    ...overrides,
  };
  return { event, sourceRef: `.metaproject/data/learning/observations/${file}#L${n}` };
}

describe("normalizeTestCommand", () => {
  test("strips env assignments and a leading cd", () => {
    expect(normalizeTestCommand("cd packages/app && CI=1 FOO=bar bun test src/foo.test.ts")).toBe(
      "bun test src/foo.test.ts",
    );
  });
});

describe("failingToPassingTestSignal", () => {
  test("a fail followed by a pass for the same test name yields exactly one draft (AC2)", async () => {
    const window: ObservationLine[] = [
      line({ event: "tool-failed", inputPreview: "bun test src/foo.test.ts", outputPreview: "1 fail" }, "2026-09-24.jsonl", 1),
      line({ event: "tool-complete", inputPreview: "bun test src/foo.test.ts", outputPreview: "0 fail 3 pass" }, "2026-09-24.jsonl", 2),
    ];
    const drafts = await failingToPassingTestSignal("/root", window);
    expect(drafts.length).toBe(1);
    expect(drafts[0]?.extractor).toBe("failing-to-passing-test");
    expect(drafts[0]?.domain).toBe("testing");
    expect(drafts[0]?.evidence.length).toBeGreaterThanOrEqual(1);
    expect(drafts[0]?.evidence[0]?.weight).toBe(1.5);
    expect(drafts[0]?.evidence[0]?.sourceType).toBe("test");
  });

  test("tolerates env assignments and cd prefixes as the same test name", async () => {
    const window: ObservationLine[] = [
      line({ event: "tool-failed", inputPreview: "CI=1 bun test src/foo.test.ts", outputPreview: null }, "2026-09-24.jsonl", 1),
      line({ event: "tool-complete", inputPreview: "cd . && bun test src/foo.test.ts", outputPreview: "0 fail" }, "2026-09-24.jsonl", 2),
    ];
    const drafts = await failingToPassingTestSignal("/root", window);
    expect(drafts.length).toBe(1);
  });

  test("no draft without a prior failure", async () => {
    const window: ObservationLine[] = [
      line({ event: "tool-complete", inputPreview: "bun test src/foo.test.ts", outputPreview: "0 fail" }),
    ];
    expect(await failingToPassingTestSignal("/root", window)).toEqual([]);
  });

  test("non-test commands are ignored", async () => {
    const window: ObservationLine[] = [
      line({ event: "tool-failed", inputPreview: "git status", outputPreview: null }),
      line({ event: "tool-complete", inputPreview: "git status", outputPreview: "clean" }),
    ];
    expect(await failingToPassingTestSignal("/root", window)).toEqual([]);
  });

  test("a '0 fail' outcome is not misread as a failure", async () => {
    const window: ObservationLine[] = [
      line({ event: "tool-complete", inputPreview: "bun test", outputPreview: "0 fail 5 pass" }, "2026-09-24.jsonl", 1),
      line({ event: "tool-complete", inputPreview: "bun test", outputPreview: "0 fail 5 pass" }, "2026-09-24.jsonl", 2),
    ];
    expect(await failingToPassingTestSignal("/root", window)).toEqual([]);
  });
});
