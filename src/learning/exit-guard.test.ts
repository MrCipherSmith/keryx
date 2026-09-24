// Wave-3 exit guard (AC11): proves zero learned patterns can reach
// `status: "accepted"` without a recorded human accept action.
//
//  1. `store.writePattern` refuses an `accepted` write without the accept
//     capability over every existing-record shape, in both scopes, and
//     allows the one documented non-transition exception (already-accepted
//     -> already-accepted, e.g. reinforcement/decay/graduation touching an
//     already-accepted record).
//  2. Every non-accept producer (extract, prune, promote, graduate, apply,
//     reviewer-profile apply, the observe sink) is run over real fixtures and
//     never yields a `status: "accepted"` record that was not produced by
//     `acceptPattern` itself.
//  3. Every `acceptPattern` success appends exactly one `accept` decision;
//     `auditAcceptedRecords` is clean after normal use and flags a
//     hand-crafted (tampered / imported) accepted record with no matching
//     decision; `keryx learn list` surfaces that flag as a warning.
//  4. `acceptPattern` with `isTerminal: false` refuses before touching disk:
//     no record change, no decision, no index write.
//  5. A source audit: the only place under `src/` that assigns the literal
//     status `"accepted"` to a learned-pattern-shaped record is
//     `src/learning/accept.ts`; every other match is either a read filter
//     (`listPatterns({ status: "accepted" })`), a comment, or an explicitly
//     allowlisted, provably-unrelated domain (memory/wiki/other modules that
//     happen to share the word "accepted" for their own status enums).
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { acceptPattern } from "./accept";
import { createAcceptCapability } from "./accept-capability";
import { applyLearnedPattern } from "./apply";
import { auditAcceptedRecords, readDecisions } from "./decisions";
import { runExtract } from "./extract";
import { runGraduate } from "./graduate";
import { createLearningObservationSink } from "./observe";
import {
  decisionsLogPath,
  projectPatternPath,
  userDecisionsLogPath,
  userIndexPath,
  userPatternPath,
} from "./paths";
import { promotePattern } from "./promote";
import { pruneLearning } from "./prune";
import { applyReviewerProfile } from "./reviewer-profile";
import { listPatterns, readPattern, writeIndex, writePattern } from "./store";
import type { LearnedPattern, LearningIndex } from "./types";
import { learnCommand } from "../commands/learn";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = new Date("2026-09-24T00:00:00.000Z");

function storeEnvFor(homeDir: string): NodeJS.ProcessEnv {
  return { KERYX_HOME: homeDir };
}

