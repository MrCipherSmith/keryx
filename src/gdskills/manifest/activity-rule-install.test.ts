import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { projectRulePath } from "../rule-references";
import { applyInstall } from "./apply";
import { installedContent } from "./content";
import { defaultBundledSourceRoot, loadBundledManifest } from "./manifest";
import { CLAUDE_ACTIVITY_RULE_PREFIX, planInstall } from "./plan";

// Review of #1229 (ADR-0001 P5): every review lens points at the review
// activity rule instead of carrying the shared laws. That pointer has to land
// on a file the install actually wrote, on every target — the claude install
// rewrites the cited path (M2) — and has to name the project's own copy first
// (M3); the real manifest has to ship the activity layer at all (R3).

const sourceRoot = defaultBundledSourceRoot();
const ACTIVITY = ["implement", "review", "test"] as const;
const POINTER = "Read the review activity rule before the code";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-activity-install-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** The backticked paths a lens's pointer names, in the order it names them. */
function pointerPaths(skill: string): string[] {
  const line = skill.split("\n").find((l) => l.startsWith(POINTER));
  if (line === undefined) return [];
  return [...line.matchAll(/`([^`]+\/review\.mdc|[^`]+review\.mdc)`/g)].map((m) => m[1]!);
}

const activityDestination = (target: "claude" | "keryx-shell", name: string): string =>
  target === "claude" ? `.claude/rules/${CLAUDE_ACTIVITY_RULE_PREFIX}${name}.mdc` : `.metaproject/rules/activity/${name}.mdc`;

for (const target of ["claude", "keryx-shell"] as const) {
  test(`${target}: the real manifest installs the activity rules, and every review lens's pointer resolves`, async () => {
    const plan = await planInstall({ manifest: loadBundledManifest(), profileId: "core", target, repoRoot: sourceRoot });
    expect(plan.errors).toEqual([]);
    const applied = await applyInstall(plan, root, { sourceRoot });
    expect(applied.errors).toEqual([]);

    for (const name of ACTIVITY) {
      const destination = activityDestination(target, name);
      expect({ destination, present: existsSync(path.join(root, destination)) }).toEqual({ destination, present: true });
    }
    if (target === "claude") {
      // Role names stay off the flat root, where they would collide with the user's own files.
      for (const name of ACTIVITY) expect(existsSync(path.join(root, ".claude", "rules", `${name}.mdc`))).toBe(false);
    }

    const skills = plan.modules.flatMap((m) => m.files).map((f) => f.destination).filter((d) => d.endsWith("/SKILL.md"));
    let lenses = 0;
    for (const skill of skills) {
      const text = await readFile(path.join(root, skill), "utf8");
      const cited = pointerPaths(text);
      if (cited.length === 0) continue;
      lenses += 1;
      // The claude install rewrites the keryx path of an activity rule to where it put it.
      if (target === "claude") expect({ skill, keryxPath: text.includes(".metaproject/rules/activity/") }).toEqual({ skill, keryxPath: false });
      const resolves = cited.some((candidate) => existsSync(path.join(root, candidate)));
      expect({ skill, cited, resolves }).toEqual({ skill, cited, resolves: true });
    }
    // review-orchestrator and the core lenses of the `core` profile.
    expect(lenses).toBeGreaterThan(5);
  });
}

test("M3: every lens names the project's own review rule first, at the slot rule references resolve through", async () => {
  const bundled = path.join(sourceRoot, "src", "gdskills", "bundled", "skills");
  let lenses = 0;
  for await (const rel of new Bun.Glob("**/SKILL.md").scan({ cwd: bundled })) {
    const cited = pointerPaths(await readFile(path.join(bundled, rel), "utf8"));
    if (cited.length === 0) continue;
    lenses += 1;
    expect({ skill: rel, cited }).toEqual({
      skill: rel,
      cited: [
        projectRulePath("activity/review.mdc"),
        ".metaproject/rules/activity/review.mdc",
      ],
    });
  }
  expect(lenses).toBe(25);
});

test("M2: the claude rewrite touches only a claude skill's keryx activity-rule path, never the project's own slot", () => {
  const text = "`.metaproject/rules/project/activity/review.mdc` else `.metaproject/rules/activity/review.mdc`; see `.metaproject/rules/core/x.mdc`";
  const claude = installedContent("claude", ".claude/skills/review-logic/SKILL.md", Buffer.from(text)).toString("utf8");
  expect(claude).toBe(
    "`.metaproject/rules/project/activity/review.mdc` else `.claude/rules/keryx-activity-review.mdc`; see `.metaproject/rules/core/x.mdc`",
  );
  // A rule file, and every keryx-shell destination, is copied as it ships.
  expect(installedContent("claude", ".claude/rules/x.mdc", Buffer.from(text)).toString("utf8")).toBe(text);
  expect(installedContent("keryx-shell", ".metaproject/skills/gdskills/review/review-logic/SKILL.md", Buffer.from(text)).toString("utf8")).toBe(text);
});
