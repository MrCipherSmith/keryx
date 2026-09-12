import { access, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { CONTRACTS, contractPath } from "./contracts";
import {
  installGdskills,
  normalizeRetiredRuleContent,
  removeStaleRuntimeBuilds,
  removeUnmodifiedRetiredRules,
  retiredRuleWarning,
  staleRuntimeBuildMessage,
  staleRuntimeBuildSeverity,
} from "./install";
import { RETIRED_RULE_SIZE_CAP_BYTES, RETIRED_RULES } from "./retired-rules";

test("installs real bundled gdskills, contracts, shared assets, and rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-gdskills-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(result.installedSkills).toBeGreaterThan(20);

    const jobOrchestrator = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "job-orchestrator", "SKILL.md"),
      "utf8",
    );
    expect(jobOrchestrator).toContain("Dynamic orchestrator");
    expect(await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "job-orchestrator", "input-contract.schema.json"),
      "utf8",
    )).toContain("\"$schema\"");

    const reviewOrchestrator = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "review", "review-orchestrator", "review-context.schema.json"),
      "utf8",
    );
    expect(reviewOrchestrator).toContain("\"$schema\"");

    const flowOrchestrator = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "flow-orchestrator", "SKILL.md"),
      "utf8",
    );
    expect(flowOrchestrator).toContain("Task Manager-aware implementation orchestrator");
    expect(flowOrchestrator).toContain("How should this flow end?");
    expect(flowOrchestrator).toContain("Verified handoff without PR");
    expect(await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "flow-orchestrator", "input-contract.schema.json"),
      "utf8",
    )).toContain("FlowOrchestratorInput");

    const generatedMetaprojectSkill = await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "core", "entity-skill-creator", "SKILL.md"),
      "utf8",
    );
    expect(generatedMetaprojectSkill).toContain("Agent Command Contract");

    expect(await readFile(
      path.join(metaprojectRoot, "skills", "gdskills", "shared", "git-merge-base.md"),
      "utf8",
    )).toContain("merge-base");
    expect(await readFile(
      path.join(metaprojectRoot, "rules", "core", "git-rules.mdc"),
      "utf8",
    )).toContain("Git");
    await access(path.join(metaprojectRoot, "jobs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- flow 257: stale per-runtime builds in an existing install ---------------
//
// install copies each bundled skill directory over the installed one and never
// deleted anything, so a project installed before the byte-identical
// SKILL.<runtime>.md copies were dropped keeps them — and a runtime export
// prefers an existing SKILL.<runtime>.md over SKILL.md.

const INSTALLED_JOB_ORCHESTRATOR = ["skills", "gdskills", "orchestration", "job-orchestrator"];

test("a per-runtime build the bundle no longer ships is removed from an existing install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillDir = path.join(metaprojectRoot, ...INSTALLED_JOB_ORCHESTRATOR);
    const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled", "skills", "orchestration", "job-orchestrator");
    // Precondition: the bundle ships SKILL.md alone for this skill.
    expect(existsSync(path.join(bundledDir, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(bundledDir, "SKILL.codex.md"))).toBe(false);

    // What a pre-257 install left behind, plus files that must survive.
    for (const stale of ["SKILL.codex.md", "SKILL.cursor.md", "SKILL.zed.md", "SKILL.opencode.md"]) {
      await writeFile(path.join(skillDir, stale), "# stale build from an older keryx\n", "utf8");
    }
    await writeFile(path.join(skillDir, "SKILL.detail.md"), "companion, not a build\n", "utf8");
    await writeFile(path.join(skillDir, "SKILL.claude.md"), "not a harness build name\n", "utf8");
    await writeFile(path.join(skillDir, "notes.md"), "unrelated file\n", "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    for (const stale of ["SKILL.codex.md", "SKILL.cursor.md", "SKILL.zed.md", "SKILL.opencode.md"]) {
      expect(existsSync(path.join(skillDir, stale))).toBe(false);
    }
    // Only runtime-build names are touched.
    expect(await readFile(path.join(skillDir, "SKILL.detail.md"), "utf8")).toBe("companion, not a build\n");
    expect(await readFile(path.join(skillDir, "SKILL.claude.md"), "utf8")).toBe("not a harness build name\n");
    expect(await readFile(path.join(skillDir, "notes.md"), "utf8")).toBe("unrelated file\n");
    expect(await readFile(path.join(skillDir, "SKILL.md"), "utf8"))
      .toBe(await readFile(path.join(bundledDir, "SKILL.md"), "utf8"));
    // Nothing is content-gated here, so a removal must never be silent: the
    // operator gets one notice per file that left their tree, and no others.
    const removals = result.notices.filter((notice) => notice.includes("was removed"));
    expect(removals.sort()).toEqual([
      "SKILL.codex.md",
      "SKILL.cursor.md",
      "SKILL.opencode.md",
      "SKILL.zed.md",
    ].map((stale) => `.metaproject/skills/gdskills/orchestration/job-orchestrator/${stale} was removed: a per-runtime build keryx no longer ships (that runtime now reads SKILL.md), which every later runtime export would otherwise have kept preferring over the current SKILL.md`));
    expect(result.warnings.filter((warning) => warning.includes("kept because"))).toEqual([]);
    // A clean sweep asks nothing of the operator, so it warns about nothing.
    expect(result.warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a per-runtime build the bundle still ships is replaced, not removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    // `planner` (a gproject-* subagent) is in the full profile and still ships
    // its codex and cursor builds, which differ by `compatible_harnesses`.
    await installGdskills(metaprojectRoot, "full");
    const skillDir = path.join(metaprojectRoot, "skills", "gdskills", "planning", "planner");
    const bundledDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled", "skills", "planning", "planner");
    expect(existsSync(path.join(bundledDir, "SKILL.codex.md"))).toBe(true);
    expect(existsSync(path.join(bundledDir, "SKILL.zed.md"))).toBe(false);

    await writeFile(path.join(skillDir, "SKILL.codex.md"), "# locally edited codex build\n", "utf8");
    await writeFile(path.join(skillDir, "SKILL.zed.md"), "# stale zed build\n", "utf8");

    const result = await installGdskills(metaprojectRoot, "full");

    // Shipped: refreshed to the bundled bytes.
    expect(await readFile(path.join(skillDir, "SKILL.codex.md"), "utf8"))
      .toBe(await readFile(path.join(bundledDir, "SKILL.codex.md"), "utf8"));
    expect(await readFile(path.join(skillDir, "SKILL.cursor.md"), "utf8"))
      .toBe(await readFile(path.join(bundledDir, "SKILL.cursor.md"), "utf8"));
    // Not shipped for this skill: removed, in the same run, and reported.
    expect(existsSync(path.join(skillDir, "SKILL.zed.md"))).toBe(false);
    const removals = result.notices.filter((notice) => notice.includes("was removed"));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain(".metaproject/skills/gdskills/planning/planner/SKILL.zed.md was removed");
    // The refreshed codex/cursor builds are not reported as anything.
    expect(result.notices.filter((notice) => notice.includes("SKILL.codex.md"))).toEqual([]);
    expect(result.warnings.filter((warning) => warning.includes("SKILL.codex.md"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project-skill's SKILL.codex.md is never touched by install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    // A project-skill that happens to share a bundled skill's name and category
    // path shape — install must still leave it alone.
    const projectSkillDir = path.join(metaprojectRoot, "project-skills", "orchestration", "job-orchestrator");
    await mkdir(projectSkillDir, { recursive: true });
    await writeFile(path.join(projectSkillDir, "SKILL.md"), "# project skill\n", "utf8");
    await writeFile(path.join(projectSkillDir, "SKILL.codex.md"), "# project codex build\n", "utf8");
    // …and a skill directory in the gdskills tree that keryx does not ship.
    const unmanagedDir = path.join(metaprojectRoot, "skills", "gdskills", "orchestration", "not-a-bundled-skill");
    await mkdir(unmanagedDir, { recursive: true });
    await writeFile(path.join(unmanagedDir, "SKILL.codex.md"), "# someone else's build\n", "utf8");

    await installGdskills(metaprojectRoot, "recommended");

    expect(await readFile(path.join(projectSkillDir, "SKILL.codex.md"), "utf8")).toBe("# project codex build\n");
    expect(await readFile(path.join(unmanagedDir, "SKILL.codex.md"), "utf8")).toBe("# someone else's build\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink at a stale build name is kept, not followed, and warned about", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillDir = path.join(metaprojectRoot, ...INSTALLED_JOB_ORCHESTRATOR);
    const target = path.join(root, "outside-target.md");
    await writeFile(target, "outside\n", "utf8");
    await symlink(target, path.join(skillDir, "SKILL.codex.md"));

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect((await lstat(path.join(skillDir, "SKILL.codex.md"))).isSymbolicLink()).toBe(true);
    expect(await readFile(target, "utf8")).toBe("outside\n");
    const warning = result.warnings.find((entry) => entry.includes("per-runtime build"));
    expect(warning).toContain(".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.codex.md");
    expect(warning).toContain("not a regular file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round-2 minor: every stale-build outcome used to land in `warnings`, so the
// first `keryx update` after this release printed ~88 lines under "Warnings"
// for a sweep that did exactly what it was built to do — and buried the one
// line that needed a human. The two kinds are separated at the result, not at
// the print, so all three call sites (skills.ts / update.ts / init.ts) inherit
// the split.
test("a successful removal is a notice, and a build kept behind a symlink is a warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillDir = path.join(metaprojectRoot, ...INSTALLED_JOB_ORCHESTRATOR);
    // One genuine stale build, which the sweep removes…
    await writeFile(path.join(skillDir, "SKILL.zed.md"), "# stale build\n", "utf8");
    // …and one the sweep must refuse to touch, which leaves work behind.
    const target = path.join(root, "outside-target.md");
    await writeFile(target, "outside\n", "utf8");
    await symlink(target, path.join(skillDir, "SKILL.codex.md"));

    const result = await installGdskills(metaprojectRoot, "recommended");

    const removal = `.metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.zed.md`;
    expect(result.notices.filter((notice) => notice.includes(removal))).toHaveLength(1);
    // The load-bearing half: the successful removal is NOWHERE in `warnings`.
    expect(result.warnings.filter((warning) => warning.includes("SKILL.zed.md"))).toEqual([]);
    expect(result.warnings.filter((warning) => warning.includes("was removed"))).toEqual([]);

    const kept = result.warnings.filter((warning) => warning.includes("SKILL.codex.md"));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("not a regular file");
    // …and the kept one is not quietly duplicated into the notices either.
    expect(result.notices.filter((notice) => notice.includes("SKILL.codex.md"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale build whose removal fails is kept and becomes a warning, without aborting", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillsRoot = path.join(metaprojectRoot, "skills", "gdskills");
    const skillDir = path.join(skillsRoot, ...INSTALLED_JOB_ORCHESTRATOR.slice(2));
    await writeFile(path.join(skillDir, "SKILL.codex.md"), "stale\n", "utf8");
    await writeFile(path.join(skillDir, "SKILL.zed.md"), "stale\n", "utf8");

    const outcomes = await removeStaleRuntimeBuilds(skillsRoot, {
      unlink: async (target) => {
        if (target.endsWith("SKILL.codex.md")) {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        }
        await rm(target);
      },
    });

    // One failure did not stop the next entry.
    expect(existsSync(path.join(skillDir, "SKILL.codex.md"))).toBe(true);
    expect(existsSync(path.join(skillDir, "SKILL.zed.md"))).toBe(false);
    expect(outcomes.map((outcome) => `${path.basename(outcome.path)}:${outcome.action}`).sort())
      .toEqual(["SKILL.codex.md:kept-error", "SKILL.zed.md:removed"]);

    const messages = outcomes.map((outcome) => staleRuntimeBuildMessage(outcome, root));
    // Both halves are reported: the failure to act, and the file that went.
    expect(messages).toHaveLength(2);
    const kept = messages.find((message) => message.includes("SKILL.codex.md"));
    expect(kept).toContain(".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.codex.md");
    expect(kept).toContain("could not be removed (EPERM)");
    expect(messages.find((message) => message.includes("SKILL.zed.md")))
      .toContain(".metaproject/skills/gdskills/orchestration/job-orchestrator/SKILL.zed.md was removed");
    // …under different headings: the unlink that failed left a file behind.
    expect(outcomes.map(staleRuntimeBuildSeverity).sort()).toEqual(["notice", "warning"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// --- round-1 major: the sweep must not delete through a symlinked parent ----
//
// The sweep composes `<skillsRoot>/<category>/<name>/SKILL.<runtime>.md` and
// lstat'ed only the last component, so any symlinked *parent* was followed and
// the unlink landed in the link's target, outside `.metaproject`.

test("a skill directory reached through a symlink is not swept, and the target keeps its files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillsRoot = path.join(metaprojectRoot, "skills", "gdskills");
    const skillDir = path.join(skillsRoot, ...INSTALLED_JOB_ORCHESTRATOR.slice(2));

    // Relocate one installed skill behind a symlink — the shape a shared
    // checkout or a moved tree produces — and put a hand-written build in the
    // target, which is not keryx's to delete.
    const relocated = path.join(root, "shared-skills", "job-orchestrator");
    await mkdir(relocated, { recursive: true });
    await rm(skillDir, { recursive: true, force: true });
    await symlink(relocated, skillDir);
    await writeFile(path.join(relocated, "SKILL.zed.md"), "# hand-written, not keryx's\n", "utf8");

    // The sweep is driven directly, not through a second `installGdskills`.
    // That second install would reach the `cp(bundledDir, skillDir, { force })`
    // in `installGdskills` with `skillDir` now a symlink, and on Linux `fs.cp`
    // refuses to overwrite a non-directory with a directory —
    // `ERR_FS_CP_DIR_TO_NON_DIR` / `EISDIR` — and aborts the whole install
    // BEFORE the sweep runs, so the test never reached its own subject there.
    // macOS's `cp` happens to accept it, which is the only reason that form
    // passed at all.
    // The claim belongs to `removeStaleRuntimeBuilds`, so it is made of
    // `removeStaleRuntimeBuilds`, on every platform. A `skipped-dir` outcome
    // does reach `result.warnings` through a real install — the test below
    // plants the link one level up, at a category, where the copy destination
    // is still a directory `mkdir` just created. It is the link AT THE SKILL
    // DIRECTORY, this shape, that the copy cannot survive on Linux.
    const outcomes = await removeStaleRuntimeBuilds(skillsRoot);

    expect(await readFile(path.join(relocated, "SKILL.zed.md"), "utf8")).toBe("# hand-written, not keryx's\n");
    expect((await lstat(skillDir)).isSymbolicLink()).toBe(true);
    // One outcome for the linked skill and nothing else: the rest of the freshly
    // installed tree holds no build the bundle stopped shipping.
    expect(outcomes).toEqual([
      { path: skillDir, blockedAt: skillDir, action: "skipped-dir", reason: "symlink" },
    ]);
    const warning = staleRuntimeBuildMessage(outcomes[0]!, root);
    expect(staleRuntimeBuildSeverity(outcomes[0]!)).toBe("warning");
    expect(warning).toContain(".metaproject/skills/gdskills/orchestration/job-orchestrator was not swept");
    expect(warning).toContain("it is a symlink, and keryx will not delete through one");
    // Refusing to sweep is not refusing to warn about the wrong thing: no
    // removal was claimed for a tree keryx did not touch.
    expect(outcomes.filter((outcome) => staleRuntimeBuildSeverity(outcome) === "notice")).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.action === "removed")).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round-5 minor: the comment above used to say a `skipped-dir` outcome could
// not be observed through an install at all. It can — one level up. A link at a
// CATEGORY leaves `<skillsRoot>/<category>/<name>` a real directory that
// `mkdir(..., { recursive: true })` just created, so the copy never meets a
// non-directory destination and the install runs to completion on every
// platform. That makes the carry-through from outcome to `warnings` testable
// end to end, which is the half the direct-sweep test cannot reach.
test("a symlinked category is refused by a real install, and the refusal reaches warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillsRoot = path.join(metaprojectRoot, "skills", "gdskills");
    const [category] = INSTALLED_JOB_ORCHESTRATOR.slice(2);
    const categoryDir = path.join(skillsRoot, category!);

    // Relocate the whole category behind a link, and leave a hand-written build
    // in the target so a sweep that followed the link would have something to
    // destroy.
    const relocated = path.join(root, "shared-skills", category!);
    await mkdir(path.join(relocated, "job-orchestrator"), { recursive: true });
    await rm(categoryDir, { recursive: true, force: true });
    await symlink(relocated, categoryDir);
    await writeFile(
      path.join(relocated, "job-orchestrator", "SKILL.zed.md"),
      "# hand-written, not keryx's\n",
      "utf8",
    );

    const result = await installGdskills(metaprojectRoot, "recommended");

    // The install completed — this is the shape `fs.cp` survives.
    expect(await readFile(path.join(relocated, "job-orchestrator", "SKILL.zed.md"), "utf8")).toBe(
      "# hand-written, not keryx's\n",
    );
    expect((await lstat(categoryDir)).isSymbolicLink()).toBe(true);
    const refusal = result.warnings.filter((warning) => warning.includes("was not swept"));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain(`.metaproject/skills/gdskills/${category} was not swept`);
    expect(refusal[0]).toContain("it is a symlink, and keryx will not delete through one");
    // A refusal is not a removal, and the category is named once, not once per
    // skill inside it.
    expect(result.notices.filter((notice) => notice.includes("was not swept"))).toEqual([]);
    expect(result.notices.filter((notice) => notice.includes("SKILL.zed.md"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlinked skills root is skipped whole, with one notice for the tree", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    // The skills root itself is the link: every composed path below it would
    // resolve into someone else's tree.
    const shared = path.join(root, "shared", "gdskills");
    const sharedSkillDir = path.join(shared, "orchestration", "job-orchestrator");
    await mkdir(sharedSkillDir, { recursive: true });
    await writeFile(path.join(sharedSkillDir, "SKILL.zed.md"), "# hand-written\n", "utf8");

    const metaprojectRoot = path.join(root, ".metaproject");
    await mkdir(path.join(metaprojectRoot, "skills"), { recursive: true });
    const skillsRoot = path.join(metaprojectRoot, "skills", "gdskills");
    await symlink(shared, skillsRoot);

    const outcomes = await removeStaleRuntimeBuilds(skillsRoot);

    expect(await readFile(path.join(sharedSkillDir, "SKILL.zed.md"), "utf8")).toBe("# hand-written\n");
    // One notice for the whole tree — not one per bundled skill in the catalogue.
    expect(outcomes).toEqual([
      { path: skillsRoot, blockedAt: skillsRoot, action: "skipped-dir", reason: "symlink" },
    ]);
    const warning = staleRuntimeBuildMessage(outcomes[0]!, root);
    expect(staleRuntimeBuildSeverity(outcomes[0]!)).toBe("warning");
    expect(warning).toContain(".metaproject/skills/gdskills was not swept");
    expect(warning).toContain("it is a symlink, and keryx will not delete through one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("only an exactly-matching directory entry is removed, so a differently-cased file survives", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-stale-builds-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");
    const skillDir = path.join(metaprojectRoot, ...INSTALLED_JOB_ORCHESTRATOR);
    // On a case-insensitive filesystem (macOS, Windows) a composed
    // `SKILL.codex.md` resolves to this file, so lstat+unlink would delete the
    // user's own file and report it under the canonical spelling. Matching a
    // real directory entry by exact name cannot do that. On a case-sensitive
    // filesystem this is simply an unrelated file, which must also survive.
    await writeFile(path.join(skillDir, "skill.codex.md"), "# my own notes\n", "utf8");
    // A genuine stale build alongside it, to prove exact matching still removes.
    await writeFile(path.join(skillDir, "SKILL.zed.md"), "# stale build\n", "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    const survivors = await readdir(skillDir);
    expect(survivors).toContain("skill.codex.md");
    expect(await readFile(path.join(skillDir, "skill.codex.md"), "utf8")).toBe("# my own notes\n");
    expect(survivors).not.toContain("SKILL.zed.md");
    const removals = result.notices.filter((notice) => notice.includes("was removed"));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain("SKILL.zed.md was removed");
    expect(result.notices.filter((notice) => notice.toLowerCase().includes("skill.codex.md"))).toEqual([]);
    expect(result.warnings.filter((warning) => warning.toLowerCase().includes("skill.codex.md"))).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundled gdskills do not embed developer-specific absolute paths", async () => {
  const bundledRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "bundled");
  // Guard against a developer's real home directory or machine-specific paths
  // leaking into the portable, bundled skills. The generic placeholders
  // `/Users/dev` and `/Users/...` used in examples are allowed.
  const forbidden = [
    /\/Users\/(?!dev\b|user\b|\.\.\.)[A-Za-z][\w.-]*/,
    /\/home\/(?!dev\b|user\b|\.\.\.)[A-Za-z][\w.-]*/,
  ];
  const violations: string[] = [];

  for (const filePath of await listFiles(bundledRoot)) {
    const content = await readFile(filePath, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(content)) {
        violations.push(`${path.relative(bundledRoot, filePath)}: ${pattern.source}`);
      }
    }
  }

  expect(violations).toEqual([]);
});

// `.metaproject/rules/core/` is a generated install target: `installBundledRules`
// copies `src/gdskills/bundled/rules/core/` over it with `force: true` on every
// `keryx init`, `keryx update` and `keryx skills install`.
//
// So an edit made to the installed copy alone ships nowhere and is reverted by
// the next update — silently, because nothing compared the two. That happened:
// the fix correcting this protocol from four statuses to five was written to the
// install target only, and an `installGdskills` run put the stale text back.
//
// The equivalent drift for skills is caught by review discipline; this makes it
// caught by the build.
test("every bundled rule is byte-identical to its installed copy in this repo", async () => {
  const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const source = path.join(repoRoot, "src", "gdskills", "bundled", "rules", "core");
  const installed = path.join(repoRoot, ".metaproject", "rules", "core");

  const drifted: string[] = [];
  for (const file of await listFiles(source)) {
    const relative = path.relative(source, file);
    const target = path.join(installed, relative);
    let targetText: string;
    try {
      targetText = await readFile(target, "utf8");
    } catch {
      drifted.push(`${relative}: missing from .metaproject/rules/core`);
      continue;
    }
    if (await readFile(file, "utf8") !== targetText) {
      drifted.push(`${relative}: bundled source and installed copy differ`);
    }
  }
  expect(drifted).toEqual([]);
});

// The contract mirror had the same drift the rules mirror had, and worse: the
// installer carried its OWN list of five file names beside a registry of five
// entries, and the job-orchestrator state schema was in neither. It could
// therefore not be validated (`keryx skills contracts validate` could not load
// it) and was not installed. `installContracts` now derives from `CONTRACTS`;
// these two tests are what makes that derivation load-bearing.
test("every registered contract is installed into core/gdskills/contracts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-contracts-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    await installGdskills(metaprojectRoot, "recommended");

    // Non-vacuity: the registry must actually name the contract this closes.
    expect(CONTRACTS.map((contract) => contract.name)).toContain("job-orchestrator-state");

    for (const contract of CONTRACTS) {
      const installed = await readFile(
        path.join(metaprojectRoot, "core", "gdskills", "contracts", contract.fileName),
        "utf8",
      );
      expect(installed).toBe(await readFile(contractPath(contract), "utf8"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("this repo's installed contracts are byte-identical to their sources", async () => {
  const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const drifted: string[] = [];
  for (const contract of CONTRACTS) {
    const target = path.join(repoRoot, ".metaproject", "core", "gdskills", "contracts", contract.fileName);
    try {
      if ((await readFile(target, "utf8")) !== (await readFile(contractPath(contract), "utf8"))) {
        drifted.push(`${contract.fileName}: source and installed copy differ`);
      }
    } catch {
      drifted.push(`${contract.fileName}: missing from .metaproject/core/gdskills/contracts`);
    }
  }
  expect(drifted).toEqual([]);
});

// AC2: installing over a project that holds an unmodified copy of a retired
// bundled rule removes it; a modified copy is kept and reported.
//
// `RETIRED_RULES` records the sha256 of every version of
// `review-agent-profile.mdc` and `review-strict-profile.mdc` that ever
// shipped (see retired-rules.ts) — this file no longer exists anywhere in
// `bundled/rules/core/`, so a plain `cp` force-copy can never remove it from
// an installed project on its own; `installBundledRules` has to do that
// itself by comparing content hashes.
const retiredFixturesRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "__fixtures__", "retired-rules");

test("an unmodified retired rule is removed from an existing install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName));
    // Sanity check on the fixture itself: if this ever fails, the fixture no
    // longer matches a version this project actually shipped, and the test
    // below would be exercising the wrong scenario.
    const fixtureHash = createHash("sha256").update(unmodifiedContent).digest("hex");
    expect(retiredEntry.shippedSha256).toContain(fixtureHash);

    await writeFile(path.join(rulesCore, retiredEntry.fileName), unmodifiedContent);

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(existsSync(path.join(rulesCore, retiredEntry.fileName))).toBe(false);
    expect(result.warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a modified retired rule is kept and reported as a warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName), "utf8");
    const modifiedContent = `${unmodifiedContent}\n<!-- project-local note added after install -->\n`;
    await writeFile(path.join(rulesCore, retiredEntry.fileName), modifiedContent, "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(await readFile(path.join(rulesCore, retiredEntry.fileName), "utf8")).toBe(modifiedContent);
    expect(result.warnings).toEqual([
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it differs from every shipped version — delete it, or rename it if you still rely on it`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round-1 finding T-002: the two tests above only ever exercise
// `RETIRED_RULES[0]` (`review-agent-profile.mdc`, one shipped hash).
// `review-strict-profile.mdc` and its second shipped hash (the ff9dd071
// revision) were never driven through the installer at all — a wrong hash
// for either version would leave an unmodified copy installed forever with
// every test above still green. These tests loop over every (entry,
// shippedSha256) pair, backed by a byte-exact fixture per shipped version
// (src/gdskills/__fixtures__/retired-rules/), recovered with
// `git show <shipped-blob>:src/gdskills/bundled/rules/core/<name> >
// __fixtures__/retired-rules/<name>.<short-sha>.mdc` for the multi-version
// entry, matching the naming convention already used for the single-version
// entry (`review-agent-profile.mdc`, no suffix).
//
// The fixtures below are hashed with the installer's own
// `normalizeRetiredRuleContent` (imported from install.ts, round-2 finding
// T-008 — this used to be a hand-copied duplicate that could silently
// drift from the real function): decode UTF-8, strip one leading BOM,
// `\r\n` -> `\n`. The registered hashes are of the shipped files
// LF/BOM-less already, so normalisation is a no-op for these fixtures, but
// hashing the same way here means a future entry that recorded a hash of
// non-normalised content would be caught by these tests too.

type RetiredRuleFixtureCase = {
  /** `RetiredRuleEntry.fileName` this fixture is a version of. */
  fileName: string;
  /** File name inside `__fixtures__/retired-rules/`. */
  fixtureFile: string;
  /** sha256 (of normalised content) this fixture actually hashes to. */
  sha256: string;
};

/**
 * Every fixture file registered under `__fixtures__/retired-rules/` for a
 * `RETIRED_RULES` entry, paired with the entry it belongs to and the hash it
 * hashes to. An entry with one shipped version uses the fixture at its bare
 * `fileName`; an entry with more than one shipped version uses every fixture
 * whose name is `<basename>.<anything>.<ext>` (e.g.
 * `review-strict-profile.fd43d35a.mdc`) — the short git commit each version
 * was recovered from, not part of the content hash itself.
 */
async function listRetiredRuleFixtureCases(): Promise<RetiredRuleFixtureCase[]> {
  const allFixtureFiles = await readdir(retiredFixturesRoot);
  const cases: RetiredRuleFixtureCase[] = [];
  for (const entry of RETIRED_RULES) {
    const parsed = path.parse(entry.fileName);
    const fixtureFiles =
      entry.shippedSha256.length === 1
        ? [entry.fileName]
        : allFixtureFiles
            .filter((name) => name.startsWith(`${parsed.name}.`) && name.endsWith(parsed.ext))
            .sort();
    for (const fixtureFile of fixtureFiles) {
      const content = await readFile(path.join(retiredFixturesRoot, fixtureFile));
      const sha256 = createHash("sha256").update(normalizeRetiredRuleContent(content)).digest("hex");
      cases.push({ fileName: entry.fileName, fixtureFile, sha256 });
    }
  }
  return cases;
}

test("every RETIRED_RULES shippedSha256, for every registered entry, has a byte-exact fixture", async () => {
  const cases = await listRetiredRuleFixtureCases();
  for (const entry of RETIRED_RULES) {
    const hashesFromFixtures = cases.filter((c) => c.fileName === entry.fileName).map((c) => c.sha256);
    for (const shippedSha256 of entry.shippedSha256) {
      expect(hashesFromFixtures).toContain(shippedSha256);
    }
  }
});

test("an unmodified copy of every shipped version of every retired rule is removed", async () => {
  const cases = await listRetiredRuleFixtureCases();
  // Guard the loop itself: if fixture discovery came back empty, every
  // assertion below would vacuously pass instead of exercising anything.
  expect(cases.length).toBeGreaterThanOrEqual(
    RETIRED_RULES.reduce((total, entry) => total + entry.shippedSha256.length, 0),
  );

  for (const { fileName, fixtureFile } of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-t002-"));
    try {
      const metaprojectRoot = path.join(root, ".metaproject");
      const rulesCore = path.join(metaprojectRoot, "rules", "core");
      await mkdir(rulesCore, { recursive: true });

      const fixtureContent = await readFile(path.join(retiredFixturesRoot, fixtureFile));
      await writeFile(path.join(rulesCore, fileName), fixtureContent);

      const result = await installGdskills(metaprojectRoot, "recommended");

      expect(existsSync(path.join(rulesCore, fileName))).toBe(false);
      expect(result.warnings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

// Round-1 finding S-001: `removeUnmodifiedRetiredRules` used to gate on
// `existsSync` + `readFile` with no `lstat`/`isFile`, no size bound, and no
// try/catch — a directory, symlink, FIFO, or unreadable file at a retired
// name would abort the whole install (or worse) before the catalog,
// manifest, and contracts were written. `.metaproject/rules/core` is
// git-tracked, so a project's repo can plant any of these. The tests below
// each assert the install still completes (catalog + manifest written).

test("a directory at a retired rule's name is kept, warned about, and does not abort the install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const dirPath = path.join(rulesCore, retiredEntry.fileName);
    await mkdir(dirPath, { recursive: true });
    await writeFile(path.join(dirPath, "placeholder.txt"), "not a rule file\n", "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    // The install completed: catalog and manifest were actually written,
    // not aborted partway through by the directory.
    await access(result.catalogPath);
    await access(result.manifestPath);
    expect((await lstat(dirPath)).isDirectory()).toBe(true);
    await access(path.join(dirPath, "placeholder.txt"));
    expect(result.warnings).toEqual([
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete or rename it yourself if appropriate`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a symlink at a retired rule's name is kept and its target is left untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName));
    const targetPath = path.join(root, "shared-target.mdc");
    await writeFile(targetPath, unmodifiedContent);
    const linkPath = path.join(rulesCore, retiredEntry.fileName);
    await symlink(targetPath, linkPath);

    const result = await installGdskills(metaprojectRoot, "recommended");

    // `lstat` never followed the link, so it was judged (and kept) without
    // ever reading through it — the target is untouched, byte for byte.
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath)).toEqual(unmodifiedContent);
    expect(result.warnings).toEqual([
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete or rename it yourself if appropriate`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unreadable retired rule file is kept, warned about, and does not abort the install", async () => {
  // Root bypasses permission bits, so chmod 000 would still be readable —
  // skip rather than assert a false negative.
  if (process.getuid?.() === 0) {
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const filePath = path.join(rulesCore, retiredEntry.fileName);
    await writeFile(filePath, "some content that is about to become unreadable\n", "utf8");
    await chmod(filePath, 0o000);

    try {
      const result = await installGdskills(metaprojectRoot, "recommended");

      expect(existsSync(filePath)).toBe(true);
      expect(result.warnings).toHaveLength(1);
      const [warning] = result.warnings;
      expect(warning).toStartWith(`${retiredEntry.fileName} is no longer shipped by keryx`);
      expect(warning).toContain("could not be read (EACCES)");
    } finally {
      // Restore permissions so the outer `rm` can clean up the tmp dir.
      await chmod(filePath, 0o644).catch(() => {});
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round-2 finding L-008: an unmodified retired copy that fails only at the
// `unlink` step (the file itself was read and hash-matched fine) used to be
// reported with the same "could not be read" wording as a genuine read
// failure. This drives that path specifically: unlike the chmod-000 test
// above, the file stays readable — only removing it from its directory
// fails, because the directory itself has no write permission.
// The unlink-failure branch itself, on every platform: a confirmed-unmodified
// copy whose removal fails is kept, and the warning names the removal — not a
// read — as what failed (round-2 finding L-008). The failure is injected
// because no filesystem setup makes only this one unlink fail portably.
test("a confirmed-unmodified retired rule whose removal fails is kept and reported as a removal failure", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const rulesCore = path.join(root, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const filePath = path.join(rulesCore, retiredEntry.fileName);
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName), "utf8");
    await writeFile(filePath, unmodifiedContent, "utf8");

    const attempted: string[] = [];
    const outcomes = await removeUnmodifiedRetiredRules(rulesCore, {
      unlink: async (target) => {
        attempted.push(target);
        throw Object.assign(new Error(`EACCES: permission denied, unlink '${target}'`), { code: "EACCES" });
      },
    });

    // The unlink was reached, so the file was read and matched a shipped hash.
    expect(attempted).toEqual([filePath]);
    expect(outcomes).toEqual([
      { fileName: retiredEntry.fileName, action: "kept-error", stage: "unlink", errorCode: "EACCES" },
    ]);
    expect(await readFile(filePath, "utf8")).toBe(unmodifiedContent);

    const [outcome] = outcomes;
    if (!outcome) {
      throw new Error("expected exactly one outcome");
    }
    const warning = retiredRuleWarning(outcome) ?? "";
    expect(warning).toStartWith(`${retiredEntry.fileName} is no longer shipped by keryx`);
    expect(warning).toContain("matches a shipped version but could not be removed (EACCES)");
    expect(warning).not.toContain("could not be read");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an unmodified retired rule in a read-only rules/core directory is kept, warned about as a removal failure (not a read failure), and does not abort the install", async () => {
  // Unlinking a file requires write permission on its *containing
  // directory*, not the file itself — root bypasses that check, and
  // directory permission bits don't carry the same meaning on Windows.
  // macOS only: on Linux, Bun's `cp({ force: true })` unlinks each
  // destination before copying, so a read-only rules/core aborts the bulk
  // rule copy before the retired-rule cleanup runs (seen in CI on PR #533).
  // The test above covers the removal-failure branch on every platform.
  if (process.getuid?.() === 0 || process.platform !== "darwin") {
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");

    // First install populates rules/core normally, while it's still
    // writable.
    await installGdskills(metaprojectRoot, "recommended");

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const filePath = path.join(rulesCore, retiredEntry.fileName);
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName), "utf8");
    await writeFile(filePath, unmodifiedContent, "utf8");

    // A retired name isn't in the bundle anymore, so the second install's
    // `cp` never needs to create *this* directory entry — every bundled
    // file it does write already exists from the first install, and
    // overwriting an existing file in place only needs write permission on
    // that file, not on the directory. On macOS, where Bun's `cp` overwrites
    // in place, making rules/core read-only here blocks nothing but this
    // function's own `unlink` call (hence the platform gate above).
    await chmod(rulesCore, 0o555);

    try {
      const result = await installGdskills(metaprojectRoot, "recommended");

      expect(existsSync(filePath)).toBe(true);
      expect(await readFile(filePath, "utf8")).toBe(unmodifiedContent);
      expect(result.warnings).toHaveLength(1);
      const [warning] = result.warnings;
      expect(warning).toStartWith(`${retiredEntry.fileName} is no longer shipped by keryx`);
      expect(warning).toContain("matches a shipped version but could not be removed (EACCES)");
      expect(warning).not.toContain("could not be read");
    } finally {
      // Restore permissions so the outer `rm` can clean up the tmp dir.
      await chmod(rulesCore, 0o755).catch(() => {});
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a CRLF copy of an unmodified retired rule is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName), "utf8");
    const crlfContent = unmodifiedContent.replace(/\n/g, "\r\n");
    // Sanity check: this only exercises the CRLF path if the fixture
    // actually contains a line break to convert.
    expect(crlfContent).not.toBe(unmodifiedContent);
    await writeFile(path.join(rulesCore, retiredEntry.fileName), crlfContent, "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(existsSync(path.join(rulesCore, retiredEntry.fileName))).toBe(false);
    expect(result.warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a UTF-8 BOM-prefixed copy of an unmodified retired rule is removed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const unmodifiedContent = await readFile(path.join(retiredFixturesRoot, retiredEntry.fileName), "utf8");
    const bomContent = String.fromCharCode(0xfeff) + unmodifiedContent;
    await writeFile(path.join(rulesCore, retiredEntry.fileName), bomContent, "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(existsSync(path.join(rulesCore, retiredEntry.fileName))).toBe(false);
    expect(result.warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an oversized regular file at a retired rule's name is kept, warned about, and does not abort the install", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const filePath = path.join(rulesCore, retiredEntry.fileName);
    const oversizedContent = "x".repeat(RETIRED_RULE_SIZE_CAP_BYTES + 1);
    await writeFile(filePath, oversizedContent, "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(existsSync(filePath)).toBe(true);
    expect(result.warnings).toEqual([
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it is ${oversizedContent.length} bytes, far larger than any version keryx ever shipped under this name — inspect it, then delete or rename it if appropriate`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a FIFO at a retired rule's name is kept, warned about, and does not hang or abort the install", async () => {
  // `mkfifo` isn't available on Windows, and with lstat-first the installer
  // never opens the FIFO anyway (that's the property this test pins).
  if (process.platform === "win32") {
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const retiredEntry = RETIRED_RULES[0];
    if (!retiredEntry) {
      throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
    }
    const fifoPath = path.join(rulesCore, retiredEntry.fileName);
    const mkfifo = Bun.spawnSync(["mkfifo", fifoPath]);
    if (mkfifo.exitCode !== 0) {
      throw new Error(`mkfifo failed: ${mkfifo.stderr.toString()}`);
    }

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect((await lstat(fifoPath)).isFIFO()).toBe(true);
    expect(result.warnings).toEqual([
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it is not a regular file (a symlink, directory, or similar) — keryx will not read or remove it; delete or rename it yourself if appropriate`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no retired files present is a no-op with no warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(result.warnings).toEqual([]);
    for (const retired of RETIRED_RULES) {
      expect(existsSync(path.join(metaprojectRoot, "rules", "core", retired.fileName))).toBe(false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a non-retired custom rule in rules/core is left untouched", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-retired-rules-"));
  try {
    const metaprojectRoot = path.join(root, ".metaproject");
    const rulesCore = path.join(metaprojectRoot, "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const customRulePath = path.join(rulesCore, "our-team-conventions.mdc");
    const customContent = "# Our Team Conventions\n\nAlways bring coffee.\n";
    await writeFile(customRulePath, customContent, "utf8");

    const result = await installGdskills(metaprojectRoot, "recommended");

    expect(await readFile(customRulePath, "utf8")).toBe(customContent);
    expect(result.warnings).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Guard for AC2's premise: a rule cannot be both currently shipped and
// registered as retired. If a name ever reappeared in the bundle while still
// listed in RETIRED_RULES, `removeUnmodifiedRetiredRules` would delete a
// freshly (re-)installed, currently-shipped rule the moment its content
// happened to match an old retired hash — and if it didn't match, every
// fresh install of that rule would be permanently misreported as "kept
// because it was modified".
test("no retired rule name is present in the currently bundled rules", async () => {
  const bundledRulesCore = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "bundled",
    "rules",
    "core",
  );
  const bundledFileNames = new Set(
    (await readdir(bundledRulesCore, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name),
  );

  const overlap = RETIRED_RULES.map((rule) => rule.fileName).filter((name) => bundledFileNames.has(name));
  expect(overlap).toEqual([]);
});

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
