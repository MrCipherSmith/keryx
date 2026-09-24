import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAcceptCapability } from "./accept-capability";
import { readDecisions } from "./decisions";
import { LearningPromoteError, promotePattern } from "./promote";
import { readIndex, readPattern, writeIndex, writePattern } from "./store";
import type { IndexEntry, LearnedPattern } from "./types";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const NOW = new Date("2026-09-24T00:00:00.000Z");

function makeAccepted(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    schemaVersion: 1,
    id: "testing.repeated-correction-ab12cd34",
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
        observedAt: NOW.toISOString(),
        weight: 1,
      },
    ],
    reviewerProfile: null,
    redaction: { scanned: true, findings: [] },
    graduation: null,
    provenance: { extractor: "repeated-correction", extractorKind: "deterministic" },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function indexEntry(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return { projectIdentity: SHA_B, identityKind: "remote-hash", confidence: 0.9, acceptedAt: "2026-01-01T00:00:00.000Z", ...overrides };
}

function withTempHome<T>(fn: (root: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = mkdtempSync(path.join(tmpdir(), "keryx-learning-promote-root-"));
  const home = mkdtempSync(path.join(tmpdir(), "keryx-learning-promote-home-"));
  const env = { KERYX_HOME: home };
  return fn(root, env).finally(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
}

async function writeAccepted(root: string, record: LearnedPattern, env: NodeJS.ProcessEnv): Promise<void> {
  await writePattern(root, record, { env, capability: createAcceptCapability() });
}

function neverConfirm(): () => Promise<boolean> {
  return async () => false;
}
function alwaysConfirm(): () => Promise<boolean> {
  return async () => true;
}

describe("promotePattern: non-TTY refusal", () => {
  test("refuses promote-requires-terminal before reading or writing anything", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      // Deliberately no index entries at all — if the refusal read the
      // index or the record first, that would still be fine functionally,
      // but the check must fire before any write; confirm no user-scope
      // directory tree exists afterward.
      await expect(
        promotePattern(root, record.id, { isTerminal: false, confirm: alwaysConfirm(), env }),
      ).rejects.toMatchObject({ reason: "promote-requires-terminal" });

      const home = env.KERYX_HOME as string;
      expect(() => readdirSync(path.join(home, ".keryx"))).toThrow();
    });
  });
});

describe("promotePattern: insufficient-project-identities", () => {
  test("refuses with a named reason when only 1 distinct identity is indexed at >= 0.8, even interactively", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      await writeIndex({ [record.id]: [indexEntry({ projectIdentity: SHA_A, confidence: 0.85 })] }, { env });

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "insufficient-project-identities" });
    });
  });

  test("message names the count and the >= 2 requirement", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      await writeIndex({ [record.id]: [] }, { env });

      try {
        await promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW });
        throw new Error("expected promotePattern to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(LearningPromoteError);
        expect((error as LearningPromoteError).message).toContain("only 0 distinct project identity at confidence >= 0.8");
        expect((error as LearningPromoteError).message).toContain("promotion requires >= 2");
      }
    });
  });
});

describe("promotePattern: uses indexed accept-time confidence, never the live record's", () => {
  test("succeeds when the live record's confidence is low but two indexed identities are >= 0.8", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted({ confidence: 0.5, confidenceLevel: "medium" });
      await writeAccepted(root, record, env);
      await writeIndex(
        {
          [record.id]: [
            indexEntry({ projectIdentity: SHA_A, confidence: 0.8 }),
            indexEntry({ projectIdentity: SHA_B, confidence: 0.9 }),
          ],
        },
        { env },
      );

      const result = await promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW });
      expect(result).toEqual({ id: record.id, scope: "user", status: "candidate" });
    });
  });

  test("refuses when the live record's confidence is high but only one indexed identity is >= 0.8", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted({ confidence: 0.95, confidenceLevel: "high" });
      await writeAccepted(root, record, env);
      await writeIndex(
        {
          [record.id]: [
            indexEntry({ projectIdentity: SHA_A, confidence: 0.9 }),
            indexEntry({ projectIdentity: SHA_B, confidence: 0.7 }),
          ],
        },
        { env },
      );

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "insufficient-project-identities" });
    });
  });
});

