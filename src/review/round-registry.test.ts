// Flow 520 T14: the round registry's own guarantees — a desk-partial record never vouches for a finished round (B4),
// and an append racing a compaction is never lost (B3).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { packageFacts } from "./round-record";
import {
  appendRoundRegistry,
  partialRoundVouch,
  readRoundRegistry,
  recordPartialRound,
  REGISTRY_COMPACT_BYTES,
  registryVouches,
  registryVouchesPackage,
  repoIdentity,
  roundRegistryFile,
  type RoundRegistryEntry,
} from "./round-registry";
import { isolateGitDiscovery } from "./test-git-fixture";
import { withFileLock } from "../lib/file-lock";

const HEAD = "a".repeat(40);
let root: string;
let dataDir: string;
let restoreGit: () => void;

beforeEach(() => {
  restoreGit = isolateGitDiscovery();
  root = mkdtempSync(path.join(tmpdir(), "keryx-round-registry-repo-"));
  dataDir = mkdtempSync(path.join(tmpdir(), "keryx-round-registry-data-"));
  for (const args of [["init", "-q"], ["remote", "add", "origin", "https://github.com/acme/app.git"]]) {
    expect(Bun.spawnSync(["git", "-c", "init.templateDir=", ...args], { cwd: root }).exitCode).toBe(0);
  }
});

afterEach(() => {
  restoreGit();
  rmSync(root, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

function draftPackage(): string {
  const dir = path.join(root, ".metaproject/reviews/partial");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, reviewId: "partial", mode: "review-flow", status: "draft",
    target: { kind: "pr", ref: "https://github.com/acme/app/pull/7", head: HEAD }, createdAt: "2026-11-24T00:00:00.000Z" }));
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify([{ id: "F-1", reviewer: "review-logic", severity: "major", problem: "p" }]));
  return dir;
}

test("T14 B4: a desk-partial record vouches only as a partial round, never through the finished-round API", () => {
  const dir = draftPackage();
  expect(recordPartialRound(dir, { cwd: root, dir: dataDir }).error).toBeUndefined();
  const entries = readRoundRegistry(repoIdentity(root), dataDir);
  const hashes = packageFacts(dir)!.hashes;
  expect(entries).toEqual([expect.objectContaining({ packageId: "partial", event: "desk-partial" })]);
  expect(partialRoundVouch(entries, "partial", hashes)).toBeDefined();
  expect(registryVouches(entries, "partial", hashes)).toBeUndefined();
  expect(registryVouchesPackage(dir, { cwd: root, dir: dataDir })).toBe(false);
  // The same files recorded as a finished round do vouch.
  expect(registryVouches(entries.map((entry) => ({ ...entry, event: "complete" as const })), "partial", hashes)).toBeDefined();
});

const entry = (packageId: string, at: string): RoundRegistryEntry => ({ v: 2, packageId, targetKey: "pr:acme/app#7", reviewedHead: HEAD,
  manifestSha256: "b".repeat(64), findingsSha256: null, completedAt: at, event: "complete" });

test("T14 B3: an append from another process while a compaction runs waits for it and survives it", async () => {
  const identity = "remote:race";
  const file = roundRegistryFile(identity, dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(entry("old", "x".repeat(300)))}\n`;
  writeFileSync(file, line.repeat(Math.ceil(REGISTRY_COMPACT_BYTES / line.length) + 10));
  const started = path.join(root, "started");
  const script = path.join(root, "append.ts");
  writeFileSync(script, [
    `import { writeFileSync } from "node:fs";`,
    `import { appendRoundRegistry } from ${JSON.stringify(path.join(import.meta.dir, "round-registry.ts"))};`,
    `writeFileSync(${JSON.stringify(started)}, "started");`,
    `appendRoundRegistry(${JSON.stringify(identity)}, ${JSON.stringify(entry("concurrent", "now"))}, ${JSON.stringify(dataDir)});`,
  ].join("\n"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let heldDuringCompaction: boolean | undefined;
  const written = appendRoundRegistry(identity, entry("compactor", "now"), dataDir, {
    beforeCompactionWrite() {
      // Between the compaction's read and its rename nobody else may take the registry lock: an append landing here
      // would be dropped by the rename. A non-waiting acquire must fail.
      heldDuringCompaction = withFileLock(`${file}.lock`, () => true, { timeoutMs: 0 }) === null;
      // Another writer starts here; it must queue behind the lock. Wait until it is running (a state, not a time window).
      child = Bun.spawn([process.execPath, script], { cwd: root, stdout: "ignore", stderr: "inherit" });
      const limit = Date.now() + 20_000;
      while (!existsSync(started)) {
        if (Date.now() > limit) throw new Error("the concurrent writer never started");
        Bun.sleepSync(5);
      }
    },
  });
  expect(heldDuringCompaction).toBe(true);
  expect(written.compacted).toBeGreaterThan(500);
  expect(child).toBeDefined();
  expect(await child!.exited).toBe(0);
  expect(readRoundRegistry(identity, dataDir).map((item) => item.packageId)).toEqual(["old", "compactor", "concurrent"]);
  expect(existsSync(`${file}.lock`)).toBe(false);
}, 30_000);

test("T16: a registry lock another process holds is reported, not waited out silently or bypassed", () => {
  const identity = "remote:held";
  const file = roundRegistryFile(identity, dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.lock`, "live-holder");
  expect(() => appendRoundRegistry(identity, entry("blocked", "now"), dataDir, { lockTimeoutMs: 50 }))
    .toThrow(`the local round registry ${file} is locked by another keryx process; the entry was not recorded`);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(`${file}.lock`, "utf8")).toBe("live-holder");
});
