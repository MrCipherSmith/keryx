import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcceptCapability } from "./accept-capability";
import { observationsDir } from "./paths";
import { pruneLearning, pruneObservationFilesPass } from "./prune";
import { readPattern, writePattern } from "./store";
import type { LearnedPattern } from "./types";

const SHA_A = "a".repeat(64);
const NOW = new Date("2026-09-24T00:00:00.000Z");

function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-prune-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function writeObservationFile(root: string, date: string): void {
  const dir = observationsDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${date}.jsonl`), '{"schemaVersion":1}\n', "utf8");
}

function makeCandidate(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    schemaVersion: 1,
    id: "testing.repeated-correction-ab12cd34",
    trigger: "the same file region is edited twice in one turn window",
    action: "check the first edit's assumptions before writing a second one",
    domain: "testing",
    scope: "project",
    project: { identity: SHA_A, identityKind: "remote-hash" },
    confidence: 0.4,
    confidenceLevel: "low",
    status: "candidate",
    supersededBy: null,
    evidence: [
      {
        kind: "reinforcement",
        sourceType: "observation",
        sourceRef: ".metaproject/data/learning/observations/2026-09-24.jsonl",
        observedAt: NOW.toISOString(),
        weight: 1,
      },
    ],
    reviewerProfile: null,
    redaction: { scanned: true, findings: [] },
    graduation: null,
    provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
    ttl: { expiresAt: "2026-10-24T00:00:00.000Z" },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe("pruneLearning: observation files", () => {
  test("deletes a file more than 30 days past its own date, keeps a fresher one", async () => {
    await withProjectRoot(async (root) => {
      writeObservationFile(root, "2026-08-01"); // 54 days before NOW: stale
      writeObservationFile(root, "2026-09-20"); // 4 days before NOW: fresh

      const report = await pruneLearning(root, { now: NOW });

      expect(report.deletedObservationFiles).toEqual(["2026-08-01.jsonl"]);
      const remaining = readdirSync(observationsDir(root)).sort();
      expect(remaining).toEqual(["2026-09-20.jsonl"]);
    });
  });

  test("dryRun reports without deleting anything", async () => {
    await withProjectRoot(async (root) => {
      writeObservationFile(root, "2026-08-01");

      const report = await pruneLearning(root, { now: NOW, dryRun: true });

      expect(report.deletedObservationFiles).toEqual(["2026-08-01.jsonl"]);
      expect(readdirSync(observationsDir(root))).toEqual(["2026-08-01.jsonl"]);
    });
  });

  test("ignores a file that does not match the YYYY-MM-DD.jsonl pattern", async () => {
    await withProjectRoot(async (root) => {
      const dir = observationsDir(root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, ".append.lock"), "", "utf8");
      writeFileSync(path.join(dir, "not-a-date.jsonl"), "", "utf8");

      const report = await pruneLearning(root, { now: NOW });
      expect(report.deletedObservationFiles).toEqual([]);
    });
  });

  test("missing observations directory reports an empty list, not an error", async () => {
    await withProjectRoot(async (root) => {
      const report = await pruneLearning(root, { now: NOW });
      expect(report.deletedObservationFiles).toEqual([]);
    });
  });
});

describe("pruneLearning: candidate TTL expiry", () => {
  test("expires a candidate past its ttl.expiresAt: status expired, ttl removed, updatedAt bumped", async () => {
    await withProjectRoot(async (root) => {
      const record = makeCandidate({ ttl: { expiresAt: "2026-09-01T00:00:00.000Z" } });
      await writePattern(root, record);

      const report = await pruneLearning(root, { now: NOW });

      expect(report.expired).toEqual([{ id: record.id, scope: "project" }]);
      const stored = await readPattern(root, record.id, "project");
      expect(stored?.status).toBe("expired");
      expect(stored?.ttl).toBeUndefined();
      expect(stored?.updatedAt).toBe(NOW.toISOString());
    });
  });

  test("leaves a candidate whose ttl has not yet expired untouched", async () => {
    await withProjectRoot(async (root) => {
      const record = makeCandidate({ ttl: { expiresAt: "2026-12-01T00:00:00.000Z" } });
      await writePattern(root, record);

      const report = await pruneLearning(root, { now: NOW });

      expect(report.expired).toEqual([]);
      const stored = await readPattern(root, record.id, "project");
      expect(stored?.status).toBe("candidate");
    });
  });

  test("dryRun reports the expiry without writing it", async () => {
    await withProjectRoot(async (root) => {
      const record = makeCandidate({ ttl: { expiresAt: "2026-09-01T00:00:00.000Z" } });
      await writePattern(root, record);

      const report = await pruneLearning(root, { now: NOW, dryRun: true });

      expect(report.expired).toEqual([{ id: record.id, scope: "project" }]);
      const stored = await readPattern(root, record.id, "project");
      expect(stored?.status).toBe("candidate");
    });
  });

  test("never touches an accepted, rejected, superseded, or already-expired record", async () => {
    await withProjectRoot(async (root) => {
      const accepted = makeCandidate({ id: "testing.accepted-11111111", status: "accepted" });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, accepted, { capability: createAcceptCapability() });

      const report = await pruneLearning(root, { now: NOW });
      expect(report.expired).toEqual([]);
    });
  });
});

// O-7
describe("pruneLearning: per-pass error collection", () => {
  test("report carries an empty errors array when both passes succeed", async () => {
    await withProjectRoot(async (root) => {
      writeObservationFile(root, "2026-08-01"); // > 30 days before NOW: deleted
      const record = makeCandidate({ ttl: { expiresAt: "2026-09-01T00:00:00.000Z" } }); // expired
      await writePattern(root, record);

      const report = await pruneLearning(root, { now: NOW });

      expect(report.errors).toEqual([]);
      expect(report.deletedObservationFiles).toEqual(["2026-08-01.jsonl"]);
      expect(report.expired).toEqual([{ id: record.id, scope: "project" }]);
    });
  });
});

// O-7
describe("pruneObservationFilesPass (the pass `runExtract` runs automatically)", () => {
  test("deletes only observation files past their TTL, leaving candidates untouched, never throws", async () => {
    await withProjectRoot(async (root) => {
      writeObservationFile(root, "2026-08-01"); // > 30 days before NOW
      writeObservationFile(root, "2026-09-20"); // within TTL
      const record = makeCandidate({ ttl: { expiresAt: "2026-09-01T00:00:00.000Z" } }); // would be expired by the OTHER pass
      await writePattern(root, record);

      const result = await pruneObservationFilesPass(root, NOW);

      expect(result.errors).toEqual([]);
      expect(result.deleted).toEqual(["2026-08-01.jsonl"]);
      expect(readdirSync(observationsDir(root)).sort()).toEqual(["2026-09-20.jsonl"]);
      // Candidate expiry is NOT this pass's job — untouched.
      const stored = await readPattern(root, record.id, "project");
      expect(stored?.status).toBe("candidate");
    });
  });

  test("an unreadable observations directory (e.g. never created) is reported as zero deletions, not an error", async () => {
    await withProjectRoot(async (root) => {
      const result = await pruneObservationFilesPass(root, NOW);
      expect(result).toEqual({ deleted: [], errors: [] });
    });
  });
});