describe("promotePattern: successful promotion", () => {
  test("writes scope:user status:candidate with a fresh ttl, and appends a promote decision", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      await writeIndex(
        {
          [record.id]: [
            indexEntry({ projectIdentity: SHA_A, confidence: 0.8 }),
            indexEntry({ projectIdentity: SHA_B, confidence: 0.9 }),
          ],
        },
        { env },
      );

      const result = await promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW });
      expect(result).toEqual({ id: record.id, scope: "user", status: "candidate" });

      const promoted = await readPattern(root, record.id, "user", { env });
      expect(promoted).toBeDefined();
      expect(promoted?.scope).toBe("user");
      expect(promoted?.status).toBe("candidate");
      expect(promoted?.ttl?.expiresAt).toBe(new Date(NOW.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString());
      expect(promoted?.trigger).toBe(record.trigger);
      expect(promoted?.evidence).toEqual(record.evidence);

      // The source project record is untouched.
      const projectStill = await readPattern(root, record.id, "project", { env });
      expect(projectStill?.status).toBe("accepted");

      const decisions = await readDecisions(root, "project", { env });
      expect(decisions).toContainEqual(
        expect.objectContaining({ action: "promote", id: record.id, scope: "project", tty: true }),
      );
    });
  });
});

describe("promotePattern: cancelled confirmation", () => {
  test("writes nothing when confirm() resolves false", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      await writeIndex(
        {
          [record.id]: [
            indexEntry({ projectIdentity: SHA_A, confidence: 0.8 }),
            indexEntry({ projectIdentity: SHA_B, confidence: 0.9 }),
          ],
        },
        { env },
      );

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: neverConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "promote-cancelled" });

      const promoted = await readPattern(root, record.id, "user", { env });
      expect(promoted).toBeUndefined();
      const decisions = await readDecisions(root, "project", { env });
      expect(decisions.some((d) => d.action === "promote")).toBe(false);
    });
  });
});

describe("promotePattern: already-promoted refusal", () => {
  test("refuses when a scope:user candidate for this id already exists", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      await writeIndex(
        {
          [record.id]: [
            indexEntry({ projectIdentity: SHA_A, confidence: 0.8 }),
            indexEntry({ projectIdentity: SHA_B, confidence: 0.9 }),
          ],
        },
        { env },
      );

      const existingUser: LearnedPattern = {
        ...record,
        scope: "user",
        status: "candidate",
        ttl: { expiresAt: "2026-10-24T00:00:00.000Z" },
      };
      await writePattern(root, existingUser, { env });

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "already-promoted" });
    });
  });
});

describe("promotePattern: not accepted refusal", () => {
  test("refuses a project record that is not status:accepted", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted({ status: "candidate", ttl: { expiresAt: "2026-10-24T00:00:00.000Z" } });
      await writePattern(root, record, { env });

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "learning-not-accepted" });
    });
  });
});

describe("promotePattern + accept --refresh combined (W3-AC5 second fixture)", () => {
  test("accept, then a stale --refresh only touches the current project's entry, then promote reads the refreshed value", async () => {
    await withTempHome(async (root, env) => {
      // A second, already-indexed identity at a passing confidence.
      const record = makeAccepted({ confidence: 0.5, confidenceLevel: "medium" });
      await writeAccepted(root, record, env);
      await writeIndex(
        {
          [record.id]: [
            indexEntry({ projectIdentity: SHA_A, confidence: 0.4 }), // stale/low: this project's own OLD entry
            indexEntry({ projectIdentity: SHA_B, confidence: 0.9 }),
            indexEntry({ projectIdentity: SHA_C, confidence: 0.3 }), // a third identity, never touched
          ],
        },
        { env },
      );

      // Bring the current project's live confidence up, then refresh only its own entry.
      const reinforced: LearnedPattern = { ...record, confidence: 0.82, confidenceLevel: "high" };
      await writeAccepted(root, reinforced, env);

      const { acceptPattern } = await import("./accept");
      await acceptPattern(root, record.id, { isTerminal: true, refresh: true, env, now: () => NOW });

      const afterRefresh = await readIndex({ env });
      const entries = afterRefresh[record.id] as IndexEntry[];
      expect(entries.find((e) => e.projectIdentity === SHA_A)?.confidence).toBe(0.82);
      expect(entries.find((e) => e.projectIdentity === SHA_B)?.confidence).toBe(0.9);
      expect(entries.find((e) => e.projectIdentity === SHA_C)?.confidence).toBe(0.3);

      const result = await promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW });
      expect(result.status).toBe("candidate");
    });
  });
});

