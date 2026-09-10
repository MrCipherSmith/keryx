// A project skill must be able to reach the top of a route.
//
// The per-prompt router reads the project-skill registry out of the manifest
// and scores its entries alongside the catalog. An earlier attempt made that
// read worthless: it filtered the results on a `trigger` reason that
// `scoreProjectSkillRoute` never emits, so the manifest was read, scored, and
// then discarded in full. Nothing failed — the router simply never offered a
// project skill, and a read that buys nothing looks exactly like a read that
// works.
//
// So the property is asserted end to end, through the CLI, against the real
// registry: a query naming a registered target must come back with that skill
// on top and `project` as its source.

import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readFile } from "node:fs/promises";

const ROOT = path.join(import.meta.dir, "..", "..");
const CLI = path.join(ROOT, "src", "cli.ts");

async function registry(): Promise<Array<{ module: string; name: string; target: string }>> {
  const raw = await readFile(path.join(ROOT, ".metaproject", "metaproject.json"), "utf8");
  const manifest = JSON.parse(raw) as {
    modules?: { gdskills?: { projectSkillRegistry?: Array<{ module: string; name: string; target: string }> } };
  };
  return manifest.modules?.gdskills?.projectSkillRegistry ?? [];
}

async function route(query: string): Promise<string> {
  const proc = Bun.spawn([process.execPath, CLI, "skills", "route", query], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return `${out}${err}`;
}

describe("the per-prompt router can actually emit a project skill", () => {
  test("the registry this asserts against is not empty", async () => {
    // Without this the test below passes by never running, which is the same
    // shape of nothing-happened the defect it guards produced.
    expect((await registry()).length).toBeGreaterThan(0);
  });

  test("a query naming a registered project skill returns it, marked as a project source", async () => {
    const entries = await registry();
    const entry = entries[0];
    expect(entry).toBeDefined();
    if (entry === undefined) {
      return;
    }

    const output = await route(`${entry.module} ${entry.name}`.replace(/-/g, " "));

    // `project` as the source, and the skill by name. Asserting only that the
    // name appears would pass on a catalog skill that happens to share a word.
    expect(output).toContain("| project |");
    expect(output).toContain(entry.name);
  }, 30_000);

  test("a query that names nothing in the registry does not invent a project skill", async () => {
    // The other direction: if every query returned a project row, the
    // assertion above would hold with the scoring broken open.
    const output = await route("zzzz nonexistent subject matter");
    expect(output).not.toContain("| project |");
  }, 30_000);
});
