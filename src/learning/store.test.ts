import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createAcceptCapability } from "./accept-capability";
import { candidatesDir, LearningPathError, userLearningDir, userPatternsDir } from "./paths";
import {
  createPattern,
  LearningStoreError,
  listPatterns,
  readIndex,
  readPattern,
  updateIndex,
  updatePattern,
  writeIndex,
  writePattern,
} from "./store";
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

  test("updateIndex: read-modify-write under one lock acquisition, never dropping a prior write", async () => {
    await withUserHome(async (env) => {
      const entryA: IndexEntry = { projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.82, acceptedAt: NOW };
      const entryB: IndexEntry = { projectIdentity: SHA_B, identityKind: "remote-hash", confidence: 0.9, acceptedAt: NOW };
      await updateIndex((index) => ({ ...index, "testing.foo-ab12cd34": [entryA] }), { env });
      await updateIndex((index) => ({ ...index, "testing.foo-ab12cd34": [...(index["testing.foo-ab12cd34"] ?? []), entryB] }), { env });
      const read = await readIndex({ env });
      expect(read["testing.foo-ab12cd34"]).toEqual([entryA, entryB]);
    });
  });
});

// ---------------------------------------------------------------------------
// R1-F1 / R1-F7 (review round 1, PR #691): readPattern/listPatterns must bind
// a stored file's own `id`/`scope` to the ones requested, and every writer
// besides this module's own `writePattern` must go through `updatePattern`/
// `createPattern` — the choke point that adds that identity check plus
// immutable-field and accepted-text protection under one lock acquisition.
// ---------------------------------------------------------------------------

describe("readPattern / listPatterns: stored identity must match the requested identity (R1-F1)", () => {
  test("readPattern refuses a file whose own id does not match the filename it was read from", async () => {
    await withProjectRoot(async (root) => {
      // p1.ts's P1b: a project-store file named `p2.json` whose CONTENT claims
      // a different id (`p2other`) — reproduces "accept p2 accepts whatever id
      // the file's content claims, not p2".
      const planted = makeRecord({ id: "testing.p2other-11111111" });
      mkdirSync(candidatesDir(root), { recursive: true });
      await writeFile(path.join(candidatesDir(root), "testing.p2-22222222.json"), `${JSON.stringify(planted, null, 2)}\n`);
      await expect(readPattern(root, "testing.p2-22222222", "project")).rejects.toMatchObject({
        reason: "learning-record-identity-mismatch",
      });
    });
  });

  test("readPattern refuses a file planted directly inside the project store whose content claims scope:user", async () => {
    await withProjectRoot(async (root) => {
      // p1.ts's P1a: a project-dir file whose body says scope:"user" — this is
      // exactly what would let `isStoredAsAccepted`'s "already accepted"
      // read (inside `writePattern`) believe a USER-scope record is accepted
      // because a PROJECT-store plant claims to be one.
      const planted = makeRecord({ id: "testing.p1-11111111", scope: "user" });
      mkdirSync(candidatesDir(root), { recursive: true });
      await writeFile(path.join(candidatesDir(root), "testing.p1-11111111.json"), `${JSON.stringify(planted, null, 2)}\n`);
      await expect(readPattern(root, "testing.p1-11111111", "project")).rejects.toMatchObject({
        reason: "learning-record-identity-mismatch",
      });
    });
  });

  test("listPatterns skips an identity-mismatched file rather than returning it under the filename's id/scope", async () => {
    await withProjectRoot(async (root) => {
      const good = makeRecord({ id: "testing.good-33333333" });
      await writePattern(root, good);
      const planted = makeRecord({ id: "testing.p2other-11111111" });
      await writeFile(path.join(candidatesDir(root), "testing.p2-22222222.json"), `${JSON.stringify(planted, null, 2)}\n`);

      const all = await listPatterns(root, {}, {});
      expect(all.map((r) => r.id)).toEqual([good.id]);
      // Never returned under the requested (filename) id/scope either.
      expect(all.some((r) => r.id === "testing.p2-22222222")).toBe(false);
    });
  });
});