// R8-F2 (review round 8, PR #691, minor, probe r12/s.ts S4): only
// `scanLearnedText` ran before `promotePattern` copied a record into
// `~/.keryx/learning/patterns/` — a login-carrying `review-conventions` (or
// model-backed) record was promoted into the cross-project user store with
// no attribution check at all. Proven pre-fix (scratch copy of HEAD, before
// this task's edit, via `bun run r691/r13/s-prefix.ts`): a `model-summarizer`
// / `model-backed` record whose `action` was `"@alice prefers early
// returns"` and a `reviewer-comment` record with the same text were both
// promoted verbatim, login and all — `PROMOTED; user-scope action: "@alice
// prefers early returns"` for both. `promotePattern` now runs the same
// `gateReviewerText` gate `apply.ts`/`applyGraduation`/extract's upsert use.
describe("promotePattern: attribution refusal (R8-F2)", () => {
  function twoIdentityIndex(id: string) {
    return {
      [id]: [indexEntry({ projectIdentity: SHA_A, confidence: 0.8 }), indexEntry({ projectIdentity: SHA_B, confidence: 0.9 })],
    };
  }

  test("refuses to promote a model-backed record whose action carries a configured reviewer login", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted({
        id: "code-style.p-aaaaaaaa",
        trigger: "When writing a function in this project",
        action: "@alice prefers early returns",
        provenance: { extractor: "model-summarizer", extractorKind: "model-backed" },
      });
      await writeAccepted(root, record, env);
      await writeIndex(twoIdentityIndex(record.id), { env });
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "learning-text-refused" });

      const promoted = await readPattern(root, record.id, "user", { env });
      expect(promoted).toBeUndefined();
    });
  });

  test("refuses to promote a reviewer-comment record whose action carries a configured reviewer login", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted({
        id: "review-conventions.p-bbbbbbbb",
        domain: "review-conventions",
        trigger: "When preparing a change for review in this project (prefer early returns)",
        action: "@alice prefers early returns",
        provenance: { extractor: "reviewer-comment", extractorKind: "deterministic" },
      });
      await writeAccepted(root, record, env);
      await writeIndex(twoIdentityIndex(record.id), { env });
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["alice"] }),
      );

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "learning-text-refused" });

      const promoted = await readPattern(root, record.id, "user", { env });
      expect(promoted).toBeUndefined();
    });
  });

  test("refuses with review-learning-config-invalid when the config is malformed", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted();
      await writeAccepted(root, record, env);
      await writeIndex(twoIdentityIndex(record.id), { env });
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(path.join(root, ".metaproject", "review-learning.config.json"), JSON.stringify({ schemaVersion: 99 }));

      await expect(
        promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW }),
      ).rejects.toMatchObject({ reason: "review-learning-config-invalid" });
    });
  });

  // R6-F4-equivalent for promote: a non-reviewer-comment, non-model-backed
  // record's text naming a configured login by coincidence is not gated —
  // `gateReviewerText` scopes by `mayCarryReviewerText`, same as every other
  // sink.
  test("promotes cleanly when a non-attribution-scoped record's action names a configured login by coincidence", async () => {
    await withTempHome(async (root, env) => {
      const record = makeAccepted({ action: "octocat said to check the first edit's assumptions before writing a second one" });
      await writeAccepted(root, record, env);
      await writeIndex(twoIdentityIndex(record.id), { env });
      mkdirSync(path.join(root, ".metaproject"), { recursive: true });
      writeFileSync(
        path.join(root, ".metaproject", "review-learning.config.json"),
        JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: ["octocat"] }),
      );

      const result = await promotePattern(root, record.id, { isTerminal: true, confirm: alwaysConfirm(), env, now: NOW });
      expect(result.status).toBe("candidate");
    });
  });
});
