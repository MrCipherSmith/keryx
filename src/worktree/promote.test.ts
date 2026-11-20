import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createAcceptCapability } from "../learning/accept-capability";
import { readPattern, writeIndex, writePattern } from "../learning/store";
import type { LearnedPattern } from "../learning/types";
import { createMemoryService } from "../memory/service";
import { memoryRootFor } from "../memory/store";
import { createWorktree, type CreateResult } from "./create";
import { createProjectFixture, everyPortFree, statusOf, type ProjectFixture } from "./project-fixture";
import { listUnpromoted, promoteWorktree } from "./promote";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = new Date("2026-11-21T00:00:00.000Z");

let project: ProjectFixture;
let wt: CreateResult;
let env: NodeJS.ProcessEnv;

function accepted(): LearnedPattern {
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
        sourceRef: ".metaproject/data/learning/observations/2026-11-21.jsonl",
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
  };
}

beforeEach(async () => {
  project = await createProjectFixture();
  env = { KERYX_HOME: project.userHome };
  wt = await createWorktree({
    cwd: project.main,
    name: "wt-promote",
    base: "main",
    path: path.join(project.base, "wt-promote"),
    runInstall: project.runInstall,
    isPortFree: everyPortFree,
  });
  // One new memory entry, one edit to the committed one, one accepted project learning entry.
  await createMemoryService().create({ cwd: wt.path, type: "lesson", slug: "found-in-worktree", title: "Found in the worktree" });
  appendFileSync(path.join(wt.path, ".metaproject", "memory", "lessons", "worktree-readiness-lesson.md"), "- edited in the worktree\n");
  await writePattern(wt.path, accepted(), { env, capability: createAcceptCapability() });
});
afterEach(() => project.cleanup());

const MEMORY_PATHS = [".metaproject/memory/lessons/found-in-worktree.md", ".metaproject/memory/lessons/worktree-readiness-lesson.md"];

describe("promote (AC5)", () => {
  test("--dry-run lists the uncommitted memory entries and the accepted learning entry, and writes nothing", async () => {
    const mainBefore = statusOf(project, project.main, true);
    const report = await promoteWorktree({ cwd: wt.path, dryRun: true, interactive: false, env, homeDir: project.userHome });

    expect(report.dryRun).toBe(true);
    expect(report.candidates.memory).toEqual([
      { path: MEMORY_PATHS[0] as string, state: "untracked" },
      { path: MEMORY_PATHS[1] as string, state: "modified" },
    ]);
    expect(report.candidates.learning).toEqual([{ id: accepted().id, domain: "testing" }]);
    expect(report.promoted).toEqual({ memory: [], learning: [] });
    expect(existsSync(memoryRootFor("user", wt.path, env))).toBe(false);
    expect(statusOf(project, project.main, true)).toBe(mainBefore);
  });

  test("promote copies memory into the user area under a lock, tagged with project and branch", async () => {
    const mainBefore = statusOf(project, project.main, true);
    const report = await promoteWorktree({
      cwd: wt.path,
      stores: ["memory"],
      interactive: true,
      env,
      now: () => NOW,
    });

    const userRoot = memoryRootFor("user", wt.path, env);
    expect(report.promoted.memory.map((item) => item.path)).toEqual(MEMORY_PATHS);
    expect(readdirSync(path.join(userRoot, "lessons")).sort()).toEqual(["found-in-worktree.md", "worktree-readiness-lesson.md"]);
    const copy = readFileSync(path.join(userRoot, "lessons", "found-in-worktree.md"), "utf8");
    expect(copy).toContain("# Found in the worktree");
    expect(copy).toContain(`- Promoted from project main, branch wt-promote on 2026-11-21.`);
    expect(existsSync(path.join(userRoot, ".promote.lock"))).toBe(false);

    // The source stays where it is; the main checkout is untouched.
    expect(existsSync(path.join(wt.path, MEMORY_PATHS[0] as string))).toBe(true);
    expect(statusOf(project, project.main, true)).toBe(mainBefore);
  });

  test("an entry the user area already holds with the same body is no longer listed as unpromoted", async () => {
    expect((await listUnpromoted(wt.path, { env })).memory.map((entry) => entry.path)).toEqual(MEMORY_PATHS);
    await promoteWorktree({ cwd: wt.path, stores: ["memory"], interactive: true, env, now: () => NOW });
    expect((await listUnpromoted(wt.path, { env })).memory).toEqual([]);
    const again = await promoteWorktree({ cwd: wt.path, stores: ["memory"], dryRun: true, interactive: false, env });
    expect(again.candidates.memory).toEqual([]);
  });

  test("an existing user entry is never overwritten", async () => {
    await promoteWorktree({ cwd: wt.path, stores: ["memory"], interactive: true, env, now: () => NOW });
    // Editing the source after promotion makes it differ from the user copy: it is listed again, never overwritten.
    for (const entry of MEMORY_PATHS) appendFileSync(path.join(wt.path, entry), "- changed after promotion\n");
    const again = await promoteWorktree({ cwd: wt.path, stores: ["memory"], interactive: true, env, now: () => NOW });
    expect(again.promoted.memory).toEqual([]);
    expect(again.skipped.map((item) => item.reason)).toEqual([
      "an entry with this name already exists in the user memory",
      "an entry with this name already exists in the user memory",
    ]);
  });

  test("learning goes through the existing promote, with the owner's confirmation", async () => {
    const { id } = accepted();
    await writeIndex(
      {
        [id]: [
          { projectIdentity: SHA_A, identityKind: "remote-hash", confidence: 0.9, acceptedAt: "2026-11-01T00:00:00.000Z" },
          { projectIdentity: SHA_B, identityKind: "remote-hash", confidence: 0.9, acceptedAt: "2026-11-01T00:00:00.000Z" },
        ],
      },
      { env },
    );
    const asked: string[] = [];
    const report = await promoteWorktree({
      cwd: wt.path,
      stores: ["learning"],
      interactive: true,
      env,
      now: () => NOW,
      confirm: async (entry) => {
        asked.push(entry);
        return true;
      },
    });
    expect(asked).toEqual([id]);
    expect(report.promoted.learning).toEqual([id]);
    expect((await readPattern(wt.path, id, "user", { env }))?.status).toBe("candidate");
    // Once promoted it is no longer listed as unpromoted.
    expect((await listUnpromoted(wt.path, { env })).learning).toEqual([]);
  });

  test("a refused learning promotion is reported, not thrown", async () => {
    const report = await promoteWorktree({ cwd: wt.path, stores: ["learning"], interactive: true, env, confirm: async () => true });
    expect(report.promoted.learning).toEqual([]);
    expect(report.skipped[0]?.reason).toContain("insufficient-project-identities");
  });

  test("a declined confirmation promotes nothing", async () => {
    const report = await promoteWorktree({ cwd: wt.path, stores: ["learning"], interactive: true, env, confirm: async () => false });
    expect(report.promoted.learning).toEqual([]);
  });

  test("without a terminal only --dry-run works, and nothing is written", async () => {
    await expect(promoteWorktree({ cwd: wt.path, interactive: false, env })).rejects.toThrow("interactive terminal");
    expect(existsSync(memoryRootFor("user", wt.path, env))).toBe(false);
  });

  test("--entry narrows what is promoted", async () => {
    const report = await promoteWorktree({
      cwd: wt.path,
      stores: ["memory"],
      entries: [MEMORY_PATHS[0] as string],
      interactive: true,
      env,
      now: () => NOW,
    });
    expect(report.promoted.memory.map((item) => item.path)).toEqual([MEMORY_PATHS[0] as string]);
  });
});
