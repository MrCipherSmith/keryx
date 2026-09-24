import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcceptCapability } from "./accept-capability";
import { LearningPathError, userLearningDir, userPatternsDir } from "./paths";
import { LearningStoreError, listPatterns, readIndex, readPattern, writeIndex, writePattern } from "./store";
import type { IndexEntry, LearnedPattern } from "./types";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = "2026-09-24T00:00:00.000Z";

function makeRecord(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
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
        observedAt: NOW,
        weight: 1,
      },
    ],
    reviewerProfile: null,
    redaction: { scanned: true, findings: [] },
    graduation: null,
    provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
    ttl: { expiresAt: "2026-10-24T00:00:00.000Z" },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-store-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function withUserHome<T>(fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-home-"));
  const env = { KERYX_HOME: dir };
  return fn(env).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("writePattern / readPattern round trip", () => {
  test("project scope", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord();
      await writePattern(root, record);
      const read = await readPattern(root, record.id, "project");
      expect(read).toEqual(record);
    });
  });

  test("user scope, under KERYX_HOME", async () => {
    await withUserHome(async (env) => {
      await withProjectRoot(async (root) => {
        const record = makeRecord({
          scope: "user",
          project: { identity: SHA_B, identityKind: "remote-hash" },
        });
        await writePattern(root, record, { env });
        const read = await readPattern(root, record.id, "user", { env });
        expect(read).toEqual(record);
        // Confirm the write actually landed under KERYX_HOME, not the real home.
        expect(userPatternsDir(env)).toContain(env.KERYX_HOME as string);
      });
    });
  });

  test("readPattern returns undefined for a missing record", async () => {
    await withProjectRoot(async (root) => {
      expect(await readPattern(root, "testing.missing-00000000", "project")).toBeUndefined();
    });
  });
});

describe("writePattern refusals", () => {
  test("refuses an invalid record with reason learning-record-invalid", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ trigger: "short" });
      await expect(writePattern(root, record)).rejects.toMatchObject({
        reason: "learning-record-invalid",
      });
    });
  });

  test("refuses status:accepted without the accept capability", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
      delete (record as { ttl?: unknown }).ttl;
      let error: unknown;
      try {
        await writePattern(root, record);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(LearningStoreError);
      expect((error as LearningStoreError).reason).toBe("learning-accept-capability-required");
    });
  });

  test("accepts status:accepted with the accept capability", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
      delete (record as { ttl?: unknown }).ttl;
      await writePattern(root, record, { capability: createAcceptCapability() });
      const read = await readPattern(root, record.id, "project");
      expect(read?.status).toBe("accepted");
    });
  });

  test("refuses a candidate -> accepted transition without the capability even when another id is already accepted", async () => {
    await withProjectRoot(async (root) => {
      const alreadyAccepted = makeRecord({
        id: "testing.already-accepted-11111111",
        status: "accepted",
        confidence: 0.61,
        confidenceLevel: "medium",
      });
      delete (alreadyAccepted as { ttl?: unknown }).ttl;
      await writePattern(root, alreadyAccepted, { capability: createAcceptCapability() });

      const stillCandidate = makeRecord({ id: "testing.still-candidate-22222222", status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
      delete (stillCandidate as { ttl?: unknown }).ttl;
      await expect(writePattern(root, stillCandidate)).rejects.toMatchObject({
        reason: "learning-accept-capability-required",
      });
    });
  });

  test("allows a write with status:accepted without the capability when the stored record for the same scope+id is already accepted (non-transition, e.g. extract's reinforcement/decay pass)", async () => {
    await withProjectRoot(async (root) => {
      const accepted = makeRecord({ id: "testing.reinforced-33333333", status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, accepted, { capability: createAcceptCapability() });

      const reinforced = {
        ...accepted,
        confidence: 0.7465,
        confidenceLevel: "medium" as const,
        evidence: [
          ...accepted.evidence,
          {
            kind: "reinforcement" as const,
            sourceType: "observation" as const,
            sourceRef: ".metaproject/data/learning/observations/2026-09-25.jsonl#L1",
            observedAt: "2026-09-25T00:00:00.000Z",
            weight: 1,
          },
        ],
        updatedAt: "2026-09-25T00:00:00.000Z",
      };
      // No capability passed — this must succeed because it is not a status transition.
      await writePattern(root, reinforced);
      const read = await readPattern(root, accepted.id, "project");
      expect(read?.status).toBe("accepted");
      expect(read?.evidence.length).toBe(2);
    });
  });

  test("path-traversal id is refused before any write", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "../../etc/passwd" });
      await expect(writePattern(root, record)).rejects.toBeInstanceOf(LearningPathError);
    });
  });
});

describe("listPatterns", () => {
  test("filters by status and domain across project scope", async () => {
    await withProjectRoot(async (root) => {
      const candidate = makeRecord({ id: "testing.a-11111111" });
      const accepted = makeRecord({
        id: "code-style.b-22222222",
        domain: "code-style",
        status: "accepted",
        confidence: 0.61,
        confidenceLevel: "medium",
      });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, candidate);
      await writePattern(root, accepted, { capability: createAcceptCapability() });

      const all = await listPatterns(root, {}, {});
      expect(all.map((r) => r.id).sort()).toEqual([accepted.id, candidate.id].sort());

      const onlyAccepted = await listPatterns(root, { status: "accepted" });
      expect(onlyAccepted.map((r) => r.id)).toEqual([accepted.id]);

      const onlyCodeStyle = await listPatterns(root, { domain: "code-style" });
      expect(onlyCodeStyle.map((r) => r.id)).toEqual([accepted.id]);
    });
  });

  test("empty store returns an empty list, not an error", async () => {
    await withProjectRoot(async (root) => {
      expect(await listPatterns(root)).toEqual([]);
    });
  });
});

describe("index", () => {
  test("round trip write/read", async () => {
    await withUserHome(async (env) => {
      const entry: IndexEntry = {
        projectIdentity: SHA_A,
        identityKind: "remote-hash",
        confidence: 0.82,
        acceptedAt: NOW,
      };
      await writeIndex({ "testing.foo-ab12cd34": [entry] }, { env });
      const read = await readIndex({ env });
      expect(read).toEqual({ "testing.foo-ab12cd34": [entry] });
    });
  });

  test("empty/missing index reads as {}", async () => {
    await withUserHome(async (env) => {
      expect(await readIndex({ env })).toEqual({});
    });
  });

  test("refuses an index entry missing a required field", async () => {
    await withUserHome(async (env) => {
      const malformed = { projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.8 } as unknown as IndexEntry;
      await expect(writeIndex({ "some-id": [malformed] }, { env })).rejects.toMatchObject({
        reason: "learning-index-invalid",
      });
    });
  });

  test("refuses an index entry with an extra field", async () => {
    await withUserHome(async (env) => {
      const malformed = {
        projectIdentity: SHA_A,
        identityKind: "remote-hash",
        confidence: 0.8,
        acceptedAt: NOW,
        extra: "nope",
      } as unknown as IndexEntry;
      await expect(writeIndex({ "some-id": [malformed] }, { env })).rejects.toMatchObject({
        reason: "learning-index-invalid",
      });
    });
  });

  test("writeIndex stays inside the user learning root", async () => {
    await withUserHome(async (env) => {
      await writeIndex({}, { env });
      expect(userLearningDir(env)).toContain(env.KERYX_HOME as string);
    });
  });
});
