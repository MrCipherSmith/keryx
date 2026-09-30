import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectSkill } from "../gdskills/project-skills";
import { parseSkillFrontmatter } from "../gdskills/skill-frontmatter";
import {
  collectReviewers,
  descriptionFlags,
  descriptionPathTriggers,
  escapeRegexLiteral,
  renderReviewerInventoryMarkdown,
} from "./reviewers";
import { BUNDLED_GDSKILLS } from "../gdskills/catalog";

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
  test("a project with no metaproject yields an empty project half rather than throwing", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "keryx-reviewers-bare-"));
    try {
      // A review round must not die because the optional half of its reviewer
      // set is absent — which is the common case, since most projects define no
      // reviewers of their own.
      //
      // The BUNDLED half is a different story (flow 347 T9): with no
      // `.metaproject/skills/gdskills/review` at all, this falls back to the
      // keryx package's own bundled review skills rather than reading as
      // empty — an empty `bundled` array must mean "nothing found", not
      // "nothing installed".
      const inventory = await collectReviewers(bare);
      expect(inventory.project).toEqual([]);
      expect(inventory.bundledSource).toBe("package");
      expect(inventory.bundled.length).toBeGreaterThan(0);
      expect(inventory.bundled.map((reviewer) => reviewer.name)).toContain("review-orchestrator");
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
  });

  test("a package lookup that finds nothing yields `bundledSource: \"not-found\"` (flow 347 T15 / F-004)", async () => {
    // The synthetic-object test above (F-004's own regression note) covers the
    // pure renderer only. This drives the real fallback path through the
    // injectable `bundledSkillMarkdownPath` dependency, without requiring the
    // keryx package itself to ship zero bundled review skills.
    const inventory = await collectReviewers(cwd, { bundledSkillMarkdownPath: () => undefined });
    expect(inventory.bundledSource).toBe("not-found");
    expect(inventory.bundled).toEqual([]);
  });

  test("an existing but EMPTY project review directory is reported as `project`, not `package`", async () => {
    // A minimal install profile can legitimately install zero review skills.
    // That is a different fact from the directory never having been created,
    // and must not silently fall back to the package's reviewers.
    await mkdir(path.join(cwd, ".metaproject", "skills", "gdskills", "review"), { recursive: true });

    const inventory = await collectReviewers(cwd);
    expect(inventory.bundledSource).toBe("project");
    expect(inventory.bundled).toEqual([]);
  });

  test("the package fallback reads real bundled review skills, sorted, with descriptions", async () => {
    const inventory = await collectReviewers(cwd);
    expect(inventory.bundledSource).toBe("package");
    const names = inventory.bundled.map((reviewer) => reviewer.name);
    const expectedNames = BUNDLED_GDSKILLS.filter((entry) => entry.category === "review")
      .map((entry) => entry.name)
      .sort();
    expect(names).toEqual(expectedNames);
    for (const reviewer of inventory.bundled) {
      expect(reviewer.path).toBe(`src/gdskills/bundled/skills/review/${reviewer.name}`);
      expect(reviewer.description).toBeDefined();
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

  // Flow 347 T9, AC7: a synthetic `not-found` inventory drives the pure
  // renderer directly. The real fallback-to-nothing path (via the injectable
  // `bundledSkillMarkdownPath` dependency, flow 347 T15 / F-004) is covered
  // separately above and, at the command layer, in `review.test.ts`.
  test("a `not-found` bundled source says so in text mode, rather than reading as an ordinary empty list", () => {
    const rendered = renderReviewerInventoryMarkdown({
      bundled: [],
      bundledSource: "not-found",
      project: [],
    });
    expect(rendered).toContain("source: not-found");
    expect(rendered).toContain("not found");
    expect(rendered).not.toContain("none installed");
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

  test("metadata.flags wins over flags named in the description", async () => {
    await writeProjectReviewer(
      "review-house-ui",
      'description: Dispatched for --house-ui, --house, --all, or src/ui/** changes.\nmetadata:\n  flags: "--ui, --all, --house"\n',
    );
    const [reviewer] = (await collectReviewers(cwd)).project;
    // Declared, so the description is not consulted: `--house-ui` is gone.
    // `--all` stays excluded whichever source the list came from.
    expect(reviewer?.flags).toEqual(["--ui", "--house"]);
    // The path gate is a separate field and still falls back to the description.
    expect(reviewer).toMatchObject({ paths: ["src/ui/**"], pathsSource: "description" });
  });

  test("a literal file in the description gates the reviewer; a cited document does not", async () => {
    await writeProjectReviewer("review-house-zone", "description: Rules from docs/zones.md, for src/utils/column-zone.ts changes.\n");
    await writeProjectReviewer("review-house-docs", "description: Rules from src/core/flow/CLAUDE.md and core/reviewing.mdc.\n");
    const inventory = await collectReviewers(cwd);
    expect(inventory.project.map((reviewer) => [reviewer.name, reviewer.paths, reviewer.pathsSource])).toEqual([
      ["review-house-docs", [], "none"],
      ["review-house-zone", ["src/utils/column-zone.ts"], "description"],
    ]);
  });

  test("a flag more than one project reviewer carries is a family flag; a unique one is not", async () => {
    await writeProjectReviewer(
      "review-house-core",
      "description: Dispatched for --house, --house-core, --all, or src/core/** changes.\n",
    );
    await writeProjectReviewer(
      "review-house-styling",
      'description: Dispatched for src/**/*.css changes.\nmetadata:\n  flags: "--house-styling, --house"\n',
    );
    await writeProjectReviewer("review-solo", "description: Dispatched for --solo or src/solo/** changes.\n");
    await writeProjectReviewer("review-plain", "description: Reviews things.\n");

    const inventory = await collectReviewers(cwd);
    expect(inventory.project.map((reviewer) => [reviewer.name, reviewer.flags, reviewer.familyFlags])).toEqual([
      ["review-house-core", ["--house", "--house-core"], ["--house"]],
      // Always present, and empty rather than absent when nothing is shared.
      ["review-plain", [], []],
      ["review-solo", ["--solo"], []],
      ["review-house-styling", ["--house-styling", "--house"], ["--house"]],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));

    const rendered = renderReviewerInventoryMarkdown(inventory);
    expect(rendered).toContain("  - flags: --house, --house-core\n  - family flags: --house — shared with another project reviewer: selects it, stays path-gated");
    // A reviewer with no shared flag gets no family line.
    expect(rendered.match(/family flags:/g)).toHaveLength(2);
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

  test("the unresolved-rules hint names a command a tree import accepts", async () => {
    await writeProjectReviewer("review-house-rules", "description: Reviews things.\n", "Standard: `core/absent.mdc`.\n");
    const rendered = renderReviewerInventoryMarkdown(await collectReviewers(cwd));
    expect(rendered).toContain("keryx review import --from <overlay> --only");
  });

  test("a rule in rules/project shadows the same name in rules/core, and is reported as such", async () => {
    await mkdir(path.join(cwd, ".metaproject", "rules", "core"), { recursive: true });
    // The project slot is keyed on the whole reference: rules/project/core/<name>.
    await mkdir(path.join(cwd, ".metaproject", "rules", "project", "core"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "rules", "core", "store.mdc"), "generic", "utf8");
    await writeFile(path.join(cwd, ".metaproject", "rules", "project", "core", "store.mdc"), "overlay", "utf8");
    // Only in rules/project: keryx ships the name but the project's install lacks it.
    await writeFile(path.join(cwd, ".metaproject", "rules", "project", "core", "only-project.mdc"), "overlay", "utf8");
    await writeFile(path.join(cwd, ".metaproject", "rules", "core", "plain.mdc"), "x", "utf8");
    await writeProjectReviewer(
      "review-house-rules",
      "description: Reviews things.\n",
      "Standards: `core/store.mdc`, `core/only-project.mdc`, `core/plain.mdc`, `core/absent.mdc`.\n",
    );

    const inventory = await collectReviewers(cwd);
    const [reviewer] = inventory.project;
    expect(reviewer?.shadowedRules).toEqual([
      { ref: "core/only-project.mdc", resolved: ".metaproject/rules/project/core/only-project.mdc" },
      { ref: "core/store.mdc", resolved: ".metaproject/rules/project/core/store.mdc" },
    ]);
    expect(reviewer?.unresolvedRules).toEqual(["core/absent.mdc"]);

    const rendered = renderReviewerInventoryMarkdown(inventory);
    expect(rendered).toContain("## rules read from .metaproject/rules/project");
    expect(rendered).toContain("- review-house-rules: `core/store.mdc` → .metaproject/rules/project/core/store.mdc");
    expect(rendered).toContain("`.metaproject/rules/project/<dir>/<name>.mdc` is resolved before `.metaproject/rules/<dir>/<name>.mdc`");
  });

  test("a reviewer with nothing shadowed or dangling carries empty lists and no extra sections", async () => {
    await writeProjectReviewer("review-house-plain", "description: Reviews things.\n");
    const inventory = await collectReviewers(cwd);
    expect(inventory.project[0]).toMatchObject({ shadowedRules: [], unresolvedReferences: [] });
    const rendered = renderReviewerInventoryMarkdown(inventory);
    expect(rendered).not.toContain("## rules read from");
    expect(rendered).not.toContain("## references that do not resolve");
  });

  test("missing skills/ and rules/ files and non-portable rule paths are unresolved references", async () => {
    await mkdir(path.join(cwd, ".metaproject", "skills", "shared"), { recursive: true });
    await writeFile(path.join(cwd, ".metaproject", "skills", "shared", "here.md"), "x", "utf8");
    await writeProjectReviewer(
      "review-house-refs",
      "description: Reviews things.\n",
      [
        "Graph: `skills/shared/graphify-lookup.md`. Present: `skills/shared/here.md`.",
        "Schema: `skills/vantage-review/reviewer-finding.schema.json`. Index: `.metaproject/rules/README.md`.",
        "Rule: `~/.vantage-frontend/rules/core/x.mdc` and `/opt/overlay/rules/core/y.mdc`.",
        "Prose path `src/core/flow/CLAUDE.md` and a rule `core/absent.mdc` are not this list's business.",
        "",
      ].join("\n"),
    );

    const inventory = await collectReviewers(cwd);
    const [reviewer] = inventory.project;
    expect(reviewer?.unresolvedReferences).toEqual([
      { ref: "/opt/overlay/rules/core/y.mdc", reason: "non-portable" },
      { ref: "rules/README.md", reason: "missing" },
      { ref: "skills/shared/graphify-lookup.md", reason: "missing" },
      { ref: "skills/vantage-review/reviewer-finding.schema.json", reason: "missing" },
      { ref: "~/.vantage-frontend/rules/core/x.mdc", reason: "non-portable" },
    ]);
    // An absolute rule path is not a `dir/name.mdc` reference, so it never was in here.
    expect(reviewer?.unresolvedRules).toEqual(["core/absent.mdc"]);

    const rendered = renderReviewerInventoryMarkdown(inventory);
    expect(rendered).toContain("## references that do not resolve");
    expect(rendered).toContain("- review-house-refs: `skills/shared/graphify-lookup.md` — missing (.metaproject/skills/shared/graphify-lookup.md)");
    expect(rendered).toContain("- review-house-refs: `~/.vantage-frontend/rules/core/x.mdc` — non-portable");
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

  test("a literal file path listed beside globs is a trigger", () => {
    // The real description that lost `column-zone.ts`: a reviewer gated on a
    // list where one entry happens to be a single file.
    expect(
      descriptionPathTriggers(
        "Dispatched by vantage-review for --vantage, --vantage-temporal, --all, or changes under " +
          "src/utils/date-*.ts, src/utils/temporal-*.ts, src/utils/column-zone.ts, src/core/formatters/**, " +
          "src/core/view-zone/**, or src/wrappers/ag-grid/**.",
      ),
    ).toEqual([
      "src/utils/date-*.ts",
      "src/utils/temporal-*.ts",
      "src/utils/column-zone.ts",
      "src/core/formatters/**",
      "src/core/view-zone/**",
      "src/wrappers/ag-grid/**",
    ]);
  });

  test("a cited document is not a trigger", () => {
    expect(
      descriptionPathTriggers(
        "performance rules from src/core/flow/CLAUDE.md. Dispatched by vantage-review for --vantage-flow, --all, or src/core/flow/** changes.",
      ),
    ).toEqual(["src/core/flow/**"]);
    expect(descriptionPathTriggers("Reviews stores. Standards: core/reviewing.mdc, `core/mobx-store-template.mdc`.")).toEqual([]);
  });

  test("a literal path takes the same optional suffix and wrapping punctuation as a glob", () => {
    expect(descriptionPathTriggers("changes to (`src/app/routes.ts(x)`), or `.github/workflows/ci.yml`.")).toEqual([
      "src/app/routes.ts",
      "src/app/routes.tsx",
      ".github/workflows/ci.yml",
    ]);
  });

  test("prose that merely contains a slash and a dot is not a trigger", () => {
    for (const prose of [
      "See https://example.com/docs/page.html and http://example.com/a/b.json for details.",
      "Mirrors github.com/acme/overlay.git and www.example.com/guide.html.",
      "Uses acme/overlay and MrCipherSmith/keryx as sources.",
      "Since 0.3.40/0.3.41, v1.2/v1.3 and 2026/09.30.",
      "Names (e.g./i.e. aliases), e.g/i.e, and/or. read/write. client/server.",
      "An absolute /opt/overlay/rules/x.json or ~/.vantage/config.json is not repo-relative.",
      "a=b/c.ts, src//x.ts, ./src/x.ts, ../x.ts",
      // The bundled review-jev-* descriptions: keryx's own config, cited as a precondition.
      "Runs when `review.jev.docs: true` in .metaproject/tasks.config.json and a credential is resolvable.",
      "React/MobX, NestJS/TypeORM, TS/JS, input/output",
    ]) {
      expect({ prose, triggers: descriptionPathTriggers(prose) }).toEqual({ prose, triggers: [] });
    }
  });

  test("the descriptions of the bundled review skills yield no literal-path trigger", async () => {
    const reviewRoot = path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review");
    const literal: Record<string, string[]> = {};
    let read = 0;
    for (const entry of await readdir(reviewRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const content = await readFile(path.join(reviewRoot, entry.name, "SKILL.md"), "utf8").catch(() => undefined);
      if (content === undefined) continue;
      read += 1;
      const description = parseSkillFrontmatter(content).description ?? "";
      const found = descriptionPathTriggers(description).filter((trigger) => !trigger.includes("*"));
      if (found.length > 0) literal[entry.name] = found;
    }
    expect(read).toBeGreaterThan(10);
    expect(literal).toEqual({});
  });

  test("descriptionFlags ignores --all", () => {
    expect(descriptionFlags("for --x, --all, or (--y)")).toEqual(["--x", "--y"]);
  });
});
