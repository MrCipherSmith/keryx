import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createProjectSkill,
  parseProjectSkillCatalogRow,
  PROJECT_SKILLS_CATALOG_EMPTY_ROW,
  projectSkillCatalogRow,
  projectSkillPackagePath,
} from "./project-skills";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

describe("parseProjectSkillCatalogRow (flow 360 review H-011)", () => {
  test("reads back exactly what projectSkillCatalogRow writes", () => {
    const entry = { module: "review", name: "house-api", target: "src/api/*.ts | legacy", path: projectSkillPackagePath("review", "house-api") };
    // A `|` inside the target breaks the table for every reader; the round trip is for the targets that do not.
    const plain = { ...entry, target: "auth flow `IResult`" };

    expect(parseProjectSkillCatalogRow(projectSkillCatalogRow(plain))).toEqual(plain);
    expect(parseProjectSkillCatalogRow(`   ${projectSkillCatalogRow(plain)}  `)).toEqual(plain);
    expect(parseProjectSkillCatalogRow(projectSkillCatalogRow(entry))).toBeUndefined();
  });

  test("a hand-edited row without backticks around the target is still a row", () => {
    expect(parseProjectSkillCatalogRow("| review | x | auth flow | .metaproject/project-skills/review/x/SKILL.md |")).toEqual({
      module: "review",
      name: "x",
      target: "auth flow",
      path: ".metaproject/project-skills/review/x",
    });
  });

  test("the header, the separator, the empty-registry row and prose are not rows", () => {
    for (const line of [
      "| Module | Skill | Target | Entry |",
      "|---|---|---|---|",
      PROJECT_SKILLS_CATALOG_EMPTY_ROW,
      "## Project Skills",
      "",
      "|",
      "| review | x | `t` |",
      "| review | x | `t` | .metaproject/project-skills/review/x/SKILL.md | extra |",
      "|  | x | `t` | .metaproject/project-skills/review/x/SKILL.md |",
      "| review | x | `t` | .metaproject/project-skills/review/x |",
    ]) {
      expect({ line, row: parseProjectSkillCatalogRow(line) }).toEqual({ line, row: undefined });
    }
  });
});

async function makeProjectRoot(opts: { security?: boolean; mode?: "advisory" | "enforced" | "ci" } = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-project-skills-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.security !== undefined) {
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { security: { enabled: opts.security } } }),
      "utf8",
    );
  }
  if (opts.mode) {
    await writeFile(path.join(root, ".metaproject", "security.config.json"), JSON.stringify({ mode: opts.mode }), "utf8");
  }
  return root;
}

describe("createProjectSkill security guard", () => {
  test("writes a real SKILL.md when the security module is not enabled (default)", async () => {
    const root = await makeProjectRoot();
    try {
      const result = await createProjectSkill(root, { target: "src/example.ts", module: "example", name: "widget" });
      expect(result.dryRun).toBe(false);
      const written = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");
      expect(written).toContain("Target: src/example.ts");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to write a skill whose rendered content trips the security gate in enforced mode", async () => {
    const root = await makeProjectRoot({ security: true, mode: "enforced" });
    try {
      await expect(
        createProjectSkill(root, { target: `aws_key = ${AWS_KEY}`, module: "example", name: "leaky" }),
      ).rejects.toThrow(/security gate/);
      // Nothing should have been written — the guard runs before any mkdir/write.
      const exists = await readFile(path.join(root, ".metaproject", "project-skills", "example", "leaky", "SKILL.md"), "utf8").then(
        () => true,
        () => false,
      );
      expect(exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("advisory mode allows the write but persists only the redacted representation", async () => {
    const root = await makeProjectRoot({ security: true, mode: "advisory" });
    try {
      const result = await createProjectSkill(root, { target: `aws_key = ${AWS_KEY}`, module: "example", name: "leaky-advisory" });
      expect(result.dryRun).toBe(false);
      const written = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");
      expect(written).not.toContain(AWS_KEY);
      expect(written).toContain("[REDACTED:secret]");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // AC14 (flow 252, D12): the footer used to assert "Current state: not
  // verified." as a static claim, which `keryx skills verify` immediately
  // contradicts in verification.md once the skill is actually verified. The
  // footer must not assert any status of its own.
  test("the generated SKILL.md footer asserts no verification status of its own", async () => {
    const root = await makeProjectRoot();
    try {
      const result = await createProjectSkill(root, { target: "src/example.ts", module: "example", name: "footer-check" });
      const written = await readFile(path.join(root, result.skillPath, "SKILL.md"), "utf8");
      expect(written).not.toContain("Current state:");
      expect(written).toContain("Verification status: see `verification.md`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("createProjectSkill refuses a destination symlinked out of the project before anything is written", () => {
  // `keryx skills create` checks every destination, and the registry lock,
  // before the first write — so a dry run refuses what the real run would, in
  // the same words, and nothing appears outside the project. Without that
  // preflight the real run created <outside>/gdskills (the lock's parent) and
  // the dry run was not refused at all.
  const cases: { label: string; link: string; setup?: string }[] = [
    { label: ".metaproject/data (the registry lock)", link: ".metaproject/data" },
    { label: ".metaproject/project-skills (the package)", link: ".metaproject/project-skills", setup: ".metaproject/data" },
  ];

  for (const { label, link, setup } of cases) {
    test(`a symlinked ${label}`, async () => {
      const root = await makeProjectRoot();
      const outside = await mkdtemp(path.join(tmpdir(), "keryx-project-skills-outside-"));
      try {
        if (setup) await mkdir(path.join(root, setup), { recursive: true });
        await symlink(outside, path.join(root, link));
        const messages: string[] = [];
        for (const dryRun of [true, false]) {
          try {
            await createProjectSkill(root, { target: "alpha", module: "quality", name: "alpha", format: "single", dryRun });
            messages.push("(no refusal)");
          } catch (error) {
            messages.push(error instanceof Error ? error.message : String(error));
          }
        }
        expect(messages[0]).toBe(messages[1] as string);
        expect(messages[0]).toContain(`refuses to write through a symlink at ${link} that resolves outside the project root`);
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
      }
    });
  }
});

test("createProjectSkill refuses a prose target on the CLI path, not only the wrap-up path", () => {
  // The routable-target guard was added after two prose-target skills reached
  // `main`, and wired into `skill-owner-writer` alone. `keryx skills create` —
  // the path `reviewer-skill-creator` tells agents to use — never called it, so
  // the entry point most likely to be handed a sentence was the unguarded one.
  //
  // `--dry-run` is asserted too: the refusal must come BEFORE any inference or
  // write, otherwise a rejected target could still leave a slug derived from
  // prose behind.
  return (async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-prose-target-"));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });

    const prose = "This is a wrap-up summary, not a target.";
    await expect(createProjectSkill(root, { target: prose, module: "review", name: "prose-test" }))
      .rejects.toThrow(/reads as prose, not a routing key/);
    await expect(createProjectSkill(root, { target: prose, module: "review", name: "prose-test", dryRun: true }))
      .rejects.toThrow(/reads as prose, not a routing key/);

    // And the shapes a target legitimately takes still pass: a concept, a symbol
    // and a path. A guard that rejected these would be excepted on first honest
    // use and then deleted.
    for (const target of ["auth flow", "IResultDqReport", "src/dq/components/DqScoreCard.tsx"]) {
      const result = await createProjectSkill(root, { target, module: "review", name: `ok-${target.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`, dryRun: true });
      expect(result).toBeTruthy();
    }
  })();
});
