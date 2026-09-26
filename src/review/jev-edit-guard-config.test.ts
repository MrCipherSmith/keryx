import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readJevEditGuardConfig,
  readJevEditGuardEnabled,
  readJevEditGuardMaxCalls,
  readJevEditGuardThreshold,
  writeJevEditGuardEnabled,
} from "./jev-edit-guard-config";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "keryx-edit-guard-config-"));
  mkdirSync(path.join(dir, ".metaproject"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: unknown): void {
  writeFileSync(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify(content));
}

describe("reads: fail-closed, never throw", () => {
  test("no tasks.config.json at all -> disabled, default threshold/max-calls", async () => {
    expect(await readJevEditGuardEnabled(dir)).toBe(false);
    expect(await readJevEditGuardThreshold(dir)).toBe(0.5);
    expect(await readJevEditGuardMaxCalls(dir)).toBeGreaterThan(0);
  });

  test("unparsable tasks.config.json -> disabled, defaults", async () => {
    writeFileSync(path.join(dir, ".metaproject", "tasks.config.json"), "{not json");
    expect(await readJevEditGuardEnabled(dir)).toBe(false);
    expect(await readJevEditGuardThreshold(dir)).toBe(0.5);
  });

  test("review.jev.edit_guard: true is read", async () => {
    writeConfig({ review: { jev: { edit_guard: true } } });
    expect(await readJevEditGuardEnabled(dir)).toBe(true);
  });

  test("a non-boolean edit_guard value reads as disabled", async () => {
    writeConfig({ review: { jev: { edit_guard: "yes" } } });
    expect(await readJevEditGuardEnabled(dir)).toBe(false);
  });

  test("threshold is read and clamped to 0..1, else default", async () => {
    writeConfig({ review: { jev: { edit_guard_threshold: 0.2 } } });
    expect(await readJevEditGuardThreshold(dir)).toBe(0.2);
    writeConfig({ review: { jev: { edit_guard_threshold: 1.5 } } });
    expect(await readJevEditGuardThreshold(dir)).toBe(0.5);
    writeConfig({ review: { jev: { edit_guard_threshold: -0.1 } } });
    expect(await readJevEditGuardThreshold(dir)).toBe(0.5);
    writeConfig({ review: { jev: { edit_guard_threshold: "0.3" } } });
    expect(await readJevEditGuardThreshold(dir)).toBe(0.5);
  });

  test("max-calls is read, non-positive/non-numeric falls back to default", async () => {
    writeConfig({ review: { jev: { edit_guard_max_calls: 5 } } });
    expect(await readJevEditGuardMaxCalls(dir)).toBe(5);
    writeConfig({ review: { jev: { edit_guard_max_calls: 0 } } });
    expect(await readJevEditGuardMaxCalls(dir)).toBeGreaterThan(0);
    writeConfig({ review: { jev: { edit_guard_max_calls: -3 } } });
    expect(await readJevEditGuardMaxCalls(dir)).toBeGreaterThan(0);
  });

  test("readJevEditGuardConfig combines all three", async () => {
    writeConfig({ review: { jev: { edit_guard: true, edit_guard_threshold: 0.7, edit_guard_max_calls: 10 } } });
    const cfg = await readJevEditGuardConfig(dir);
    expect(cfg).toEqual({ enabled: true, threshold: 0.7, maxCalls: 10 });
  });
});

describe("writeJevEditGuardEnabled: preserves everything else", () => {
  test("creates a fresh file when none exists", async () => {
    await writeJevEditGuardEnabled(dir, true);
    expect(await readJevEditGuardEnabled(dir)).toBe(true);
  });

  test("flips only review.jev.edit_guard, keeping sibling keys and unrelated top-level config", async () => {
    writeConfig({
      someOtherTaskManagerSetting: { keep: "me" },
      review: { jev: { edit_guard_threshold: 0.7 }, someOtherReviewer: true },
    });
    await writeJevEditGuardEnabled(dir, true);
    const raw = JSON.parse(readFileSync(path.join(dir, ".metaproject", "tasks.config.json"), "utf8"));
    expect(raw.someOtherTaskManagerSetting).toEqual({ keep: "me" });
    expect(raw.review.someOtherReviewer).toBe(true);
    expect(raw.review.jev.edit_guard_threshold).toBe(0.7);
    expect(raw.review.jev.edit_guard).toBe(true);
  });

  test("toggling off after on round-trips", async () => {
    await writeJevEditGuardEnabled(dir, true);
    expect(await readJevEditGuardEnabled(dir)).toBe(true);
    await writeJevEditGuardEnabled(dir, false);
    expect(await readJevEditGuardEnabled(dir)).toBe(false);
  });

  test("refuses to overwrite an existing file that is not valid JSON, rather than discard it", async () => {
    writeFileSync(path.join(dir, ".metaproject", "tasks.config.json"), "{not json");
    await expect(writeJevEditGuardEnabled(dir, true)).rejects.toThrow(/not valid JSON/);
  });
});
