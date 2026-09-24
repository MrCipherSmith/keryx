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
      schemaVersion: 2,
      entries: {
        "b/two.md": { bundleId: "x", sha256: "b".repeat(64), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z", path: "b/two.md" },
        "a/one.md": { bundleId: "x", sha256: "a".repeat(64), kind: "agent", appliedAt: "2026-09-24T00:00:00.000Z", path: "a/one.md" },
      },
    });
    const raw = readFileSync(ledgerPath, "utf8");
    expect(raw.indexOf('"a/one.md"')).toBeLessThan(raw.indexOf('"b/two.md"'));

    const result = await readAppliedState(ledgerPath);
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.state.entries)).toEqual(["a/one.md", "b/two.md"]);
  });

  // Flow 313 re-plan, lane C2, choke point b (R3-F2): the ledger's key is
  // the CANONICAL (case-folded) form of the path, not the path's own
  // casing — recorded in v2, migrated from v1.
  describe("choke point b: canonical ledger keys (R3-F2)", () => {
    test("a v1 ledger (keyed by raw path, no `path` field) is migrated to v2 in memory", async () => {
      const dir = path.join(root, "ledger-v1");
      const ledgerPath = path.join(dir, "applied-state.json");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          entries: { "Rules/X.md": { bundleId: "b", sha256: "a".repeat(64), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z" } },
        }),
      );
      const result = await readAppliedState(ledgerPath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.schemaVersion).toBe(2);
        expect(Object.keys(result.state.entries)).toEqual(["rules/x.md"]);
        expect(result.state.entries["rules/x.md"]).toMatchObject({ bundleId: "b", path: "Rules/X.md" });
      }
    });

    test("a v1 ledger whose two raw keys fold to the same canonical key refuses closed, not picking a winner", async () => {
      const dir = path.join(root, "ledger-v1-collide");
      const ledgerPath = path.join(dir, "applied-state.json");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        ledgerPath,
        JSON.stringify({
          schemaVersion: 1,
          entries: {
            "rules/x.md": { bundleId: "a", sha256: "a".repeat(64), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z" },
            "rules/X.md": { bundleId: "b", sha256: "b".repeat(64), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z" },
          },
        }),
      );
      const result = await readAppliedState(ledgerPath);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("corrupt-ledger");
    });

    test("a v2 record's own `path` and its `sourceProject`/`contentDigest` fields round-trip", async () => {
      const dir = path.join(root, "ledger-v2-fields");
      const ledgerPath = path.join(dir, "applied-state.json");
      await writeAppliedState(ledgerPath, {
        schemaVersion: 2,
        entries: {
          "rules/x.md": {
            bundleId: "b",
            sha256: "a".repeat(64),
            kind: "rule",
            appliedAt: "2026-01-01T00:00:00.000Z",
            path: "rules/x.md",
            sourceProject: "sha256:deadbeef",
            contentDigest: "beefdead",
          },
        },
      });
      const result = await readAppliedState(ledgerPath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.state.entries["rules/x.md"]).toMatchObject({ sourceProject: "sha256:deadbeef", contentDigest: "beefdead" });
      }
    });
  });
});
