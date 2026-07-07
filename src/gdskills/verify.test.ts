import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { renderWikiPage } from "../wiki/templates";
import { wikiGenerateIndex } from "../wiki/service";
import { verifyProjectSkill } from "./verify";

test("fails gdwiki evidence when wiki index is stale", async () => {
  const root = await createVerificationProject();
  try {
    await writeFile(path.join(root, ".metaproject", "wiki", "index.md"), "# Stale index\n", "utf8");

    const report = await verifyProjectSkill(root, { input: "wiki/example", dryRun: true });
    const gdwiki = report.signals.find((signal) => signal.name === "evidence:gdwiki");

    expect(report.status).toBe("stale");
    expect(gdwiki?.status).toBe("fail");
    expect(gdwiki?.message).toContain("index out of date");
    expect(report.recommendations).toContain(
      "Add or refresh gdwiki pages, then run gd-metapro wiki index and gd-metapro wiki validate.",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes gdwiki evidence when wiki validates", async () => {
  const root = await createVerificationProject();
  try {
    await wikiGenerateIndex(root);

    const report = await verifyProjectSkill(root, { input: "wiki/example", dryRun: true });
    const gdwiki = report.signals.find((signal) => signal.name === "evidence:gdwiki");

    expect(report.status).toBe("fresh");
    expect(gdwiki?.status).toBe("pass");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createVerificationProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-verify-"));
  const packageRoot = path.join(root, ".metaproject", "project-skills", "wiki", "example");
  const pageDir = path.join(root, ".metaproject", "wiki", "architecture");

  await mkdir(packageRoot, { recursive: true });
  await mkdir(pageDir, { recursive: true });
  await mkdir(path.join(root, ".metaproject", "data", "gdskills", "reports"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({
      modules: {
        gdskills: {
          projectSkillRegistry: [
            {
              module: "wiki",
              name: "example",
              target: "wiki-example",
              path: ".metaproject/project-skills/wiki/example",
            },
          ],
        },
      },
    }),
    "utf8",
  );
  await writeFile(
    path.join(packageRoot, "SKILL.md"),
    [
      "# Wiki Example Skill",
      "",
      "Version: 1.0.0",
      "Module: wiki",
      "Target: wiki-example",
      "Last Verified: 2026-07-07T00:00:00.000Z",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(path.join(packageRoot, "skill-changelog.md"), "# Changelog\n", "utf8");
  await writeFile(
    path.join(pageDir, "example.md"),
    renderWikiPage({ title: "Example", type: "architecture" }),
    "utf8",
  );

  return root;
}
