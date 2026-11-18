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

    if (target === "claude") {
      // N1: every activity citation in every installed claude file — skills and rules, any spelling — resolves.
      const installed = plan.modules.flatMap((m) => m.files).map((f) => f.destination);
      const dangling: string[] = [];
      let rewritten = 0;
      for (const file of installed) {
        const text = await readFile(path.join(root, file), "utf8");
        for (const m of text.matchAll(/(?<![\w./-])(?:\.metaproject\/)?(?:rules\/)?activity\/[a-z0-9._-]+\.mdc/g)) dangling.push(`${file}: ${m[0]}`);
        for (const m of text.matchAll(/\.claude\/rules\/keryx-activity-[a-z0-9._-]+\.mdc/g)) {
          rewritten += 1;
          if (!existsSync(path.join(root, m[0]))) dangling.push(`${file}: ${m[0]}`);
        }
      }
      expect(dangling).toEqual([]);
      expect(rewritten).toBeGreaterThan(lenses);
    }
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

test("M2/N1: the claude rewrite covers every spelling of an activity-rule path in skills and rules, never the project's own slot", () => {
  const text =
    "`.metaproject/rules/project/activity/review.mdc` else `.metaproject/rules/activity/review.mdc`; `rules/activity/implement.mdc`, `activity/test.mdc`; see `.metaproject/rules/core/x.mdc`";
  const expected =
    "`.metaproject/rules/project/activity/review.mdc` else `.claude/rules/keryx-activity-review.mdc`; `.claude/rules/keryx-activity-implement.mdc`, `.claude/rules/keryx-activity-test.mdc`; see `.metaproject/rules/core/x.mdc`";
  expect(installedContent("claude", ".claude/skills/review-logic/SKILL.md", Buffer.from(text)).toString("utf8")).toBe(expected);
  // A rule file on the claude target is rewritten too (N1); every keryx-shell destination is copied as it ships.
  expect(installedContent("claude", ".claude/rules/tdd-workflow.mdc", Buffer.from(text)).toString("utf8")).toBe(expected);
  expect(installedContent("keryx-shell", ".metaproject/skills/gdskills/review/review-logic/SKILL.md", Buffer.from(text)).toString("utf8")).toBe(text);
});

test("N3: review.mdc scopes by mode, and its path-mode rule is the orchestrator's — the whole file, as it stands", async () => {
  const read = (rel: string): Promise<string> => readFile(path.join(sourceRoot, "src", "gdskills", "bundled", rel), "utf8");
  const rule = await read("rules/activity/review.mdc");
  const orchestrator = await read("skills/review/review-orchestrator/SKILL.md");
  const paragraph = (text: string, start: string): string => text.split("\n\n").find((p) => p.startsWith(start)) ?? "";
  const diffMode = paragraph(rule, "**Diff mode** (`scope_mode: diff`");
  const pathMode = paragraph(rule, "**Path mode** (`scope_mode: path`)");
  expect(diffMode).toContain("changes introduced in the current branch since merge-base only");
  for (const clause of ["entire file content", "not just added lines", "current state of the code, not only to changes"]) {
    expect({ clause, rule: pathMode.includes(clause), orchestrator: orchestrator.includes(clause) }).toEqual({ clause, rule: true, orchestrator: true });
  }
});
