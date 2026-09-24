// Flow 313 (W4 portability), T6 — apply.ts: writes only when plan+audit are
// ok, updates the ledger (including identical entries), and rolls back
// completely on a failing write or a precondition refusal (zero writes).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { applyBundlePlan } from "./apply";
import { appliedStatePath, readAppliedState, writeAppliedState } from "./applied-state";
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
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };
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
    const plan: BundlePlan = { ok: false, bundleId: "keryx-project-x", refusals: [{ reason: "checksum-mismatch", message: "bad" }], entries: [], projectRoot, bundleContentDigest: "digest" };
    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.written).toEqual([]);
    expect(existsSync(appliedStatePath("project", { projectRoot, homeDir, env: {} }))).toBe(false);
  });

  test("a not-ok audit result writes nothing", async () => {
    const entry = planEntry();
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };
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
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [goodEntry, badEntry], projectRoot, bundleContentDigest: "digest" };
    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.written).toEqual([]);
    expect(existsSync(goodEntry.targetPath)).toBe(false);
    expect(existsSync(appliedStatePath("project", { projectRoot, homeDir, env: {} }))).toBe(false);
  });

  // R1-F1: an "identical" entry must be claimed into THIS bundle's ledger
  // ONLY when a ledger record for it already exists and already belongs to
  // this bundle. Pre-fix, apply unconditionally wrote a ledger record for
  // every identical entry under the importing bundle's id — including a
  // file that predates any bundle (no ledger record at all: a user's own
  // pre-existing file) and a file another bundle's ledger record already
  // claims. Both cases let a later `uninstall` of the WRONG bundle delete a
  // file it never wrote, and silently stole ownership from whichever bundle
  // (if any) actually wrote it.
  describe("R1-F1: identical-entry ledger ownership", () => {
    test("an identical entry with NO existing ledger record is left unrecorded (a user's own pre-existing file)", async () => {
      const bytes = Buffer.from("pre-existing, unmanaged content");
      const targetPath = path.join(projectRoot, ".metaproject", "agents", "a.md");
      writeFileSync(targetPath, bytes); // the file already exists on disk — not written by any bundle.
      const entry = planEntry({ bucket: "identical", bytes, incomingSha256: sha256Hex(bytes), currentSha256: sha256Hex(bytes) });
      const plan: BundlePlan = { ok: true, bundleId: "keryx-project-newcomer", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };

      const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
      expect(result.refusals).toEqual([]);
      expect(result.unchanged).toEqual(["project:agents/a.md"]);

      const ledger = await readAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }));
      expect(ledger.ok).toBe(true);
      // No ledger RECORD for this path — nothing was ever written by any
      // bundle here, so there is nothing to claim ownership of.
      if (ledger.ok) expect(ledger.state.entries["agents/a.md"]).toBeUndefined();
    });

    test("an identical entry whose ledger record belongs to ANOTHER bundle is left untouched, not reassigned", async () => {
      const bytes = Buffer.from("owned by another bundle");
      const targetPath = path.join(projectRoot, ".metaproject", "agents", "a.md");
      writeFileSync(targetPath, bytes);
      const ledgerPath = appliedStatePath("project", { projectRoot, homeDir, env: {} });
      await writeAppliedState(ledgerPath, {
        schemaVersion: 2,
        entries: { "agents/a.md": { bundleId: "keryx-project-original-owner", sha256: sha256Hex(bytes), kind: "agent", appliedAt: "2026-01-01T00:00:00.000Z", path: "agents/a.md" } },
      });
      const entry = planEntry({ bucket: "identical", bytes, incomingSha256: sha256Hex(bytes), currentSha256: sha256Hex(bytes) });
      const plan: BundlePlan = { ok: true, bundleId: "keryx-project-second-bundle", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };

      const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
      expect(result.refusals).toEqual([]);
      expect(result.unchanged).toEqual(["project:agents/a.md"]);

      const ledger = await readAppliedState(ledgerPath);
      expect(ledger.ok).toBe(true);
      if (ledger.ok) expect(ledger.state.entries["agents/a.md"]?.bundleId).toBe("keryx-project-original-owner");
    });

    test("an identical entry whose ledger record already belongs to THIS bundle is refreshed (re-import is a no-op ownership-wise)", async () => {
      const bytes = Buffer.from("owned by this bundle already");
      const targetPath = path.join(projectRoot, ".metaproject", "agents", "a.md");
      writeFileSync(targetPath, bytes);
      const ledgerPath = appliedStatePath("project", { projectRoot, homeDir, env: {} });
      await writeAppliedState(ledgerPath, {
        schemaVersion: 2,
        entries: { "agents/a.md": { bundleId: "keryx-project-x", sha256: sha256Hex(bytes), kind: "agent", appliedAt: "2026-01-01T00:00:00.000Z", path: "agents/a.md" } },
      });
      const entry = planEntry({ bucket: "identical", bytes, incomingSha256: sha256Hex(bytes), currentSha256: sha256Hex(bytes) });
      const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };

      const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {}, now: () => new Date("2026-09-24T00:00:00.000Z") });
      expect(result.refusals).toEqual([]);
      const ledger = await readAppliedState(ledgerPath);
      expect(ledger.ok).toBe(true);
      if (ledger.ok) {
        expect(ledger.state.entries["agents/a.md"]?.bundleId).toBe("keryx-project-x");
        expect(ledger.state.entries["agents/a.md"]?.appliedAt).toBe("2026-09-24T00:00:00.000Z");
      }
    });
  });

  // R1-F29: an unreadable/corrupt ledger must refuse (named `corrupt-ledger`)
  // rather than being silently treated as empty — pre-fix, `ledgerFor`
  // substituted `{ schemaVersion: 1, entries: {} }` for a read failure, so
  // `writeAppliedState` would have overwritten every OTHER bundle's records
  // with only this apply's own entries.
  test("R1-F29: a corrupt ledger refuses apply with reason corrupt-ledger, and writes nothing", async () => {
    const ledgerPath = appliedStatePath("project", { projectRoot, homeDir, env: {} });
    mkdirSync(path.dirname(ledgerPath), { recursive: true });
    writeFileSync(ledgerPath, "{ not valid json");
    const entry = planEntry();
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };

    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.reason).toBe("corrupt-ledger");
    // The file write itself must be rolled back too — apply is all-or-nothing.
    expect(existsSync(entry.targetPath)).toBe(false);
  });

  // R1-F21: a refusal must mean zero bytes written ANYWHERE, including a
  // freshly-created private-dir `.gitignore` and the directories `mkdir -p`
  // created along the way — pre-fix, `ensurePrivateDirGitignore` ran before
  // the TOCTOU re-check (so it survived a refusal there) and was never
  // rolled back on a later failure either.
  test("R1-F21: a later write failure rolls back a .gitignore this apply created, and refuses by name", async () => {
    const memoryRoot = path.join(homeDir, ".keryx", "memory");
    const goodMemoryEntry = planEntry({
      path: "memory/lessons/a.md",
      kind: "memory-entry",
      targetScope: "user",
      targetRelative: "memory/lessons/a.md",
      displayId: "user:memory/lessons/a.md",
      targetPath: path.join(memoryRoot, "lessons", "a.md"),
      bytes: Buffer.from("lesson"),
      incomingSha256: sha256Hex(Buffer.from("lesson")),
    });
    // A target whose parent is a FILE, forcing the second write to fail.
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
    const plan: BundlePlan = { ok: true, bundleId: "keryx-project-x", refusals: [], entries: [goodMemoryEntry, badEntry], projectRoot, bundleContentDigest: "digest" };

    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.refusals).toHaveLength(1);
    // R2-F20: reading `blockerPath/nested.md` (a path THROUGH a file) is a
    // real read error, not "does not exist" — refused by name
    // (`target-unreadable`) now, rather than falling through to the
    // generic `apply-failed` catch-all this test originally asserted.
    expect(result.refusals[0]?.reason).toBe("target-unreadable");
    expect(existsSync(goodMemoryEntry.targetPath)).toBe(false);
    // The .gitignore this very apply created must be rolled back too.
    expect(existsSync(path.join(memoryRoot, ".gitignore"))).toBe(false);
  });

  // Orchestrator coordination note (L4's `checkPrivateDirGitignore`/
  // `ensurePrivateDirGitignore(dir, root?)` root parameter): apply.ts now
  // passes the user store root, so a symlink ANYWHERE between it and
  // `memory/` that escapes the store is refused too, not only a symlinked
  // `memory/` itself. Here `~/.keryx/memory` is itself a symlink pointing
  // outside `~/.keryx` — refused, and nothing is written.
  test("user-scope memory-entry import refuses when memory/'s parent chain contains a symlink escaping the store root", async () => {
    const storeRoot = path.join(homeDir, ".keryx");
    mkdirSync(storeRoot, { recursive: true });
    const outside = path.join(root, "outside-memory");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(storeRoot, "memory"));

    const entry = planEntry({
      path: "memory/lessons/a.md",
      kind: "memory-entry",
      targetScope: "user",
      targetRelative: "memory/lessons/a.md",
      displayId: "user:memory/lessons/a.md",
      targetPath: path.join(outside, "lessons", "a.md"),
      bytes: Buffer.from("lesson"),
      incomingSha256: sha256Hex(Buffer.from("lesson")),
    });
    const plan: BundlePlan = { ok: true, bundleId: "keryx-user-x", refusals: [], entries: [entry], projectRoot, bundleContentDigest: "digest" };

    const result = await applyBundlePlan(plan, OK_AUDIT, { homeDir, env: {} });
    expect(result.written).toEqual([]);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.reason).toBe("private-gitignore-conflict");
    expect(existsSync(path.join(outside, "lessons", "a.md"))).toBe(false);
    expect(existsSync(path.join(outside, ".gitignore"))).toBe(false);
  });
});