describe("updatePattern (R1-F1/R1-F7 choke point)", () => {
  test("refuses learning-record-not-found when nothing is stored at id+scope", async () => {
    await withProjectRoot(async (root) => {
      await expect(updatePattern(root, "testing.missing-00000000", "project", (r) => r)).rejects.toMatchObject({
        reason: "learning-record-not-found",
      });
    });
  });

  test("applies a mutator's evidence/confidence change under one lock acquisition", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "testing.reinforce-44444444" });
      await writePattern(root, record);
      const updated = await updatePattern(root, record.id, "project", (current) => ({
        ...current,
        confidence: 0.75,
        confidenceLevel: "medium",
        updatedAt: "2026-09-25T00:00:00.000Z",
      }));
      expect(updated.confidence).toBe(0.75);
      const read = await readPattern(root, record.id, "project");
      expect(read?.confidence).toBe(0.75);
    });
  });

  test("refuses a mutator that changes id or scope (learning-record-identity-mismatch)", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "testing.stable-55555555" });
      await writePattern(root, record);
      await expect(
        updatePattern(root, record.id, "project", (current) => ({ ...current, scope: "user" })),
      ).rejects.toMatchObject({ reason: "learning-record-identity-mismatch" });
    });
  });

  test("refuses a mutator that changes project.identity or createdAt (learning-record-immutable-field-changed)", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "testing.stable-66666666" });
      await writePattern(root, record);
      await expect(
        updatePattern(root, record.id, "project", (current) => ({ ...current, project: { ...current.project, identity: SHA_B } })),
      ).rejects.toMatchObject({ reason: "learning-record-immutable-field-changed" });
      await expect(
        updatePattern(root, record.id, "project", (current) => ({ ...current, createdAt: "2000-01-01T00:00:00.000Z" })),
      ).rejects.toMatchObject({ reason: "learning-record-immutable-field-changed" });
    });
  });

  test("refuses a mutator that changes trigger/action on an already-accepted record (learning-accepted-text-immutable)", async () => {
    await withProjectRoot(async (root) => {
      const accepted = makeRecord({ id: "testing.accepted-77777777", status: "accepted", confidence: 0.61, confidenceLevel: "medium" });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, accepted, { capability: createAcceptCapability() });
      await expect(
        updatePattern(root, accepted.id, "project", (current) => ({ ...current, action: "a completely different action text here" })),
      ).rejects.toMatchObject({ reason: "learning-accepted-text-immutable" });
    });
  });

  test("does NOT require the accept capability for a candidate->candidate evidence update", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "testing.plain-88888888" });
      await writePattern(root, record);
      // No capability passed at all.
      await updatePattern(root, record.id, "project", (current) => ({ ...current, confidence: 0.5, confidenceLevel: "medium" }));
      const read = await readPattern(root, record.id, "project");
      expect(read?.confidence).toBe(0.5);
    });
  });
});

describe("createPattern (R1-F1/R1-F7 choke point)", () => {
  test("creates a brand-new record when nothing is stored at id+scope", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "testing.new-99999999" });
      await createPattern(root, record);
      const read = await readPattern(root, record.id, "project");
      expect(read).toEqual(record);
    });
  });

  test("refuses to overwrite an ACTIVE (candidate/accepted) record (learning-record-already-exists)", async () => {
    await withProjectRoot(async (root) => {
      const record = makeRecord({ id: "testing.active-10101010" });
      await writePattern(root, record);
      await expect(createPattern(root, makeRecord({ id: record.id, trigger: "a completely different trigger phrase" }))).rejects.toMatchObject({
        reason: "learning-record-already-exists",
      });
    });
  });

  // R2-F3: a terminal record is no longer replaceable by DEFAULT — the
  // caller must explicitly list which statuses it intends to replace.
  test("refuses to replace a TERMINAL (rejected) record when the caller passes no replaceableStatuses (the new default)", async () => {
    await withProjectRoot(async (root) => {
      const rejected = makeRecord({ id: "testing.rejected-11221122", status: "rejected" });
      delete (rejected as { ttl?: unknown }).ttl;
      await writePattern(root, rejected);
      const fresh = makeRecord({ id: rejected.id });
      await expect(createPattern(root, fresh)).rejects.toMatchObject({ reason: "learning-record-already-exists" });
      const read = await readPattern(root, rejected.id, "project");
      expect(read?.status).toBe("rejected"); // untouched
    });
  });

  test("replaces a TERMINAL (rejected/expired/superseded) record when the caller explicitly lists it as replaceable (e.g. promote.ts's own option)", async () => {
    await withProjectRoot(async (root) => {
      const rejected = makeRecord({ id: "testing.rejected-33443344", status: "rejected" });
      delete (rejected as { ttl?: unknown }).ttl;
      await writePattern(root, rejected);
      const fresh = makeRecord({ id: rejected.id });
      await createPattern(root, fresh, { replaceableStatuses: ["rejected", "expired", "superseded"] });
      const read = await readPattern(root, rejected.id, "project");
      expect(read?.status).toBe("candidate");
    });
  });

  // R2-F3: the discriminating case from the round-2 probe (s1.ts S1) — a
  // rejected record must never be resurfaced by a `createPattern` call that
  // uses extract's own options (no `replaceableStatuses` at all), even when
  // simulating the race extract's upsert closes (a pre-lock read that missed
  // the rejection, calling `createPattern` with the same options extract
  // does). This FAILS on the pre-R2-F3 code (which always replaced any
  // terminal status unconditionally).
  test("R2-F3 (R2-F2 probe s1.ts S1): createPattern with extract's own options never replaces a rejected record", async () => {
    await withProjectRoot(async (root) => {
      const rejected = makeRecord({ id: "testing.rejected-55665566", status: "rejected" });
      delete (rejected as { ttl?: unknown }).ttl;
      await writePattern(root, rejected);
      // extract.ts's `upsertDraft` calls `createPattern(root, record, storeOptions)`
      // with no `replaceableStatuses` — the same shape reproduced here.
      await expect(createPattern(root, makeRecord({ id: rejected.id }), {})).rejects.toMatchObject({
        reason: "learning-record-already-exists",
      });
      const read = await readPattern(root, rejected.id, "project");
      expect(read?.status).toBe("rejected");
    });
  });
});

