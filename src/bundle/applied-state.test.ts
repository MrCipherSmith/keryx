// Flow 313 (W4 portability), T6 — applied-state.ts: missing ledger reads as
// empty, a corrupt ledger fails closed, and writes are atomic/sorted.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { appliedStatePath, readAppliedState, writeAppliedState } from "./applied-state";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-ledger-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("appliedStatePath", () => {
  test("project/team share one ledger under .metaproject/data/bundles", () => {
    const ctx = { projectRoot: root, env: {}, homeDir: root };
    expect(appliedStatePath("project", ctx)).toBe(path.join(root, ".metaproject", "data", "bundles", "applied-state.json"));
    expect(appliedStatePath("team", ctx)).toBe(appliedStatePath("project", ctx));
  });

  test("user ledger lives under <home>/.keryx/bundles/applied-state.json", () => {
    const ctx = { projectRoot: root, env: {}, homeDir: root };
    expect(appliedStatePath("user", ctx)).toBe(path.join(root, ".keryx", "bundles", "applied-state.json"));
  });
});

describe("readAppliedState / writeAppliedState", () => {
  test("a missing ledger reads as empty", async () => {
    const ledgerPath = path.join(root, "nope", "applied-state.json");
    const result = await readAppliedState(ledgerPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.state.entries).toEqual({});
  });

  test("a corrupt ledger fails closed, not as empty", async () => {
    const dir = path.join(root, "ledger");
    mkdirSync(dir, { recursive: true });
    const ledgerPath = path.join(dir, "applied-state.json");
    writeFileSync(ledgerPath, "{not json");
    const result = await readAppliedState(ledgerPath);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("corrupt-ledger");
  });

  test("write then read round-trips, with keys sorted", async () => {
    const dir = path.join(root, "ledger2");
    const ledgerPath = path.join(dir, "applied-state.json");
    await writeAppliedState(ledgerPath, {
      schemaVersion: 1,
      entries: {
        "b/two.md": { bundleId: "x", sha256: "b".repeat(64), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" },
        "a/one.md": { bundleId: "x", sha256: "a".repeat(64), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z" },
      },
    });
    const raw = readFileSync(ledgerPath, "utf8");
    expect(raw.indexOf('"a/one.md"')).toBeLessThan(raw.indexOf('"b/two.md"'));

    const result = await readAppliedState(ledgerPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.state.entries)).toEqual(["a/one.md", "b/two.md"]);
  });
});
