import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { rulesCommand } from "./rules";

test("rules sync imports AGENTS and CLAUDE as high-priority rules", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-rules-"));

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nUse local conventions.\n", "utf8");
    await writeFile(path.join(root, "CLAUDE.md"), "# Claude Rules\n\nPrefer compact context.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          gdskills: { enabled: true },
          health: { enabled: true },
          testing: { enabled: true },
          memory: { enabled: true },
          tasks: { enabled: true },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await rulesCommand(["sync"], root);

    const agents = await readFile(path.join(root, ".metaproject", "rules", "agents-md.md"), "utf8");
    const claude = await readFile(path.join(root, ".metaproject", "rules", "claude-md.md"), "utf8");
    const index = await readFile(path.join(root, ".metaproject", "index.md"), "utf8");
    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      agentEntrypoints: { root: string[] };
    };

    expect(agents).toContain("type: agent-entrypoint-rule");
    expect(agents).toContain("priority: high");
    expect(agents).toContain('source: "AGENTS.md"');
    expect(agents).toContain("Use local conventions.");
    expect(agents).not.toContain("<!-- gd-metapro:index -->");
    expect(claude).toContain('source: "CLAUDE.md"');
    expect(claude).toContain("Prefer compact context.");
    expect(index).toContain("| AGENTS.md | high |");
    expect(index).toContain("| CLAUDE.md | high |");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain("Read [.metaproject/index.md](.metaproject/index.md)");
    expect(manifest.agentEntrypoints.root).toEqual(["AGENTS.md", "CLAUDE.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rules sync creates default AGENTS and CLAUDE entrypoints when none exist", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-rules-empty-"));

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          gdskills: { enabled: true },
          health: { enabled: false },
          testing: { enabled: false },
          memory: { enabled: false },
          tasks: { enabled: false },
        },
      }),
      "utf8",
    );

    await rulesCommand(["sync"], root);

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toContain(".metaproject/index.md");
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain(".metaproject/index.md");
    expect(await readFile(path.join(root, ".metaproject", "rules", "agents-md.md"), "utf8")).toContain("priority: high");
    expect(await readFile(path.join(root, ".metaproject", "rules", "claude-md.md"), "utf8")).toContain("priority: high");
    expect(await readFile(path.join(root, ".metaproject", "index.md"), "utf8")).toContain("| AGENTS.md | high |");
    expect(await readFile(path.join(root, ".metaproject", "index.md"), "utf8")).toContain("| CLAUDE.md | high |");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rules sync creates CLAUDE when only AGENTS exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-rules-claude-"));

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\nUse local conventions.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          gdskills: { enabled: true },
          health: { enabled: false },
          testing: { enabled: false },
          memory: { enabled: false },
          tasks: { enabled: false },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await rulesCommand(["sync"], root);

    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toContain(".metaproject/index.md");
    expect(await readFile(path.join(root, ".metaproject", "rules", "claude-md.md"), "utf8")).toContain('source: "CLAUDE.md"');
    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      agentEntrypoints: { root: string[] };
    };
    expect(manifest.agentEntrypoints.root).toEqual(["AGENTS.md", "CLAUDE.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rules distill splits large CLAUDE into rules, skills, and compact root entrypoint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-rules-distill-"));

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Agent Rules\n\n## Communication\n\nAnswer in Russian.\n", "utf8");
    await writeFile(
      path.join(root, "CLAUDE.md"),
      `# Claude Rules

## Communication

Answer in Russian and keep summaries concise.

## Pipeline Architecture

The project uses TypeScript, React, MobX stores, src/pipelines modules, services, and components.
Follow architecture boundaries and keep stores separate from React views.

## Review Workflow

When reviewing or implementing pipeline changes, use the review orchestrator workflow, verify tests, and analyze affected modules.
`,
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          gdskills: { enabled: true },
          health: { enabled: false },
          testing: { enabled: false },
          memory: { enabled: false },
          tasks: { enabled: false },
        },
        agentEntrypoints: { root: ["AGENTS.md", "CLAUDE.md"] },
      }),
      "utf8",
    );

    await rulesCommand(["distill"], root);

    const claude = await readFile(path.join(root, "CLAUDE.md"), "utf8");
    const index = await readFile(path.join(root, ".metaproject", "index.md"), "utf8");
    const distilledIndex = await readFile(path.join(root, ".metaproject", "rules", "entrypoints", "index.md"), "utf8");
    const projectRule = await readFile(
      path.join(root, ".metaproject", "rules", "entrypoints", "claude-md-pipeline-architecture.md"),
      "utf8",
    );
    const projectSkill = await readFile(
      path.join(root, ".metaproject", "project-skills", "entrypoints", "claude-md-review-workflow", "SKILL.md"),
      "utf8",
    );

    expect(claude).toContain("Answer in Russian");
    expect(claude).toContain(".metaproject/index.md");
    expect(claude).not.toContain("src/pipelines modules");
    expect(index).toContain("distilled-entrypoints");
    expect(index).toContain("entrypoint-distilled-skills");
    expect(distilledIndex).toContain("Pipeline Architecture");
    expect(distilledIndex).toContain("Review Workflow");
    expect(projectRule).toContain("type: distilled-entrypoint-rule");
    expect(projectRule).toContain("src/pipelines modules");
    expect(projectSkill).toContain("name: claude-md-review-workflow");
    expect(projectSkill).toContain("review orchestrator workflow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
