import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectSkill } from "../gdskills/project-skills";
import { collectReviewers, renderReviewerInventoryMarkdown } from "./reviewers";

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
