// Flow 313 (W4 portability), T6 — apply.ts: writes only when plan+audit are
// ok, updates the ledger (including identical entries), and rolls back
// completely on a failing write or a precondition refusal (zero writes).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyBundlePlan } from "./apply";
import { appliedStatePath, readAppliedState } from "./applied-state";
import { sha256Hex } from "./checksum";
import type { AuditBundlePlanResult } from "./audit";
import type { BundlePlan, PlanEntry } from "./plan";

let root: string;
let projectRoot: string;
let homeDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-apply-"));
  projectRoot = path.join(root, "project");
  homeDir = path.join(root, "home");
  mkdirSync(path.join(projectRoot, ".metaproject", "agents"), { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const OK_AUDIT: AuditBundlePlanResult = { ok: true, refusals: [], report: null };

function planEntry(overrides: Partial<PlanEntry> = {}): PlanEntry {
  const bytes = overrides.bytes ?? Buffer.from("content");
  return {
    path: "agents/a.md",
    kind: "agent",
    entryScope: "project",
    targetScope: "project",
    targetRelative: "agents/a.md",
    displayId: "project:agents/a.md",
    targetPath: path.join(projectRoot, ".metaproject", "agents", "a.md"),
    bucket: "new",
    forced: false,
    incomingSha256: sha256Hex(bytes),
    bytes,
    ...overrides,
  };
}

describe("applyBundlePlan", () => {
  test("writes new entries and records the ledger", async () => {
    const entry = planEntry();
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [entry] };
    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {}, now: () => new Date("2026-09-24T00:00:00.000Z") });
    expect(result.refusals).toEqual([]);
    expect(result.written).toEqual(["project:agents/a.md"]);
    expect(readFileSync(entry.targetPath, "utf8")).toBe("content");

    const ledger = await readAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }));
    expect(ledger.ok).toBe(true);
    if (ledger.ok) {
      expect(ledger.state.entries["agents/a.md"]?.bundleId).toBe("keryx-project-x");
      expect(ledger.state.entries["agents/a.md"]?.sha256).toBe(entry.incomingSha256);
    }
  });

  test("a not-ok plan writes nothing", async () => {
    const plan: BundlePlan = { ok: false, bundleId: "keryx-project-x", refusals: [{ reason: "checksum-mismatch", message: "bad" }], entries: [] };
    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.written).toEqual([]);
    expect(existsSync(appliedStatePath("project", { projectRoot, homeDir, env: {} }))).toBe(false);
  });

  test("a not-ok audit result writes nothing", async () => {
    const entry = planEntry();
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [entry] };
    const failingAudit: AuditBundlePlanResult = { ok: false, refusals: [{ reason: "audit-failed", message: "nope" }], report: null };
    const result = await applyBundlePlan(plan, failingAudit, { homeDir, env: {} });
    expect(result.written).toEqual([]);
    expect(existsSync(entry.targetPath)).toBe(false);
  });

  test("rolls back every write when one write in the batch fails", async () => {
    const goodEntry = planEntry({ path: "agents/a.md", targetRelative: "agents/a.md", displayId: "project:agents/a.md", targetPath: path.join(projectRoot, ".metaproject", "agents", "a.md") });
    // A target path whose parent is a FILE (not a directory) so mkdir/write fails.
    const blockerPath = path.join(projectRoot, ".metaproject", "agents", "blocker");
    writeFileSync(blockerPath, "x");
    const badEntry = planEntry({
      path: "agents/blocker/nested.md",
      targetRelative: "agents/blocker/nested.md",
      displayId: "project:agents/blocker/nested.md",
      targetPath: path.join(blockerPath, "nested.md"),
      bytes: Buffer.from("nested"),
      incomingSha256: sha256Hex(Buffer.from("nested")),
    });
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [goodEntry, badEntry] };
    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.written).toEqual([]);
    expect(existsSync(goodEntry.targetPath)).toBe(false);
    expect(existsSync(appliedStatePath("project", { projectRoot, homeDir, env: {} }))).toBe(false);
  });
});
