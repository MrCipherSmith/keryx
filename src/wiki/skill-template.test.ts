import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";
import { renderGdwikiSkillReadme } from "./templates";

// `.metaproject/skills/gdwiki/SKILL.md` is GENERATED: `keryx init` and
// `keryx update` overwrite it from `renderGdwikiSkillReadme()`. #460 added the
// freshness route by editing the generated file only, so the section survived
// exactly until the next `keryx update` — in this repository and in every
// project that installed it. These two tests make that failure loud instead of
// silent: the first pins the content in the generator, the second pins the
// committed artifact to what the generator produces.

const REPO_ROOT = path.resolve(import.meta.dir, "..", "..");

test("the gdwiki skill routes an agent to freshness before it trusts a page", () => {
  const skill = renderGdwikiSkillReadme();

  expect(skill).toContain("## Before you trust a page: check whether it is current");
  // Both surfaces an agent can actually call, plus the file it can read directly.
  expect(skill).toContain("`wiki_freshness`");
  expect(skill).toContain("keryx wiki freshness");
  expect(skill).toContain(".metaproject/data/wiki/freshness/latest.json");
  // Every category, so a reader is not left to guess what a listing means.
  for (const category of ["stale-reference", "stale-prose", "unknown"]) {
    expect(skill).toContain(category);
  }
  // The one claim the package exists to prevent: an empty finding list read as
  // a clean wiki when the check simply could not run.
  expect(skill).toMatch(/empty finding list[\s\S]*limitations/);
  // Repair belongs to a person; the skill must not invite an agent to stamp it.
  expect(skill).toContain("keryx wiki refresh");
  expect(skill).toContain("keryx wiki verify --page");
});

test("the committed gdwiki SKILL.md is what the generator renders", async () => {
  const committed = await readFile(
    path.join(REPO_ROOT, ".metaproject", "skills", "gdwiki", "SKILL.md"),
    "utf8",
  );

  // Not a formatting check: a difference here means either the file was
  // hand-edited (and the next `keryx update` will erase the edit) or the
  // generator changed without regenerating the workspace. Both are fixed the
  // same way — put the text in `renderGdwikiSkillReadme()`, then run
  // `keryx update`.
  expect(committed).toBe(renderGdwikiSkillReadme());
});
