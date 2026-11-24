// Flow 520 T14: the round registry's own guarantees — a desk-partial record never vouches for a finished round (B4),
// and an append racing a compaction is never lost (B3).
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("T14 B3: an append from another process while a compaction runs survives it", async () => {
  const identity = "remote:race";
  const file = roundRegistryFile(identity, dataDir);
  mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify(entry("old", "x".repeat(300)))}\n`;
  writeFileSync(file, line.repeat(Math.ceil(REGISTRY_COMPACT_BYTES / line.length) + 10));
  const marker = path.join(root, "appended");
  const script = path.join(root, "append.ts");
  writeFileSync(script, [
    `import { writeFileSync } from "node:fs";`,
    `import { appendRoundRegistry } from ${JSON.stringify(path.join(import.meta.dir, "round-registry.ts"))};`,
    `appendRoundRegistry(${JSON.stringify(identity)}, ${JSON.stringify(entry("concurrent", "now"))}, ${JSON.stringify(dataDir)});`,
    `writeFileSync(${JSON.stringify(marker)}, "done");`,
  ].join("\n"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const written = appendRoundRegistry(identity, entry("compactor", "now"), dataDir, {
    beforeCompactionWrite() {
      // Another writer starts between the compaction's read and its rename. Without the lock it appends at once, and the
      // rename would drop that line; with it, it waits. Either way give it a bounded window to land before the rename.
      child = Bun.spawn([process.execPath, script], { cwd: root, stdout: "ignore", stderr: "inherit" });
      const until = Date.now() + 2_000;
      while (!existsSync(marker) && Date.now() < until) Bun.sleepSync(20);
    },
  });
  expect(written.compacted).toBeGreaterThan(500);
  expect(child).toBeDefined();
  expect(await child!.exited).toBe(0);
  expect(readRoundRegistry(identity, dataDir).map((item) => item.packageId)).toEqual(["old", "compactor", "concurrent"]);
  expect(existsSync(`${file}.lock`)).toBe(false);
}, 30_000);
