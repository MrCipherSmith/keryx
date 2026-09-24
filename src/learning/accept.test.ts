import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acceptPattern, LearningAcceptError, rejectPattern } from "./accept";
import { createAcceptCapability } from "./accept-capability";
import { readDecisions } from "./decisions";
import { readIndex, readPattern, writeIndex, writePattern } from "./store";
import type { IndexEntry, LearnedPattern } from "./types";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = new Date("2026-09-24T00:00:00.000Z");

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

function withTempHome<T>(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-learning-accept-root-"));
  const home = mkdtempSync(path.join(tmpdir(), "keryx-learning-accept-home-"));
  const env = { KERYX_HOME: home };
  return fn(root, env).finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

describe("acceptPattern: non-TTY refusal", () => {
  test("refuses accept-requires-terminal with no isTerminal", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate();
      await writePattern(root, record);
      await expect(acceptPattern(root, record.id, { isTerminal: false, env })).rejects.toMatchObject({
        reason: "accept-requires-terminal",
      });
    });
  });

  test("refuses even with --refresh and no isTerminal", async () => {
    await withTempHome(async (root, env) => {
      await expect(acceptPattern(root, "testing.whatever-00000000", { isTerminal: false, refresh: true, env })).rejects.toMatchObject({
        reason: "accept-requires-terminal",
      });
    });
  });
});

describe("acceptPattern: not-a-candidate refusal", () => {
  test("refuses an already-rejected record", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate({ status: "rejected" });
      delete (record as { ttl?: unknown }).ttl;
      await writePattern(root, record, { env });
      await expect(acceptPattern(root, record.id, { isTerminal: true, env })).rejects.toMatchObject({
        reason: "learning-not-a-candidate",
      });
    });
  });

  test("refuses an unknown id", async () => {
    await withTempHome(async (root, env) => {
      await expect(acceptPattern(root, "testing.missing-00000000", { isTerminal: true, env })).rejects.toMatchObject({
        reason: "learning-record-not-found",
      });
    });
  });
});

describe("acceptPattern: project scope index writes (AC5)", () => {
  test("first accept adds exactly one array entry with exactly the four documented keys", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate();
      await writePattern(root, record);

      const result = await acceptPattern(root, record.id, { isTerminal: true, env, now: () => NOW });

      expect(result).toEqual({ id: record.id, scope: "project", status: "accepted", indexUpdated: true });
      const index = await readIndex({ env });
      expect(Object.keys(index)).toEqual([record.id]);
      expect(index[record.id]).toHaveLength(1);
      const entry = index[record.id]![0]!;
      expect(Object.keys(entry).sort()).toEqual(["acceptedAt", "confidence", "identityKind", "projectIdentity"]);
      expect(entry).toEqual({
        projectIdentity: SHA_A,
        identityKind: "remote-hash",
        confidence: record.confidence,
        acceptedAt: NOW.toISOString(),
      });

      const stored = await readPattern(root, record.id, "project", { env });
      expect(stored?.status).toBe("accepted");
      expect(stored?.ttl).toBeUndefined();
    });
  });

  test("accepting a second id adds a second top-level key, not overwriting the first", async () => {
    await withTempHome(async (root, env) => {
      const first = makeCandidate({ id: "testing.first-11111111" });
      const second = makeCandidate({ id: "testing.second-22222222" });
      await writePattern(root, first);
      await writePattern(root, second);

      await acceptPattern(root, first.id, { isTerminal: true, env, now: () => NOW });
      await acceptPattern(root, second.id, { isTerminal: true, env, now: () => NOW });

      const index = await readIndex({ env });
      expect(Object.keys(index).sort()).toEqual([first.id, second.id].sort());
      expect(index[first.id]).toHaveLength(1);
      expect(index[second.id]).toHaveLength(1);
    });
  });

  test("accepting a scope:user record changes only its status and writes no index entry", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate({ scope: "user", project: { identity: SHA_B, identityKind: "remote-hash" } });
      await writePattern(root, record, { env });

      const result = await acceptPattern(root, record.id, { isTerminal: true, scope: "user", env, now: () => NOW });

      expect(result).toEqual({ id: record.id, scope: "user", status: "accepted", indexUpdated: false });
      const index = await readIndex({ env });
      expect(index).toEqual({});
      const stored = await readPattern(root, record.id, "user", { env });
      expect(stored?.status).toBe("accepted");
    });
  });
});

