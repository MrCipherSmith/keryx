import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectSkill } from "../gdskills/project-skills";
import {
  collectReviewers,
  descriptionFlags,
  descriptionPathTriggers,
  escapeRegexLiteral,
  renderReviewerInventoryMarkdown,
} from "./reviewers";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-reviewers-"));
  await mkdir(path.join(cwd, ".metaproject", "data", "gdskills"), { recursive: true });
  await writeFile(
    path.join(cwd, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: { gdskills: {} } }, null, 2)}\n`,
    "utf8",
  );
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

async function installBundledReviewer(name: string): Promise<void> {
  const dir = path.join(cwd, ".metaproject", "skills", "gdskills", "review", name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`, "utf8");
}

describe("collectReviewers", () => {
  test("a project with no metaproject yields empty halves rather than throwing", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "keryx-reviewers-bare-"));
    try {
      // A review round must not die because the optional half of its reviewer
      // set is absent — which is the common case, since most projects define no
      // reviewers of their own.
      expect(await collectReviewers(bare)).toEqual({ bundled: [], project: [] });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("bundled reviewers come from the INSTALLED tree, sorted", async () => {
    await installBundledReviewer("review-logic");
    await installBundledReviewer("review-architecture");

    const inventory = await collectReviewers(cwd);
    // Installed, not shipped: what a round can dispatch is what this project's
    // profile actually put on disk.
    expect(inventory.bundled.map((reviewer) => reviewer.name)).toEqual(["review-architecture", "review-logic"]);
    expect(inventory.bundled[0]?.path).toBe(".metaproject/skills/gdskills/review/review-architecture");
  });

  test("a directory without a SKILL.md is not a reviewer", async () => {
    await mkdir(path.join(cwd, ".metaproject", "skills", "gdskills", "review", "half-written"), { recursive: true });
    await installBundledReviewer("review-logic");

    // Listing it would dispatch an agent at a file that does not exist.
    expect((await collectReviewers(cwd)).bundled.map((reviewer) => reviewer.name)).toEqual(["review-logic"]);
  });

  test("a project-skill under module `review` is a reviewer, and carries its provenance", async () => {
    const origin = path.join(cwd, "profile.mdc");
    await writeFile(origin, "# strict profile\nrule one\n", "utf8");
    await createProjectSkill(cwd, { target: "review profile", module: "review", name: "house-profile", origin });

    const inventory = await collectReviewers(cwd);
    expect(inventory.project).toHaveLength(1);
    const reviewer = inventory.project[0];
    expect(reviewer?.name).toBe("house-profile");
    expect(reviewer?.path).toBe(".metaproject/project-skills/review/house-profile");
    expect(reviewer?.origin).toBe(origin);
    expect(reviewer?.drift).toBe("clean");
  });

  test("a project-skill under any other module is not a reviewer", async () => {
    await createProjectSkill(cwd, { target: "src/pipelines", module: "pipelines", name: "pipelines-module" });
    expect((await collectReviewers(cwd)).project).toEqual([]);
  });

  // The whole reason provenance is recorded: the source is maintained elsewhere
  // and moves on, and a reviewer built from last month's version reads as
  // current unless something says otherwise.
  test("drift is `changed` once the origin file moves on", async () => {
    const origin = path.join(cwd, "profile.mdc");
    await writeFile(origin, "# strict profile\nrule one\n", "utf8");
    await createProjectSkill(cwd, { target: "review profile", module: "review", name: "house-profile", origin });

    await writeFile(origin, "# strict profile\nrule one\nrule two\n", "utf8");

    const inventory = await collectReviewers(cwd);
    expect(inventory.project[0]?.drift).toBe("changed");
    // Drift is computed, never stored: the recorded hash is the import-time
    // fact, and re-reading is what makes the verdict current.
    expect(inventory.project[0]?.originHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("drift is `missing` when the origin can no longer be read", async () => {
    const origin = path.join(cwd, "profile.mdc");
    await writeFile(origin, "# strict profile\n", "utf8");
    await createProjectSkill(cwd, { target: "review profile", module: "review", name: "house-profile", origin });
    await rm(origin);

    expect((await collectReviewers(cwd)).project[0]?.drift).toBe("missing");
  });

  test("a reviewer written by hand, with no origin, is `none` rather than missing", async () => {
    await createProjectSkill(cwd, { target: "review profile", module: "review", name: "house-profile" });
    // "No source" and "source gone" are different facts and must stay
    // distinguishable — the second is a problem, the first is not.
    expect((await collectReviewers(cwd)).project[0]?.drift).toBe("none");
  });

  test("createProjectSkill refuses an origin it cannot read", async () => {
    await expect(
      createProjectSkill(cwd, {
        target: "review profile",
        module: "review",
        name: "house-profile",
        origin: path.join(cwd, "absent.mdc"),
      }),
    ).rejects.toThrow(/Cannot read the origin file/);
  });
});

describe("renderReviewerInventoryMarkdown", () => {
  test("an empty project half names the command that creates one", async () => {
    await installBundledReviewer("review-logic");
    const rendered = renderReviewerInventoryMarkdown(await collectReviewers(cwd));
    expect(rendered).toContain("project-local: 0");
    expect(rendered).toContain("--module review");
  });

  test("a drifted origin is called out in its own section", async () => {
    const origin = path.join(cwd, "profile.mdc");
    await writeFile(origin, "one\n", "utf8");
    await createProjectSkill(cwd, { target: "review profile", module: "review", name: "house-profile", origin });
    await writeFile(origin, "two\n", "utf8");

    const rendered = renderReviewerInventoryMarkdown(await collectReviewers(cwd));
    expect(rendered).toContain("origins that moved on");
    expect(rendered).toContain("house-profile");
    // A drifted origin is a prompt to look, not a verdict that the reviewer is
    // wrong — the wording has to carry that or it becomes noise people mute.
    expect(rendered).toContain("does not make the reviewer wrong");
  });
});

test("escapeRegexLiteral escapes every regex metacharacter, so a label can never become a pattern", () => {
  // The inlined version this replaced had a character class that closed at its
  // first `]`, making the escape a complete no-op. It was invisible because all
  // three real labels ("Origin", "Origin Hash", "Imported At") need no escaping
  // at all — so this test drives the metacharacters directly rather than through
  // the labels, which is the only way the difference shows.
  for (const meta of [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]) {
    expect(escapeRegexLiteral(meta)).toBe(`\\${meta}`);
  }

  // The property that matters: an escaped literal matches ITSELF and nothing
  // else. Unescaped, `a.b` would match `aXb`.
  const pattern = new RegExp(`^${escapeRegexLiteral("a.b")}$`);
  expect(pattern.test("a.b")).toBe(true);
  expect(pattern.test("aXb")).toBe(false);

  // And the real labels still pass through unchanged, so the fix cannot have
  // altered today's behaviour.
  for (const label of ["Origin", "Origin Hash", "Imported At"]) {
    expect(escapeRegexLiteral(label)).toBe(label);
  }
});

describe("project reviewer triggers", () => {
  async function writeProjectReviewer(name: string, frontmatter: string, body = "# body\n"): Promise<void> {
    const dir = path.join(cwd, ".metaproject", "project-skills", "review", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\n${body}`, "utf8");
  }

  test("globs and flags are read out of a block-scalar description", async () => {
    await writeProjectReviewer(
      "review-house-core",
      "description: |\n  Use when reviewing core changes. Dispatched by house-review for --house-core,\n  --house, --all, or src/core/** changes.\n",
    );
    const [reviewer] = (await collectReviewers(cwd)).project;
    expect(reviewer?.paths).toEqual(["src/core/**"]);
    expect(reviewer?.pathsSource).toBe("description");
    // `--all` selects every reviewer already; listing it would make every one explicit.
    expect(reviewer?.flags).toEqual(["--house-core", "--house"]);
    expect(reviewer?.description).toContain("Use when reviewing core changes.");
  });

  test("metadata.paths wins over the description", async () => {
    await writeProjectReviewer(
      "review-house-ui",
      'description: Reviews src/ui/** changes.\nmetadata:\n  paths: "src/ui/**/*.tsx, src/theme/**"\n  stack_requires: "react"\n',
    );
    const [reviewer] = (await collectReviewers(cwd)).project;
    expect(reviewer?.paths).toEqual(["src/ui/**/*.tsx", "src/theme/**"]);
    expect(reviewer?.pathsSource).toBe("metadata");
    expect(reviewer?.stackRequires).toEqual(["react"]);
  });

  test("a description with no glob gates on nothing, and says so", async () => {
    await writeProjectReviewer("review-house-dates", "description: Reviews date utils and formatters.\n");
    const inventory = await collectReviewers(cwd);
    expect(inventory.project[0]).toMatchObject({ paths: [], pathsSource: "none" });
    expect(renderReviewerInventoryMarkdown(inventory)).toContain("none — dispatched on every round");
  });

  test("cited rules the project lacks are listed per reviewer", async () => {
    await mkdir(path.join(cwd, ".metaproject", "rules", "core"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "rules", "core", "present.mdc"), "x", "utf8");
    await writeProjectReviewer(
      "review-house-rules",
      "description: Reviews things.\n",
      "Standards: `core/present.mdc`, `core/absent.mdc`.\n",
    );
    const inventory = await collectReviewers(cwd);
    expect(inventory.project[0]?.unresolvedRules).toEqual(["core/absent.mdc"]);
    expect(renderReviewerInventoryMarkdown(inventory)).toContain("- review-house-rules: core/absent.mdc");
  });
});

describe("descriptionPathTriggers", () => {
  test("expands an optional suffix and strips list punctuation", () => {
    expect(descriptionPathTriggers("Vantage src/**/*.ts(x) changes, src/**/*.css, src/theme/**.")).toEqual([
      "src/**/*.ts",
      "src/**/*.tsx",
      "src/**/*.css",
      "src/theme/**",
    ]);
  });

  test("prose paths without a glob are not triggers", () => {
    expect(descriptionPathTriggers("rules from src/core/flow/CLAUDE.md and test/e2e changes")).toEqual([]);
  });

  test("descriptionFlags ignores --all", () => {
    expect(descriptionFlags("for --x, --all, or (--y)")).toEqual(["--x", "--y"]);
  });
});
