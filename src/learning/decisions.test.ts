import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendDecision, auditAcceptedRecords, readDecisions } from "./decisions";
import { createAcceptCapability } from "./accept-capability";
import { writePattern } from "./store";
import type { LearnedPattern } from "./types";

const SHA_A = "a".repeat(64);
const NOW = "2026-09-24T00:00:00.000Z";

function makeAccepted(id: string): LearnedPattern {
  return {
    schemaVersion: 1,
    id,
    trigger: "the same file region is edited twice in one turn window",
    action: "check the first edit's assumptions before writing a second one",
    domain: "testing",
    scope: "project",
    project: { identity: SHA_A, identityKind: "remote-hash" },
    confidence: 0.61,
    confidenceLevel: "medium",
    status: "accepted",
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
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function withProjectRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-decisions-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("appendDecision / readDecisions", () => {
  test("appends one JSON line with the documented shape", async () => {
    await withProjectRoot(async (root) => {
      await appendDecision(
        root,
        { action: "accept", id: "testing.foo-ab12cd34", actor: "aleks", tty: true, at: NOW },
        { scope: "project" },
      );
      const decisions = await readDecisions(root, "project");
      expect(decisions).toEqual([
        {
          schemaVersion: 1,
          action: "accept",
          id: "testing.foo-ab12cd34",
          scope: "project",
          actor: "aleks",
          tty: true,
          at: NOW,
        },
      ]);
    });
  });

  test("appends accumulate across calls", async () => {
    await withProjectRoot(async (root) => {
      await appendDecision(root, { action: "accept", id: "a", actor: "x", tty: true }, { scope: "project" });
      await appendDecision(root, { action: "reject", id: "b", actor: "x", tty: true }, { scope: "project" });
      const decisions = await readDecisions(root, "project");
      expect(decisions.map((d) => d.action)).toEqual(["accept", "reject"]);
    });
  });

  test("project and user scopes are independent logs", async () => {
    await withProjectRoot(async (root) => {
      const dir = mkdtempSync(path.join(tmpdir(), "keryx-learning-decisions-home-"));
      const env = { KERYX_HOME: dir };
      try {
        await appendDecision(root, { action: "accept", id: "p", actor: "x", tty: true }, { scope: "project" });
        await appendDecision(root, { action: "promote", id: "u", actor: "x", tty: true }, { scope: "user", env });
        expect((await readDecisions(root, "project")).map((d) => d.id)).toEqual(["p"]);
        expect((await readDecisions(root, "user", { env })).map((d) => d.id)).toEqual(["u"]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("auditAcceptedRecords", () => {
  test("flags an accepted record with no matching accept decision", async () => {
    await withProjectRoot(async (root) => {
      const record = makeAccepted("testing.undocumented-accept-ab12cd34");
      await writePattern(root, record, { capability: createAcceptCapability() });
      const flagged = await auditAcceptedRecords(root);
      expect(flagged).toEqual([{ id: record.id, scope: "project" }]);
    });
  });

  test("does not flag an accepted record with a matching accept decision", async () => {
    await withProjectRoot(async (root) => {
      const record = makeAccepted("testing.documented-accept-ab12cd34");
      await writePattern(root, record, { capability: createAcceptCapability() });
      await appendDecision(
        root,
        { action: "accept", id: record.id, actor: "aleks", tty: true },
        { scope: "project" },
      );
      const flagged = await auditAcceptedRecords(root);
      expect(flagged).toEqual([]);
    });
  });

  test("a candidate record (never accepted) is never flagged", async () => {
    await withProjectRoot(async (root) => {
      const record: LearnedPattern = {
        ...makeAccepted("testing.still-candidate-ab12cd34"),
        status: "candidate",
        confidence: 0.4,
        confidenceLevel: "low",
        ttl: { expiresAt: "2026-10-24T00:00:00.000Z" },
      };
      await writePattern(root, record);
      expect(await auditAcceptedRecords(root)).toEqual([]);
    });
  });
});