describe("accepted record field whitelist (R2-F5)", () => {
  test("refuses to change domain on an ACCEPTED record without the accept capability", async () => {
    await withProjectRoot(async (root) => {
      const accepted = makeRecord({
        id: "testing.accepted-r2f5-01111111",
        status: "accepted",
        confidence: 0.61,
        confidenceLevel: "medium",
        domain: "testing",
      });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, accepted, { capability: createAcceptCapability() });

      // Try to change domain without the capability
      await expect(
        updatePattern(root, accepted.id, "project", (current) => ({ ...current, domain: "code-style" })),
      ).rejects.toMatchObject({ reason: "learning-accepted-field-immutable" });

      // Verify the record is unchanged
      const read = await readPattern(root, accepted.id, "project");
      expect(read?.domain).toBe("testing");
    });
  });

  test("refuses to change reviewerProfile on an ACCEPTED review-conventions record without the accept capability", async () => {
    await withProjectRoot(async (root) => {
      const accepted = makeRecord({
        id: "testing.accepted-r2f5-02222222",
        status: "accepted",
        confidence: 0.61,
        confidenceLevel: "medium",
        domain: "review-conventions",
        reviewerProfile: { reviewerId: "reviewer-abc123", generalizedFrom: 5 },
      });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, accepted, { capability: createAcceptCapability() });

      // Try to change reviewerId within reviewerProfile without the capability
      await expect(
        updatePattern(root, accepted.id, "project", (current) => ({
          ...current,
          reviewerProfile: { ...current.reviewerProfile, reviewerId: "reviewer-xyz789" },
        })),
      ).rejects.toMatchObject({ reason: "learning-accepted-field-immutable" });

      // Verify the record is unchanged
      const read = await readPattern(root, accepted.id, "project");
      expect(read?.reviewerProfile?.reviewerId).toBe("reviewer-abc123");
    });
  });

  test("allows mutating only confidence/confidenceLevel/evidence/updatedAt on an ACCEPTED record without the accept capability", async () => {
    await withProjectRoot(async (root) => {
      const accepted = makeRecord({
        id: "testing.accepted-r2f5-03333333",
        status: "accepted",
        confidence: 0.4,
        confidenceLevel: "low",
        domain: "testing",
      });
      delete (accepted as { ttl?: unknown }).ttl;
      await writePattern(root, accepted, { capability: createAcceptCapability() });

      // Update only mutable fields without the capability
      const updated = await updatePattern(root, accepted.id, "project", (current) => ({
        ...current,
        confidence: 0.75,
        confidenceLevel: "medium",
        evidence: [
          ...current.evidence,
          {
            kind: "reinforcement" as const,
            sourceType: "observation" as const,
            sourceRef: ".metaproject/data/learning/observations/2026-09-26.jsonl",
            observedAt: "2026-09-26T00:00:00.000Z",
            weight: 1,
          },
        ],
        updatedAt: "2026-09-26T00:00:00.000Z",
      }));

      expect(updated.confidence).toBe(0.75);
      expect(updated.confidenceLevel).toBe("medium");
      expect(updated.evidence.length).toBe(2);
      expect(updated.updatedAt).toBe("2026-09-26T00:00:00.000Z");

      // Verify it was persisted
      const read = await readPattern(root, accepted.id, "project");
      expect(read?.confidence).toBe(0.75);
      expect(read?.confidenceLevel).toBe("medium");
      expect(read?.evidence.length).toBe(2);
    });
  });
});