async function withProject<T>(fn: (root: string, home: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-learning-exit-guard-root-"));
  const home = await mkdtemp(path.join(tmpdir(), "keryx-learning-exit-guard-home-"));
  const env = storeEnvFor(home);
  try {
    return await fn(root, home, env);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

function makeRecord(overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    schemaVersion: 1,
    id: "testing.exit-guard-fixture-ab12cd34",
    trigger: "the exit guard fixture trigger text for this record",
    action: "the exit guard fixture action text for this record",
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

function withoutTtl(record: LearnedPattern): LearnedPattern {
  const { ttl, ...rest } = record;
  void ttl;
  return rest;
}

// ---------------------------------------------------------------------------
// 1. store.writePattern refuses "accepted" without the capability
// ---------------------------------------------------------------------------

describe("store.writePattern: accept-capability guard (AC11)", () => {
  for (const scope of ["project", "user"] as const) {
    const identity = scope === "project" ? SHA_A : SHA_B;

    test(`${scope} scope: refuses over no existing record`, async () => {
      await withProject(async (root, _home, env) => {
        const record = makeRecord({ scope, project: { identity, identityKind: "remote-hash" }, status: "accepted" });
        await expect(writePattern(root, withoutTtl(record), { env })).rejects.toMatchObject({
          reason: "learning-accept-capability-required",
        });
        expect(await readPattern(root, record.id, scope, { env })).toBeUndefined();
      });
    });

    test(`${scope} scope: refuses over an existing candidate record`, async () => {
      await withProject(async (root, _home, env) => {
        const candidate = makeRecord({ scope, project: { identity, identityKind: "remote-hash" } });
        await writePattern(root, candidate, { env });
        const accepted = makeRecord({ scope, project: { identity, identityKind: "remote-hash" }, status: "accepted" });
        await expect(writePattern(root, withoutTtl(accepted), { env })).rejects.toMatchObject({
          reason: "learning-accept-capability-required",
        });
        const stored = await readPattern(root, candidate.id, scope, { env });
        expect(stored?.status).toBe("candidate");
      });
    });

    for (const priorStatus of ["rejected", "expired"] as const) {
      test(`${scope} scope: refuses over an existing ${priorStatus} record`, async () => {
        await withProject(async (root, _home, env) => {
          const prior = withoutTtl(makeRecord({ scope, project: { identity, identityKind: "remote-hash" }, status: priorStatus }));
          await writePattern(root, prior, { env });
          const accepted = makeRecord({ scope, project: { identity, identityKind: "remote-hash" }, status: "accepted" });
          await expect(writePattern(root, withoutTtl(accepted), { env })).rejects.toMatchObject({
            reason: "learning-accept-capability-required",
          });
          const stored = await readPattern(root, prior.id, scope, { env });
          expect(stored?.status).toBe(priorStatus);
        });
      });
    }

    test(`${scope} scope: allows a non-transition write over an existing accepted record, status stays accepted`, async () => {
      await withProject(async (root, _home, env) => {
        const accepted = withoutTtl(makeRecord({ scope, project: { identity, identityKind: "remote-hash" }, status: "accepted" }));
        await writePattern(root, accepted, { env, capability: createAcceptCapability() });

        // Reinforcement/decay/graduation touch an already-accepted record
        // without holding the capability — this must be allowed because it
        // is not a candidate -> accepted transition.
        const reinforced: LearnedPattern = { ...accepted, updatedAt: "2026-09-25T00:00:00.000Z" };
        await writePattern(root, reinforced, { env });

        const stored = await readPattern(root, accepted.id, scope, { env });
        expect(stored?.status).toBe("accepted");
        expect(stored?.updatedAt).toBe("2026-09-25T00:00:00.000Z");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 2. Every non-accept producer never yields "accepted"
// ---------------------------------------------------------------------------

function observationsFile(root: string): string {
  return path.join(root, ".metaproject", "data", "learning", "observations", "2026-09-24.jsonl");
}

async function appendObservationLine(root: string, event: Record<string, unknown>): Promise<void> {
  const file = observationsFile(root);
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
}

async function seedFailingToPassingTest(root: string): Promise<void> {
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "tool-failed",
    tool: "Bash",
    inputDigest: "d".repeat(64),
    inputPreview: "bun test src/foo.test.ts",
    outputPreview: "1 fail",
    sessionId: "sess-fail-pass",
    toolUseId: "tu-fp-1",
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:00:00.000Z",
  });
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Bash",
    inputDigest: "d".repeat(64),
    inputPreview: "bun test src/foo.test.ts",
    outputPreview: "0 fail 3 pass",
    sessionId: "sess-fail-pass",
    toolUseId: "tu-fp-2",
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:05:00.000Z",
  });
}

async function seedRevertedEdit(root: string): Promise<void> {
  const pathDigest = "1".repeat(64);
  const digestOriginal = "2".repeat(64);
  const digestEdited = "3".repeat(64);
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Edit",
    inputDigest: "e".repeat(64),
    inputPreview: '{"file_path":"/repo/src/revert-me.ts"}',
    outputPreview: null,
    sessionId: "sess-revert",
    toolUseId: "tu-rv-1",
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:00:00.000Z",
    edit: { pathDigest, removedDigest: digestOriginal, addedDigest: digestEdited },
  });
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Edit",
    inputDigest: "e".repeat(64),
    inputPreview: '{"file_path":"/repo/src/revert-me.ts"}',
    outputPreview: null,
    sessionId: "sess-revert",
    toolUseId: "tu-rv-2",
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:01:00.000Z",
    edit: { pathDigest, removedDigest: digestEdited, addedDigest: digestOriginal },
  });
}

async function seedRepeatedCorrection(root: string): Promise<void> {
  const pathDigest = "4".repeat(64);
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Edit",
    inputDigest: "f".repeat(64),
    inputPreview: '{"file_path":"/repo/src/correct-me.ts"}',
    outputPreview: null,
    sessionId: "sess-correct",
    toolUseId: "tu-cr-1",
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:00:00.000Z",
    edit: { pathDigest, removedDigest: "5".repeat(64), addedDigest: "6".repeat(64) },
  });
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "turn-stop",
    tool: null,
    inputDigest: "0".repeat(64),
    inputPreview: "",
    outputPreview: null,
    sessionId: "sess-correct",
    toolUseId: null,
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:00:30.000Z",
  });
  await appendObservationLine(root, {
    schemaVersion: 1,
    event: "tool-complete",
    tool: "Edit",
    inputDigest: "f".repeat(64),
    inputPreview: '{"file_path":"/repo/src/correct-me.ts"}',
    outputPreview: null,
    sessionId: "sess-correct",
    toolUseId: "tu-cr-2",
    cwdHash: "c".repeat(64),
    project: { identity: SHA_A, identityKind: "remote-hash" },
    observedAt: "2026-09-24T00:01:00.000Z",
    // Removes what the first edit added (6), but does NOT restore what it
    // removed (5) — a correction, not a plain revert.
    edit: { pathDigest, removedDigest: "6".repeat(64), addedDigest: "7".repeat(64) },
  });
}