describe("acceptPattern: --refresh", () => {
  test("overwrites only the current project's entry, leaving another identity's entry untouched", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate({ confidence: 0.61, confidenceLevel: "medium" });
      const otherIdentityEntry: IndexEntry = {
        projectIdentity: SHA_B,
        identityKind: "remote-hash",
        confidence: 0.9,
        acceptedAt: "2026-01-01T00:00:00.000Z",
      };
      await writePattern(root, record);
      await acceptPattern(root, record.id, { isTerminal: true, env, now: () => NOW });

      // Seed a second identity's entry for the same id, as if promoted from elsewhere.
      const before = await readIndex({ env });
      await writeIndex({ ...before, [record.id]: [...before[record.id]!, otherIdentityEntry] }, { env });

      // Reinforce the source record so its live confidence differs from the indexed snapshot.
      const reinforced: LearnedPattern = { ...(await readPattern(root, record.id, "project", { env }))!, confidence: 0.82, confidenceLevel: "high" };
      await writePattern(root, reinforced, { env, capability: createAcceptCapability() });

      const refreshAt = new Date("2026-09-25T00:00:00.000Z");
      const result = await acceptPattern(root, record.id, { isTerminal: true, refresh: true, env, now: () => refreshAt });
      expect(result.indexUpdated).toBe(true);

      const after = await readIndex({ env });
      const entries = after[record.id]!;
      expect(entries).toHaveLength(2);
      const currentEntry = entries.find((e) => e.projectIdentity === SHA_A)!;
      const untouchedEntry = entries.find((e) => e.projectIdentity === SHA_B)!;
      expect(currentEntry).toEqual({
        projectIdentity: SHA_A,
        identityKind: "remote-hash",
        confidence: 0.82,
        acceptedAt: refreshAt.toISOString(),
      });
      expect(untouchedEntry).toEqual(otherIdentityEntry);
    });
  });

  test("refuses learning-refresh-not-indexed when there is no entry for this identity", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate({ status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
      delete (record as { ttl?: unknown }).ttl;
      await writePattern(root, record, { env, capability: createAcceptCapability() });

      await expect(acceptPattern(root, record.id, { isTerminal: true, refresh: true, env })).rejects.toMatchObject({
        reason: "learning-refresh-not-indexed",
      });
    });
  });
});

describe("acceptPattern: decision log", () => {
  test("appends an accept decision", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate();
      await writePattern(root, record);
      await acceptPattern(root, record.id, { isTerminal: true, actor: "aleks", env, now: () => NOW });

      const decisions = await readDecisions(root, "project", { env });
      expect(decisions).toEqual([
        { schemaVersion: 1, action: "accept", id: record.id, scope: "project", actor: "aleks", tty: true, at: NOW.toISOString() },
      ]);
    });
  });
});

describe("rejectPattern", () => {
  test("candidate -> rejected, appends a reject decision", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate();
      await writePattern(root, record);

      const result = await rejectPattern(root, record.id, { actor: "aleks", env, now: () => NOW });
      expect(result).toEqual({ id: record.id, scope: "project", status: "rejected" });

      const stored = await readPattern(root, record.id, "project", { env });
      expect(stored?.status).toBe("rejected");
      expect(stored?.ttl).toBeUndefined();

      const decisions = await readDecisions(root, "project", { env });
      expect(decisions).toEqual([
        { schemaVersion: 1, action: "reject", id: record.id, scope: "project", actor: "aleks", tty: false, at: NOW.toISOString() },
      ]);
    });
  });

  test("refuses a non-candidate record", async () => {
    await withTempHome(async (root, env) => {
      const record = makeCandidate({ status: "rejected" });
      delete (record as { ttl?: unknown }).ttl;
      await writePattern(root, record, { env });
      await expect(rejectPattern(root, record.id, { env })).rejects.toBeInstanceOf(LearningAcceptError);
    });
  });
});
