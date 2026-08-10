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
      "Add or refresh gdwiki pages, then run keryx wiki index and keryx wiki validate.",
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

test("P3: verification consults only canonical current accepted authority, never legacy latest artifacts", async () => {
  const root = await createVerificationProject();
  try {
    await wikiGenerateIndex(root);
    const decisions = path.join(root, ".metaproject", "memory", "decisions");
    const artifacts = path.join(root, ".metaproject", "data", "memory", "artifacts");
    await mkdir(decisions, { recursive: true });
    await mkdir(artifacts, { recursive: true });
    await writeFile(path.join(artifacts, "latest.md"), "legacy query receipt", "utf8");
    await writeFile(
      path.join(decisions, "accepted.md"),
      "# Canonical authority\n\nType: decision\nStatus: accepted\nValid-From: 2026-01-01\n\n## Summary\n\nWiki verification must use this canonical authority.\n\n## Tags\n\n- wiki\n",
      "utf8",
    );
    await writeFile(
      path.join(decisions, "draft.md"),
      "# Draft authority\n\nType: decision\nStatus: draft\n\n## Summary\n\nDo not use this.\n\n## Tags\n\n- wiki\n",
      "utf8",
    );
    await writeFile(
      path.join(decisions, "expired.md"),
      "# Expired authority\n\nType: decision\nStatus: accepted\nValid-To: 2020-01-01\n\n## Summary\n\nDo not use this.\n\n## Tags\n\n- wiki\n",
      "utf8",
    );

    const report = await verifyProjectSkill(root, { input: "wiki/example", dryRun: true });
    const memory = report.signals.find((signal) => signal.name === "evidence:memory-consultation");
    expect(memory?.status).toBe("pass");
    expect(memory?.message).toContain("1 canonical accepted memory entry");
    expect(report.signals.some((signal) => signal.name === "documentation-memory")).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function createVerificationProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-verify-"));
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