const REVIEWER_LOGIN = "octo-reviewer";

async function seedReviewerComment(root: string): Promise<void> {
  const metaDir = path.join(root, ".metaproject");
  await mkdir(metaDir, { recursive: true });
  await writeFile(
    path.join(metaDir, "review-learning.config.json"),
    JSON.stringify({ schemaVersion: 1, skill: "module/skill", repo: "acme/widgets", authors: [REVIEWER_LOGIN], reviewerProfiles: [REVIEWER_LOGIN] }, null, 2),
    "utf8",
  );
  const prDir = path.join(metaDir, "reviews", "pr-comments");
  await mkdir(prDir, { recursive: true });
  await writeFile(
    path.join(prDir, "acme__widgets__42.json"),
    JSON.stringify(
      {
        schemaVersion: 1,
        repo: "acme/widgets",
        number: 42,
        self: null,
        rounds_collected: 1,
        collected_sha: "deadbeef",
        collected_round: 1,
        replies_posted_at: null,
        seen: [
          {
            id: "c1",
            thread_id: null,
            author: REVIEWER_LOGIN,
            url: "https://github.com/acme/widgets/pull/42#c1",
            first_seen_round: 1,
            last_seen_round: 1,
            submitted_at: "2026-09-20T00:00:00.000Z",
            body: `@${REVIEWER_LOGIN}: please add a null check before dereferencing the pointer here.`,
          },
        ],
        handled_comments: [],
        backlog: [],
        escalated: [],
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function seedHealthRegression(root: string): Promise<void> {
  const dir = path.join(root, ".metaproject", "data", "health", "history");
  await mkdir(dir, { recursive: true });
  const finding = {
    message: "Missing test coverage for the payment module",
    suggestedAction: "Add unit tests covering the refund path",
    scope: { skill: "module/payments" },
  };
  await writeFile(
    path.join(dir, "2026-09-01T00-00-00-000Z.json"),
    JSON.stringify({ schemaVersion: 3, generatedAt: "2026-09-01T00:00:00.000Z", findings: [finding] }, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(dir, "2026-09-08T00-00-00-000Z.json"),
    JSON.stringify({ schemaVersion: 3, generatedAt: "2026-09-08T00:00:00.000Z", findings: [finding] }, null, 2),
    "utf8",
  );
}

async function seedSkillRegistry(root: string, moduleName: string, skillName: string): Promise<void> {
  const skillRoot = path.join(root, ".metaproject", "project-skills", moduleName, skillName);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    path.join(skillRoot, "SKILL.md"),
    [`# ${moduleName} ${skillName}`, "", "Version: 0.1.0", `Module: ${moduleName}`, `Target: src/${moduleName}`, "", "## Review Lessons", "", "- No review lessons recorded yet.", ""].join("\n"),
    "utf8",
  );
  await writeFile(path.join(skillRoot, "skill-changelog.md"), "# Changelog\n", "utf8");
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify(
      {
        modules: {
          gdskills: {
            projectSkillRegistry: [
              { module: moduleName, name: skillName, target: `src/${moduleName}`, path: `.metaproject/project-skills/${moduleName}/${skillName}` },
            ],
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
}

describe("exit guard: no non-accept producer ever yields status:accepted (AC11)", () => {
  test("extract / prune / promote / graduate / apply / reviewer-profile / observe pipeline", async () => {
    await withProject(async (root, _home, env) => {
      // Fixtures for all 5 deterministic extraction signals.
      await seedFailingToPassingTest(root);
      await seedRevertedEdit(root);
      await seedRepeatedCorrection(root);
      await seedReviewerComment(root);
      await seedHealthRegression(root);

      const extractReport = await runExtract(root, { now: NOW, env });
      expect(extractReport.signals["failing-to-passing-test"]).toBeGreaterThanOrEqual(1);
      expect(extractReport.signals["reverted-edit"]).toBeGreaterThanOrEqual(1);
      expect(extractReport.signals["repeated-correction"]).toBeGreaterThanOrEqual(1);
      expect(extractReport.signals["reviewer-comment"]).toBeGreaterThanOrEqual(1);
      expect(extractReport.signals["health-regression"]).toBeGreaterThanOrEqual(1);
      expect(extractReport.created.length).toBeGreaterThanOrEqual(5);

      const afterExtract = await listPatterns(root, {}, { env });
      expect(afterExtract.every((record) => record.status === "candidate")).toBe(true);

      // Maintenance pass: prune must never mint "accepted" (it only expires).
      const pruneReport = await pruneLearning(root, { now: NOW, env });
      expect(pruneReport.errors).toEqual([]);
      const afterPrune = await listPatterns(root, {}, { env });
      expect(afterPrune.some((record) => record.status === "accepted")).toBe(false);

      // The ONLY records ever allowed to be "accepted" in this test are the
      // ones we accept ourselves, right here, through acceptPattern.
      const legitimatelyAccepted = new Set<string>();

      const testingCandidate = afterPrune.find((record) => record.domain === "testing" && record.scope === "project");
      expect(testingCandidate).toBeDefined();
      await acceptPattern(root, testingCandidate!.id, { isTerminal: true, env, now: () => NOW });
      legitimatelyAccepted.add(`project:${testingCandidate!.id}`);

      const reviewCandidate = afterPrune.find((record) => record.domain === "review-conventions" && record.scope === "project");
      expect(reviewCandidate).toBeDefined();
      await acceptPattern(root, reviewCandidate!.id, { isTerminal: true, env, now: () => NOW });
      legitimatelyAccepted.add(`project:${reviewCandidate!.id}`);

      // Cross-project index, seeded directly (simulating other projects'
      // accepts) so promotePattern has >=2 distinct identities at >=0.8 —
      // promote reads this, it never writes "accepted" itself.
      const seededIndex: LearningIndex = {
        [testingCandidate!.id]: [
          { projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.85, acceptedAt: NOW.toISOString() },
          { projectIdentity: SHA_B, identityKind: "remote-hash", confidence: 0.9, acceptedAt: NOW.toISOString() },
        ],
      };
      await writeIndex(seededIndex, { env });

      const promoteResult = await promotePattern(root, testingCandidate!.id, { isTerminal: true, confirm: async () => true, env, now: NOW });
      expect(promoteResult.status).toBe("candidate");
      expect(promoteResult.scope).toBe("user");
      const promoted = await readPattern(root, testingCandidate!.id, "user", { env });
      expect(promoted?.status).toBe("candidate");

      // Graduate: clusters the accepted records; must never write "accepted"
      // itself (it only sets `graduation` on already-accepted members, which
      // store.ts's non-transition exception allows without a capability).
      const graduateReport = await runGraduate(root, { env, now: NOW });
      expect(graduateReport.refused).toEqual([]);
      const afterGraduate = await listPatterns(root, { status: "accepted" }, { env });
      expect(afterGraduate.every((record) => legitimatelyAccepted.has(`${record.scope}:${record.id}`))).toBe(true);

      // Apply: renders the accepted testing-domain record into a project
      // skill proposal; must never touch the learning store's status field.
      await seedSkillRegistry(root, "exitguard", "widget");
      const applyResult = await applyLearnedPattern(root, testingCandidate!.id, { skill: "exitguard/widget", dryRun: true, env });
      expect(applyResult.applied).toBeDefined();
      const afterApply = await readPattern(root, testingCandidate!.id, "project", { env });
      expect(afterApply?.status).toBe("accepted"); // unchanged, not re-minted

      // Reviewer-profile apply: renders the accepted review-conventions
      // record; must never touch the learning store at all.
      const reviewerId = reviewCandidate!.reviewerProfile?.reviewerId;
      expect(reviewerId ?? "").toMatch(/^rv-[0-9a-f]{16}$/);
      const profileResult = await applyReviewerProfile(root, reviewerId!, { dryRun: true, env });
      expect(profileResult.path).toContain(reviewerId!);
      const afterProfile = await readPattern(root, reviewCandidate!.id, "project", { env });
      expect(afterProfile?.status).toBe("accepted"); // unchanged

      // Observe sink: appends an observation line; never touches any record.
      const sink = createLearningObservationSink(root, { env, now: () => NOW.toISOString() });
      await sink.record({
        kind: "tool-complete",
        sessionId: "sess-observe",
        runId: "run-observe",
        timestamp: NOW.toISOString(),
        payload: { toolName: "Bash", toolInput: { command: "echo hi" }, toolOutput: { stdout: "ok" } },
      });

      // Final sweep: every accepted record anywhere is one we minted via
      // acceptPattern, and the exit-guard audit is clean.
      const finalAccepted = await listPatterns(root, { status: "accepted" }, { env });
      for (const record of finalAccepted) {
        expect(legitimatelyAccepted.has(`${record.scope}:${record.id}`)).toBe(true);
      }
      const flagged = await auditAcceptedRecords(root, { env });
      expect(flagged).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Decision log + tamper detection + `keryx learn list` surfacing
// ---------------------------------------------------------------------------

describe("exit guard: decision log discipline (AC11)", () => {
  test("acceptPattern appends exactly one accept decision; auditAcceptedRecords is clean", async () => {
    await withProject(async (root, _home, env) => {
      const record = makeRecord();
      await writePattern(root, record, { env });

      await acceptPattern(root, record.id, { isTerminal: true, actor: "aleks.zeitler@gmail.com", env, now: () => NOW });

      const decisions = await readDecisions(root, "project", { env });
      expect(decisions).toEqual([
        { schemaVersion: 1, action: "accept", id: record.id, scope: "project", actor: "aleks.zeitler@gmail.com", tty: true, at: NOW.toISOString() },
      ]);

      expect(await auditAcceptedRecords(root, { env })).toEqual([]);
    });
  });

  test("a hand-crafted accepted record with no matching decision is flagged", async () => {
    await withProject(async (root, _home, env) => {
      // Bypasses the store entirely — simulates tampering, a restored
      // backup, or an import that skipped `keryx learn accept`.
      const tampered = withoutTtl(makeRecord({ id: "testing.tampered-record-deadbeef", status: "accepted" }));
      const target = projectPatternPath(root, tampered.id);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      const flagged = await auditAcceptedRecords(root, { env });
      expect(flagged).toEqual([{ id: tampered.id, scope: "project" }]);
    });
  });

  test("a hand-crafted accepted USER-scope record with no matching decision is flagged", async () => {
    await withProject(async (root, _home, env) => {
      const tampered = withoutTtl(makeRecord({ id: "testing.tampered-user-deadbeef", scope: "user", project: { identity: SHA_B, identityKind: "remote-hash" }, status: "accepted" }));
      const target = userPatternPath(tampered.id, env);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      const flagged = await auditAcceptedRecords(root, { env });
      expect(flagged).toEqual([{ id: tampered.id, scope: "user" }]);
    });
  });

  test("`keryx learn list` surfaces the integrity warning for a tampered accepted record", async () => {
    await withProject(async (root, home, env) => {
      const tampered = withoutTtl(makeRecord({ id: "testing.tampered-cli-deadbeef", status: "accepted" }));
      const target = projectPatternPath(root, tampered.id);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

      const errors: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]): void => {
        errors.push(args.map((a) => String(a)).join(" "));
      };
      const originalLog = console.log;
      console.log = (): void => {};
      try {
        await learnCommand(["list"], { cwd: root, env, homeDir: home });
      } finally {
        console.error = originalError;
        console.log = originalLog;
      }

      expect(errors.some((line) => line.includes("WARNING") && line.includes(tampered.id) && line.includes("integrity check"))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. acceptPattern without isTerminal writes nothing
// ---------------------------------------------------------------------------

describe("exit guard: acceptPattern isTerminal:false writes nothing (AC11)", () => {
  test("no record change, no decision, no index write", async () => {
    await withProject(async (root, _home, env) => {
      const record = makeRecord();
      await writePattern(root, record, { env });
      const before = await readFile(projectPatternPath(root, record.id), "utf8");

      await expect(acceptPattern(root, record.id, { isTerminal: false, env, now: () => NOW })).rejects.toMatchObject({
        reason: "accept-requires-terminal",
      });

      const after = await readFile(projectPatternPath(root, record.id), "utf8");
      expect(after).toBe(before);

      const stored = await readPattern(root, record.id, "project", { env });
      expect(stored?.status).toBe("candidate");

      await expect(readFile(decisionsLogPath(root), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(userIndexPath(env), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(userDecisionsLogPath(env), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Source audit: only accept.ts assigns status "accepted"
// ---------------------------------------------------------------------------

const SRC_ROOT = path.join(__dirname, "..");

function isTestFile(relativePath: string): boolean {
  return /\.(test|smoke|bench)\.tsx?$/.test(relativePath);
}

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Requires "status" to look like an object key (preceded by `{` or `,`, with
// optional whitespace) rather than free narrative text (e.g. an error
// message that happens to mention `status:"accepted"` in prose) or a bare
// string comparison.
const STATUS_ACCEPTED_ASSIGNMENT_PATTERN = /[{,]\s*status\s*:\s*["']accepted["']|\.status\s*=\s*["']accepted["']/;

/**
 * Files outside `src/learning/accept.ts` that legitimately contain a
 * `status: "accepted"`-shaped object-literal match for a reason OTHER than
 * "this writes a learned-pattern record" — each entry names the exact file
 * and why it is safe, per AC11's "allowlist any other occurrences ... by
 * exact file path with a comment" instruction. A file NOT on this list, and
 * not `accept.ts`, failing the scan means a new writer bypassed the accept
 * capability gate.
 */
const ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    "src/wiki/evidence.ts",
    "WikiEvidence.status is an unrelated domain enum (\"accepted\" | \"draft\" | \"conflict\" | ...) for wiki evidence records, not a learned-pattern.",
  ],
  [
    "src/commands/agent-approval-context.ts",
    "memorySearch({ status: \"accepted\", ... }) is a read filter against the memory module's own status enum, not a learned-pattern write.",
  ],
]);

/** A read-only filter argument to a store lookup, not a write — `listPatterns(root, { status: "accepted" }, ...)`/`readPattern`. */
function isReadFilterLine(line: string): boolean {
  return line.includes("listPatterns(") || line.includes("readPattern(");
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/**");
}

describe("source audit: only accept.ts assigns status:\"accepted\" to a learned pattern (AC11)", () => {
  test("no other non-test file under src/ assigns the literal accepted status", () => {
    const files = collectSourceFiles(SRC_ROOT);
    const offenders: { file: string; lines: number[] }[] = [];

    for (const file of files) {
      const relative = path.relative(path.join(SRC_ROOT, ".."), file).split(path.sep).join("/");
      if (relative === "src/learning/accept.ts") continue;
      if (isTestFile(relative)) continue;

      const content = readFileSync(file, "utf8");
      const matchedLines: number[] = [];
      content.split("\n").forEach((line, index) => {
        if (isCommentLine(line)) return;
        if (isReadFilterLine(line)) return;
        if (STATUS_ACCEPTED_ASSIGNMENT_PATTERN.test(line)) matchedLines.push(index + 1);
      });
      if (matchedLines.length === 0) continue;
      if (ALLOWLIST.has(relative)) continue;
      offenders.push({ file: relative, lines: matchedLines });
    }

    expect(offenders).toEqual([]);
  });

  test("fails on a synthetic new offending file under src/learning/ (self-check the audit actually catches something)", () => {
    // Proves the scan logic itself is not vacuously passing: a hand-built
    // in-memory line list, run through the same predicates the real test
    // above uses, must be caught for a plausible new bypass site.
    const offendingLine = '  const updated: LearnedPattern = { ...record, status: "accepted", updatedAt: now };';
    expect(isCommentLine(offendingLine)).toBe(false);
    expect(isReadFilterLine(offendingLine)).toBe(false);
    expect(STATUS_ACCEPTED_ASSIGNMENT_PATTERN.test(offendingLine)).toBe(true);
  });

  test("does not flag a listPatterns read filter", () => {
    const filterLine = '    const accepted = await listPatterns(root, { status: "accepted" }, storeOptions);';
    expect(isReadFilterLine(filterLine)).toBe(true);
  });

  test("does not flag a comment mentioning the transition", () => {
    const commentLine = '// Never produces `status: "accepted"` — that remains `keryx learn accept`\'s';
    expect(isCommentLine(commentLine)).toBe(true);
  });
});

describe("source audit: accept-capability import discipline (AC11, referenced not duplicated)", () => {
  // `src/learning/accept-capability.test.ts` already runs the full
  // repo-wide import-specifier scan asserting that only `store.ts`,
  // `accept.ts` and test files import `accept-capability.ts` — see its
  // `describe("accept-capability import discipline")` block. Re-implementing
  // that scan here would duplicate coverage rather than add any; this test
  // only confirms that coverage still exists (the file and its guard test
  // are present) so a Wave-3 exit-guard reader can find it.
  test("accept-capability.test.ts still carries the import-discipline audit", () => {
    const content = readFileSync(path.join(SRC_ROOT, "learning", "accept-capability.test.ts"), "utf8");
    expect(content).toContain('describe("accept-capability import discipline"');
    expect(content).toContain("only store.ts, accept.ts, and test files import accept-capability");
  });
});
