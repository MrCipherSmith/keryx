import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { knownSubcommandsFor } from "../cli-registry";
import { pathExists } from "../lib/fs";
import { readProjectRuleRegistry } from "../gdskills/project-rules";
import { skillsCommand } from "./skills";

// Flow 360 (AC3): the removal logic is tested in `gdskills/remove-skill.test.ts`.
// What only the ROUTER does is tested here: it has to know the word `remove`
// (twice — its own dispatch, and the table that refuses unknown first tokens
// before the dispatch runs), and it is the one place a refusal becomes exit 1.

const roots: string[] = [];
const startCwd = process.cwd();

afterEach(async () => {
  process.chdir(startCwd);
  process.exitCode = 0;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("`remove` is a known skills subcommand, so it is not refused as a typo before the router runs", () => {
  expect(knownSubcommandsFor("skills")).toContain("remove");
});

test("the skills router dispatches `remove`; a refusal exits 1 with the reason on stderr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-router-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{}\n", "utf8");
  process.chdir(root);

  const { out, err } = await capture(() => skillsCommand(["remove", "review/no-such-skill"]));

  expect(out).toBe("");
  expect(err).toContain("keryx skills remove: project skill not found: review/no-such-skill");
  expect(err).not.toContain("Unknown skills command");
  expect(process.exitCode).toBe(1);
});

test("`keryx skills --help` lists remove", async () => {
  const { out } = await capture(() => skillsCommand(["--help"]));
  expect(out).toContain("keryx skills remove <module>/<name> [--dry-run] [--json]");
  expect(out).toMatch(/^ {2}remove\s+\S/m);
});

// Flow 461 AC8: `skills remove --rule <ref>` deletes a rule `skills import --rules`
// registered, and nothing else.
async function ruleProject(): Promise<{ root: string; rules: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-rule-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), `${JSON.stringify({ modules: { gdskills: {} } })}\n`, "utf8");
  const rules = path.join(root, "vantage-rules");
  await mkdir(path.join(rules, "nested"), { recursive: true });
  await writeFile(path.join(rules, "styling.mdc"), "---\ndescription: s\nglobs: src/**/*.css\nalwaysApply: false\n---\n\nTokens.\n", "utf8");
  await writeFile(path.join(rules, "nested", "mobx.mdc"), "---\ndescription: m\nglobs: src/**/*.ts\nalwaysApply: false\n---\n\nStores.\n", "utf8");
  await mkdir(path.join(root, ".metaproject", "rules", "core"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "rules", "core", "keep.mdc"), "core\n", "utf8");
  process.chdir(root);
  await capture(() => skillsCommand(["import", "--rules", rules]));
  return { root, rules };
}

test("`remove --rule` deletes the imported copy and its registry entry, and prunes the emptied directory", async () => {
  const { root } = await ruleProject();
  const { out } = await capture(() => skillsCommand(["remove", "--rule", "nested/mobx.mdc", "--json"]));
  const parsed = JSON.parse(out) as { ref: string; parts: { part: string; status: string }[] };
  expect(parsed.ref).toBe("nested/mobx.mdc");
  expect(parsed.parts.map((part) => part.status)).not.toContain("absent");
  expect(await pathExists(path.join(root, ".metaproject/rules/project/nested/mobx.mdc"))).toBe(false);
  expect(await pathExists(path.join(root, ".metaproject/rules/project/nested"))).toBe(false);
  expect((await readProjectRuleRegistry(root)).map((entry) => entry.ref)).toEqual(["styling.mdc"]);
  expect(await pathExists(path.join(root, ".metaproject/rules/project/styling.mdc"))).toBe(true);
  expect(await pathExists(path.join(root, ".metaproject/rules/core/keep.mdc"))).toBe(true);
  expect(await pathExists(path.join(root, "vantage-rules/nested/mobx.mdc"))).toBe(true);
});

test("`remove --rule --dry-run` lists what it would remove and changes nothing", async () => {
  const { root } = await ruleProject();
  const { out } = await capture(() => skillsCommand(["remove", "--rule", "styling.mdc", "--dry-run"]));
  expect(out).toContain("would-remove");
  expect(await pathExists(path.join(root, ".metaproject/rules/project/styling.mdc"))).toBe(true);
  expect(await readProjectRuleRegistry(root)).toHaveLength(2);
});

test("removing a linked rule drops the registry entry and leaves the origin file alone", async () => {
  const { root, rules } = await ruleProject();
  await capture(() => skillsCommand(["remove", "--rule", "styling.mdc"]));
  await capture(() => skillsCommand(["remove", "--rule", "nested/mobx.mdc"]));
  await capture(() => skillsCommand(["import", "--rules", rules, "--link"]));
  expect((await readProjectRuleRegistry(root)).every((entry) => entry.mode === "link")).toBe(true);
  await capture(() => skillsCommand(["remove", "--rule", "styling.mdc"]));
  expect((await readProjectRuleRegistry(root)).map((entry) => entry.ref)).toEqual(["nested/mobx.mdc"]);
  expect(await pathExists(path.join(rules, "styling.mdc"))).toBe(true);
});

test("a file under rules/project that was not imported is not deleted", async () => {
  const { root } = await ruleProject();
  await writeFile(path.join(root, ".metaproject/rules/project/hand-written.mdc"), "mine\n", "utf8");
  const { err } = await capture(() => skillsCommand(["remove", "--rule", "hand-written.mdc"]));
  expect(err).toContain("hand-written.mdc");
  expect(process.exitCode).toBe(1);
  expect(await pathExists(path.join(root, ".metaproject/rules/project/hand-written.mdc"))).toBe(true);
});

test("a ref that climbs out of rules/project is refused and rules/core survives", async () => {
  const { root } = await ruleProject();
  const { err } = await capture(() => skillsCommand(["remove", "--rule", "../core/keep.mdc"]));
  expect(err).toContain("keep.mdc");
  expect(process.exitCode).toBe(1);
  expect(await pathExists(path.join(root, ".metaproject/rules/core/keep.mdc"))).toBe(true);
});

test("a registry entry whose path is not its own slot under rules/project deletes nothing", async () => {
  const { root } = await ruleProject();
  const manifestPath = path.join(root, ".metaproject/metaproject.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.modules.gdskills.projectRuleRegistry[0].path = ".metaproject/rules/core/keep.mdc";
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const { err } = await capture(() => skillsCommand(["remove", "--rule", manifest.modules.gdskills.projectRuleRegistry[0].ref]));
  expect(err).toContain("path");
  expect(process.exitCode).toBe(1);
  expect(await pathExists(path.join(root, ".metaproject/rules/core/keep.mdc"))).toBe(true);
});
