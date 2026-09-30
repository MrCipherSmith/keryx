import { access, appendFile, mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { renderMetaprojectGitignoreBlock } from "../lib/metaproject-gitignore";
import { renderGdgraphPostCommitHook } from "../lib/templates";
import { withCwd } from "../lib/test-cwd";
import { RETIRED_RULES } from "../gdskills/retired-rules";
import {
  CTX_GUARD_CLAUDE,
  JEV_EDIT_GUARD_SURFACE,
  LEARNING_OBSERVER_CLAUDE,
  ORIENT_CLAUDE,
  SECURITY_CHECK_INPUT_CLAUDE,
  SECURITY_CHECK_OUTPUT_CLAUDE,
  readInstallState,
  recordSurfaceInstalled,
} from "../integrations/service";
import { ensureMetaprojectReference } from "../rules/agent-entrypoints";
import { defaultEntrypointTargets } from "../rules/entrypoint-targets";
import { isCodexOverrideStale } from "../rules/entrypoint-writers";
import { containFromMetaprojectPath, updateCommand } from "./update";
import { initCommand } from "./init";

// R700-06: throwaway fixture repo helper — mirrors the convention in
// gdgraph-freshness.test.ts. GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM are both
// disabled so a machine-local global git template (e.g. an identity-guard
// pre-commit hook) can never affect this fixture's commits.
function gitForUpdateIdempotency(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  }).toString("utf8");
}

// R700-14: `containFromMetaprojectPath`'s own comment says it bounds
// containment at the LAST `.metaproject` path segment, but it used
// `indexOf` (the FIRST occurrence) — for a path nested under an ancestor
// project's own `.metaproject/` directory, that widened the containment
// root to the outer boundary instead of the inner one intended.
test("containFromMetaprojectPath uses the LAST .metaproject segment, not the first", () => {
  const nested = path.join(
    `${path.sep}a`,
    ".metaproject",
    "x",
    "proj",
    ".metaproject",
    "rules",
    "y",
  );

  const result = containFromMetaprojectPath(nested);

  expect(result.root).toBe(path.join(`${path.sep}a`, ".metaproject", "x", "proj"));
  expect(result.rel).toBe(".metaproject/rules/y");
});

test("containFromMetaprojectPath still resolves a single, non-nested .metaproject segment", () => {
  const single = path.join(`${path.sep}project`, ".metaproject", "rules", "y");

  const result = containFromMetaprojectPath(single);

  expect(result.root).toBe(path.join(`${path.sep}project`));
  expect(result.rel).toBe(".metaproject/rules/y");
});

// Round-1 finding T-001: the retired-rule warning print was tested only at
// the `keryx skills install` call site (skills-install-warnings.test.ts).
// `installGdskills` is also called from `keryx update` (printed by its
// refresh summary) and `keryx init` (see init.test.ts) — a regression that
// silences either print stayed green under the old coverage. These tests
// drive `keryx update` directly.
const retiredFixturesRootForUpdate = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "gdskills",
  "__fixtures__",
  "retired-rules",
);

/** Patches `console.log` to capture every call's stringified arguments. */
function captureUpdateConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function retiredEntryForUpdateOrThrow() {
  const retiredEntry = RETIRED_RULES[0];
  if (!retiredEntry) {
    throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
  }
  return retiredEntry;
}

test("keryx update: a modified retired rule prints a Warnings heading and the warning line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-retired-rules-"));
  try {
    const retiredEntry = retiredEntryForUpdateOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRootForUpdate, retiredEntry.fileName), "utf8");
    const modifiedContent = `${unmodifiedContent}\n<!-- project-local note added after install -->\n`;
    await writeFile(path.join(rulesCore, retiredEntry.fileName), modifiedContent, "utf8");

    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdskills: { enabled: true } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    const { logs, restore } = captureUpdateConsoleLog();
    try {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
    } finally {
      restore();
    }

    expect(await readFile(path.join(rulesCore, retiredEntry.fileName), "utf8")).toBe(modifiedContent);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(true);
    expect(logs.some((line) => line.includes(
      `${retiredEntry.fileName} is no longer shipped by keryx (${retiredEntry.reason}); kept because it differs from every shipped version — delete it, or rename it if you still rely on it`,
    ))).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keryx update: an unmodified retired rule is removed with no Warnings printed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-retired-rules-"));
  try {
    const retiredEntry = retiredEntryForUpdateOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRootForUpdate, retiredEntry.fileName));
    await writeFile(path.join(rulesCore, retiredEntry.fileName), unmodifiedContent);

    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdskills: { enabled: true } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    const { logs, restore } = captureUpdateConsoleLog();
    try {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
    } finally {
      restore();
    }

    expect(existsSync(path.join(rulesCore, retiredEntry.fileName))).toBe(false);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(false);
    expect(logs.some((line) => line.includes("is no longer shipped by keryx"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Round-2 minor: a stale per-runtime build the sweep REMOVES is work that
// succeeded, and every one of them used to print under "Warnings" — ~88 lines
// of it on a project's first update after the identical-copy builds were
// retired, which buries the entries that do need a human. It prints under its
// own heading now, and "Warnings" stays absent when nothing was left behind.
test("keryx update: a removed stale runtime build prints under Notices, not Warnings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-stale-builds-"));
  try {
    // The shape an older install leaves behind: a per-runtime build sitting in
    // an installed skill directory that the current bundle no longer ships.
    const installedSkillDir = path.join(
      root, ".metaproject", "skills", "gdskills", "orchestration", "job-orchestrator",
    );
    await mkdir(installedSkillDir, { recursive: true });
    await writeFile(path.join(installedSkillDir, "SKILL.zed.md"), "# stale build\n", "utf8");

    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdskills: { enabled: true } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    const { logs, restore } = captureUpdateConsoleLog();
    try {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
    } finally {
      restore();
    }

    expect(existsSync(path.join(installedSkillDir, "SKILL.zed.md"))).toBe(false);
    const noticesAt = logs.findIndex((line) => line.includes("Notices"));
    expect(noticesAt).toBeGreaterThan(-1);
    // Reported — under Notices, after that heading — and nowhere near Warnings.
    expect(logs.findIndex((line) => line.includes("SKILL.zed.md was removed")))
      .toBeGreaterThan(noticesAt);
    expect(logs.some((line) => line.includes("Warnings"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes service files without touching data artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-"));
  const graphSummaryPath = path.join(root, ".metaproject", "data", "gdgraph", "artifacts", "summary.md");
  const testingContextPath = path.join(root, ".metaproject", "data", "testing", "context.md");
  const graphSummary = "# sentinel graph summary\n";
  const testingContext = "# sentinel testing context\n";

  try {
    await mkdir(path.dirname(graphSummaryPath), { recursive: true });
    await mkdir(path.dirname(testingContextPath), { recursive: true });
    await writeFile(graphSummaryPath, graphSummary, "utf8");
    await writeFile(testingContextPath, testingContext, "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true },
          gdctx: { enabled: true },
          gdwiki: { enabled: true },
          gdskills: { enabled: true },
          testing: { enabled: true },
          memory: { enabled: true },
          tasks: { enabled: true },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime"]);

    expect(await readFile(path.join(root, ".metaproject", "keryx-dashboard.html"), "utf8")).toContain("Metaproject");
    expect(await readFile(path.join(root, ".metaproject", "core", "gdgraph", "build.ts"), "utf8")).toContain("buildGraph");
    expect(await readFile(path.join(root, ".metaproject", "flows", "README.md"), "utf8")).toContain("Flow");
    expect(await readFile(path.join(root, ".metaproject", "skills", "catalog.md"), "utf8")).toContain("flow-orchestrator");
    // Flow 361: the block (and its flow-orchestrator line) lives in the local targets; AGENTS.md is not written to.
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("flow-orchestrator");
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toContain("flow-orchestrator");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("Use metaproject rules.\n");
    expect(await fileExists(path.join(root, ".metaproject", "data", "gdskills"))).toBe(false);
    expect(await fileExists(path.join(root, ".metaproject", "data", "tasks"))).toBe(false);
    expect(await readFile(graphSummaryPath, "utf8")).toBe(graphSummary);
    expect(await readFile(testingContextPath, "utf8")).toBe(testingContext);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update refreshes generated memory ignore policy without ignoring canonical entries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-memory-policy-"));
  try {
    await mkdir(path.join(root, ".git"), { recursive: true });
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: { memory: { enabled: true } }, agentEntrypoints: { root: ["AGENTS.md"] } }),
      "utf8",
    );
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    const generatedPaths = [
      ".metaproject/data/memory/index/index.json",
      ".metaproject/data/memory/embeddings/index.meta.json",
      ".metaproject/data/memory/artifacts/legacy.json",
      ".metaproject/runtime/memory/search/run/report.md",
      ".metaproject/runtime/memory/tmp/lock",
    ];
    for (const candidate of generatedPaths) {
      const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "--quiet", "--", candidate], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(result.exitCode).toBe(0);
    }
    await writeFile(path.join(root, ".metaproject", "memory.config.json"), "{}\n", "utf8");
    const canonical = Bun.spawnSync([
      "git",
      "check-ignore",
      "--no-index",
      "--quiet",
      "--",
      ".metaproject/memory.config.json",
    ], { cwd: root, stdout: "ignore", stderr: "ignore" });
    expect(canonical.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// R2-F2 regression coverage (update side — see init.test.ts for the matching
// `keryx init` tests, and managed-git-hook.test.ts for the underlying library
// fix). `keryx update` used to ABORT outright when `.git/hooks/post-commit`
// resolved outside the git common dir through a symlink, even for a
// legitimate in-project tracked script. It's now an accepted target.
test("update succeeds, and writes the hook block, when .git/hooks/post-commit links to an in-project tracked script", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-hook-inproject-link-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    const scriptDir = path.join(root, "scripts");
    await mkdir(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, "post-commit");
    await writeFile(scriptPath, "#!/usr/bin/env sh\necho tracked\n", "utf8");
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await symlink(path.join("..", "..", "scripts", "post-commit"), path.join(root, ".git", "hooks", "post-commit"));

    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdgraph: { enabled: true, hooks: { gitPostCommit: true } } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    const { logs, restore } = captureUpdateConsoleLog();
    try {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks"]);
      });
    } finally {
      restore();
    }

    expect(logs.some((line) => line.includes("resolves outside") || line.includes("Escape"))).toBe(false);
    const written = await readFile(scriptPath, "utf8");
    expect(written).toContain("# keryx:gdgraph-post-commit:begin");
    expect(written).toContain(renderGdgraphPostCommitHook().trim());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovers manifest and dashboard for existing metaprojects without metaproject.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-legacy-"));
  const graphStoragePath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl");
  const graphEdgesPath = path.join(root, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl");
  const healthReportPath = path.join(root, ".metaproject", "data", "health", "artifacts", "latest.md");
  const healthJsonPath = path.join(root, ".metaproject", "data", "health", "artifacts", "latest.json");
  const graphStorage = "{\"id\":\"src/a.ts\",\"kind\":\"file\",\"path\":\"src/a.ts\"}\n{\"id\":\"src/b.ts\",\"kind\":\"file\",\"path\":\"src/b.ts\"}\n";
  const graphEdges = "{\"id\":\"edge:1\",\"from\":\"src/a.ts\",\"to\":\"src/b.ts\",\"kind\":\"imports\"}\n";
  const healthReport = "# Code Health: PASS\n";
  const healthJson = JSON.stringify({
    gate: { status: "pass" },
    sources: [{ source: "typescript", status: "available", findings: 0, required: true }],
    metrics: [
      {
        key: "project",
        kind: "project",
        name: "project",
        health_score: 97,
        risk_score: 3,
        findingCounts: { total: 1, byPriority: { P0: 0, P1: 1, P2: 0 } },
      },
      {
        key: "module:src",
        kind: "module",
        name: "src",
        health_score: 91,
        risk_score: 3,
        findingCounts: { total: 1 },
        complexity: { max: 8 },
      },
    ],
  });

  try {
    await mkdir(path.dirname(graphStoragePath), { recursive: true });
    await mkdir(path.dirname(healthReportPath), { recursive: true });
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(root, ".metaproject", "data", "testing"), { recursive: true });
    await mkdir(path.join(root, ".metaproject", "data", "gdctx"), { recursive: true });
    await writeFile(graphStoragePath, graphStorage, "utf8");
    await writeFile(graphEdgesPath, graphEdges, "utf8");
    await writeFile(healthReportPath, healthReport, "utf8");
    await writeFile(healthJsonPath, healthJson, "utf8");
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".git", "hooks", "post-commit"),
      "#!/usr/bin/env sh\n\n# keryx:gdgraph-post-commit:begin\ntrue\n# keryx:gdgraph-post-commit:end\n",
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime", "--no-tasks"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };
    const dashboard = await readFile(path.join(root, ".metaproject", "keryx-dashboard.html"), "utf8");
    const index = await readFile(path.join(root, ".metaproject", "index.md"), "utf8");
    const routing = await readFile(path.join(root, ".metaproject", "routing.md"), "utf8");

    expect(manifest.modules.gdgraph?.enabled).toBe(true);
    expect(manifest.modules.gdctx?.enabled).toBe(true);
    expect(manifest.modules.health?.enabled).toBe(true);
    expect(manifest.modules.testing?.enabled).toBe(true);
    expect(manifest.modules.tasks?.enabled).toBe(false);
    expect(dashboard).toContain("<span class=\"card-name\">gdgraph</span>");
    expect(dashboard).toContain("<span class=\"card-name\">health</span>");
    expect(dashboard).toContain("<h2>Code Health</h2>");
    expect(dashboard).toContain("<b>97</b><span>score</span>");
    expect(dashboard).toContain("<h2>Graph</h2>");
    expect(dashboard).toContain("<b>2</b><span>files</span>");
    expect(dashboard).not.toContain("No modules enabled.");
    await expectDashboardLinksToExist(root, dashboard);
    const postCommitHook = await readFile(path.join(root, ".git", "hooks", "post-commit"), "utf8");
    expect(postCommitHook).toContain("# keryx:metaproject-dashboard-post-commit:begin");
    expect(postCommitHook).toContain("dashboard/service files may be stale");
    expect(postCommitHook).not.toContain("keryx gdgraph build");
    expect(postCommitHook).not.toContain("keryx health run --changed");
    expect(postCommitHook).not.toContain("keryx test analyze");
    expect(postCommitHook).not.toContain("keryx update --skip-runtime >/dev/null");
    expect(postCommitHook).not.toContain("keryx update --skip-runtime --no-tasks");
    // index.md is the compact gate; the module table lives in routing.md beside
    // it. Both are asserted so a split that wrote only one would fail here.
    expect(routing).toContain("| gdgraph |");
    expect(routing).not.toContain("| _none_ | No modules enabled yet | - |");
    expect(index).toContain("routing.md");
    expect(index).toContain("keryx gdgraph affected");
    expect(await readFile(graphStoragePath, "utf8")).toBe(graphStorage);
    expect(await readFile(healthReportPath, "utf8")).toBe(healthReport);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates legacy wiki manifest key to gdwiki", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-wiki-migrate-"));

  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          wiki: { enabled: true },
          gdgraph: { enabled: false },
          tasks: { enabled: false },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime", "--no-tasks"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean } | undefined>;
    };
    const dashboard = await readFile(path.join(root, ".metaproject", "keryx-dashboard.html"), "utf8");

    expect(manifest.modules.gdwiki?.enabled).toBe(true);
    expect(manifest.modules.wiki).toBeUndefined();
    expect(dashboard).toContain("<span class=\"card-name\">gdwiki</span>");
    expect(dashboard).not.toContain("<div class=\"disabled\"><span>gdwiki</span>");
    expect(await fileExists(path.join(root, ".metaproject", "skills", "gdwiki", "SKILL.md"))).toBe(true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preserves existing git hooks and updates keryx managed blocks idempotently", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-hooks-"));
  const hookPath = path.join(root, ".git", "hooks", "post-commit");
  const userHook = [
    "#!/usr/bin/env sh",
    "echo user-defined-hook",
    "",
    "# keryx:gdgraph-post-commit:begin",
    "echo stale-managed-block",
    "# keryx:gdgraph-post-commit:end",
    "",
  ].join("\n");

  try {
    await mkdir(path.dirname(hookPath), { recursive: true });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(hookPath, userHook, "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          gdgraph: { enabled: true, hooks: { gitPostCommit: true } },
          gdskills: { enabled: true, hooks: { gitPostCommit: true } },
          health: { enabled: true, hooks: { gitPostCommit: true } },
          testing: { enabled: true, hooks: { gitPostCommit: true } },
          tasks: { enabled: false },
        },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime", "--no-tasks", "--hooks"]);
    await updateCommand(["--skip-runtime", "--no-tasks", "--hooks"]);

    const hook = await readFile(hookPath, "utf8");
    expect(hook).toContain("#!/usr/bin/env sh");
    expect(hook).toContain("echo user-defined-hook");
    expect(hook).not.toContain("stale-managed-block");
    expect(countOccurrences(hook, "# keryx:gdgraph-post-commit:begin")).toBe(1);
    expect(countOccurrences(hook, "# keryx:gdskills-post-commit:begin")).toBe(1);
    expect(countOccurrences(hook, "# keryx:health-post-commit:begin")).toBe(1);
    expect(countOccurrences(hook, "# keryx:testing-post-commit:begin")).toBe(1);
    expect(countOccurrences(hook, "# keryx:metaproject-dashboard-post-commit:begin")).toBe(1);

    // A replaced block must be the rendered block, byte for byte.
    //
    // The hooks are shell, and shell is full of `$`. These blocks were written
    // with the STRING form of String.replace, which reads `$'`, "$`", `$&` and
    // `$$` in the replacement as substitution patterns rather than literal
    // text. `$'` means "everything after the match", so a hook whose content
    // contained it spliced the rest of the file back in and silently
    // duplicated every managed block below it.
    //
    // That is not hypothetical: adding `(ts|tsx|js|jsx|java|py)$'` to the
    // gdgraph hook's own grep made the gdskills assertion above report 2.
    // Comparing against the renderer catches the whole class, not just the
    // occurrence that happened to be noticed.
    expect(hook).toContain(renderGdgraphPostCommitHook().trim());
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backfills the Task Manager for projects initialized before it existed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-backfill-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    // Pre-tasks manifest: tasks present but disabled, no flow scaffold.
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdgraph: { enabled: true }, tasks: { enabled: false } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };
    expect(manifest.modules.tasks?.enabled).toBe(true);
    expect(await fileExists(path.join(root, ".metaproject", "skills", "flow", "SKILL.md"))).toBe(true);
    expect(await fileExists(path.join(root, ".metaproject", "modules", "tasks.md"))).toBe(true);
    expect(await readFile(path.join(root, ".metaproject", "flows", "README.md"), "utf8")).toContain("Flow");
    // The flow discovery policy is migrated into the entrypoint — since flow
    // 361 the local one, not the tracked AGENTS.md.
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("Metaproject flow skill");
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("flow-orchestrator");
    // Backfill does not create runtime data dirs.
    expect(await fileExists(path.join(root, ".metaproject", "data", "tasks"))).toBe(false);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("respects --no-tasks and does not backfill", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-notasks-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdgraph: { enabled: true }, tasks: { enabled: false } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime", "--no-tasks"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };
    expect(manifest.modules.tasks?.enabled).toBe(false);
    expect(await fileExists(path.join(root, ".metaproject", "skills", "flow", "SKILL.md"))).toBe(false);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain("<!-- keryx:index -->");
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).not.toContain("Metaproject flow skill");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("update removes security hooks that drifted out of the manifest, keeping user + testing content", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-sec-"));
  const prePushPath = path.join(root, ".git", "hooks", "pre-push");
  const settingsPath = path.join(root, ".claude", "settings.json");
  try {
    await mkdir(path.join(root, ".git", "hooks"), { recursive: true });
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await mkdir(path.join(root, ".metaproject"), { recursive: true });

    // Live on-disk security artifacts...
    await writeFile(
      prePushPath,
      [
        "#!/usr/bin/env sh",
        "echo 'user pre-push guard'",
        "",
        "# keryx:testing-pre-push:begin",
        "keryx_testing_pre_push || exit $?",
        "# keryx:testing-pre-push:end",
        "",
        "# keryx:security-pre-push:begin",
        "keryx_security_pre_push || exit $?",
        "# keryx:security-pre-push:end",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      settingsPath,
      `${JSON.stringify(
        {
          hooks: {
            UserPromptSubmit: [
              { hooks: [{ type: "command", command: "user-logger" }] },
              {
                hooks: [
                  {
                    type: "command",
                    command: "keryx security check-input --source untrusted-external",
                  },
                ],
                _keryxManaged: "security-agent-hooks",
              },
            ],
            PreToolUse: [
              {
                matcher: "Write|Edit",
                hooks: [{ type: "command", command: "keryx security check-output" }],
                _keryxManaged: "security-agent-hooks",
              },
            ],
          },
          _keryxManaged: ["security-agent-hooks"],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    // ...but the manifest no longer records security hooks (drift).
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: {
          security: { enabled: true },
          testing: { enabled: true },
        },
        agentEntrypoints: { root: [] },
      }),
      "utf8",
    );

    await withCwd(root, async () => {
    await updateCommand(["--skip-runtime"]);

    const hook = await readFile(prePushPath, "utf8");
    // Security block stripped; testing block + user content preserved.
    expect(hook).not.toContain("security-pre-push");
    expect(hook).toContain("# keryx:testing-pre-push:begin");
    expect(hook).toContain("echo 'user pre-push guard'");

    const settings = await readFile(settingsPath, "utf8");
    expect(settings).not.toContain("security-agent-hooks");
    expect(settings).not.toContain("keryx security check-input");
    expect(settings).toContain("user-logger");
    // Flow 361: the hooks were moved to the local file first, and the drift
    // reconcile removed them there too — not left live in the other file.
    const local = await readFile(path.join(root, ".claude", "settings.local.json"), "utf8").catch(() => "");
    expect(local).not.toContain("security-agent-hooks");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

async function expectDashboardLinksToExist(projectRoot: string, dashboard: string): Promise<void> {
  const metaprojectRoot = path.join(projectRoot, ".metaproject");
  const hrefs = [...dashboard.matchAll(/href="([^"]+)"/g)].flatMap((match) => match[1] ? [match[1]] : []);
  const missing: string[] = [];
  for (const href of hrefs) {
    if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#")) {
      continue;
    }
    if (!(await fileExists(path.join(metaprojectRoot, href)))) {
      missing.push(href);
    }
  }
  expect(missing).toEqual([]);
}

// R700-06: `keryx update --yes` on a committed, unchanged repo used to leave
// ` M .metaproject/metaproject.json` on every run — `applyStandardManifestFields`
// stamped a fresh `updatedAt` unconditionally, and `updateManifestAgentEntrypoints`
// wrote the file even when that timestamp was the only difference. The fix
// skips the write entirely when the rebuilt manifest is equal to what's on
// disk in every field except `updatedAt`. This test proves it end to end: a
// real git fixture, two updates after the manifest is already settled and
// committed, and `git status --porcelain` reports nothing (untracked
// directories a post-commit hook may create, e.g. data/gdgraph or data/wiki,
// are a separate, pre-existing matter and are excluded here with
// `--untracked-files=no`).
test("keryx update: a second update on a committed, unchanged repo makes no tracked-file changes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-idempotent-"));
  try {
    gitForUpdateIdempotency(root, ["init", "-q"]);
    gitForUpdateIdempotency(root, ["config", "user.email", "test@test.com"]);
    gitForUpdateIdempotency(root, ["config", "user.name", "test"]);

    // A real `keryx init` (not a hand-rolled minimal manifest): it already
    // syncs AGENTS.md's routing block into place, so the very first `update`
    // afterward reaches steady state in one pass — a minimal manifest lacking
    // that sync takes an extra update round to converge (the dashboard's
    // embedded docs catch up to the AGENTS.md content a round late), which
    // would make this test assert idempotency a round too early.
    await withCwd(root, async () => {
      await initCommand(["--yes"]);
    });
    gitForUpdateIdempotency(root, ["add", "-A"]);
    gitForUpdateIdempotency(root, ["commit", "-q", "-m", "init"]);

    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime"]);
    });
    gitForUpdateIdempotency(root, ["add", "-A"]);
    gitForUpdateIdempotency(root, ["commit", "-q", "-m", "update1"]);

    const manifestPath = path.join(root, ".metaproject", "metaproject.json");
    const manifestBeforeSecondUpdate = await readFile(manifestPath, "utf8");

    // Second update: nothing changed since the commit above, so this must be
    // a no-op on every tracked file, metaproject.json included.
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime"]);
    });

    const status = gitForUpdateIdempotency(root, ["status", "--porcelain", "--untracked-files=no"]);
    expect(status.trim()).toBe("");

    const manifestAfterSecondUpdate = await readFile(manifestPath, "utf8");
    expect(manifestAfterSecondUpdate).toBe(manifestBeforeSecondUpdate);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// Companion to the idempotency test above: a real module-flag change must
// still bump `updatedAt` (and get written), proving the fix only SKIPS the
// write when nothing but the timestamp would differ — it does not disable
// updates altogether.
test("keryx update: an actual module-flag change still bumps metaproject.json's updatedAt", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-flag-change-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "Use metaproject rules.\n", "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({
        modules: { gdskills: { enabled: true } },
        agentEntrypoints: { root: ["AGENTS.md"] },
      }),
      "utf8",
    );

    const manifestPath = path.join(root, ".metaproject", "metaproject.json");

    // Settle the manifest to the full standard shape first.
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    const settled = JSON.parse(await readFile(manifestPath, "utf8")) as {
      updatedAt: string;
      profiles: unknown;
      modules: { gdskills: { enabled: boolean } };
    };

    // Confirm the fix's no-op path on an unchanged manifest first.
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    const unchanged = JSON.parse(await readFile(manifestPath, "utf8")) as { updatedAt: string };
    expect(unchanged.updatedAt).toBe(settled.updatedAt);

    // Now flip a real module flag directly in the manifest — the next update
    // reads modules.gdskills from disk, so this is a genuine config change,
    // not something the update run itself would produce.
    const flipped = { ...settled, modules: { ...settled.modules, gdskills: { enabled: false } } };
    await writeFile(manifestPath, JSON.stringify(flipped, null, 2), "utf8");

    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
    const afterFlagChange = JSON.parse(await readFile(manifestPath, "utf8")) as {
      updatedAt: string;
      profiles: unknown;
    };

    expect(afterFlagChange.updatedAt).not.toBe(settled.updatedAt);
    expect(afterFlagChange.profiles).not.toEqual(settled.profiles);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// G-5 (flow 356, audit remediation 3): `keryx update` lists agent worktrees
// under `.claude/worktrees/` that are stale (old, merged, clean) and prunes
// them ONLY after confirmation — `--yes` skips the interactive prompt for
// CI. `confirm()` (`src/lib/prompt.ts`) already returns its default (`false`)
// when stdin is not a TTY, which `bun test` never is, so the no-`--yes`
// branch below exercises the real "declined" path rather than a fake one.
test("keryx update --yes prunes a stale, merged, clean worktree under .claude/worktrees/", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-stale-worktree-"));
  try {
    gitForUpdateIdempotency(root, ["init", "-q", "-b", "main"]);
    gitForUpdateIdempotency(root, ["config", "user.email", "test@test.com"]);
    gitForUpdateIdempotency(root, ["config", "user.name", "test"]);
    await writeFile(path.join(root, "README.md"), "root\n", "utf8");
    gitForUpdateIdempotency(root, ["add", "-A"]);
    gitForUpdateIdempotency(root, ["commit", "-q", "-m", "init"]);

    await withCwd(root, async () => {
      await initCommand(["--yes"]);
    });

    const worktreesDir = path.join(root, ".claude", "worktrees");
    await mkdir(worktreesDir, { recursive: true });
    const stalePath = path.join(worktreesDir, "agent-1");
    gitForUpdateIdempotency(root, ["worktree", "add", "-q", "-b", "agent/agent-1", stalePath, "main"]);
    const past = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { utimes } = await import("node:fs/promises");
    await utimes(stalePath, past, past);

    // No --yes: stdin is not a TTY under `bun test`, so `confirm()` declines
    // and the worktree survives.
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime"]);
    });
    expect(existsSync(stalePath)).toBe(true);

    // --yes: skips the prompt and prunes.
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--yes"]);
    });
    expect(existsSync(stalePath)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// ---------------------------------------------------------------------------
// Flow 361: the managed block goes where `agentEntrypoints.root` says, and an
// existing repository is migrated off its tracked team files. Every fixture
// below is a real temp git repository (or, for the fallback, deliberately not
// one); `keryx update` is run as the command, not as its parts.
// ---------------------------------------------------------------------------

const ENTRY_FORM_DEFAULT = { root: defaultEntrypointTargets().root, claudeSettings: defaultEntrypointTargets().claudeSettings };
const LOCAL_CODEX = { runtime: "codex", path: "AGENTS.override.md", scope: "local", mode: "override", source: "AGENTS.md" };
const LOCAL_CLAUDE = { runtime: "claude", path: "CLAUDE.local.md", scope: "local" };
const BLOCK_START = "<!-- keryx:index -->";

/** A committed repository: `files` plus a manifest holding `agentEntrypoints` (omitted when `undefined`). */
async function entrypointFixture(
  prefix: string,
  files: Record<string, string>,
  agentEntrypoints: unknown,
  options: { git?: boolean } = {},
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    await writeFile(path.join(root, rel), content, "utf8");
  }
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    `${JSON.stringify({ modules: {}, ...(agentEntrypoints === undefined ? {} : { agentEntrypoints }) }, null, 2)}\n`,
    "utf8",
  );
  if (options.git !== false) {
    gitForUpdateIdempotency(root, ["init", "-q"]);
    gitForUpdateIdempotency(root, ["config", "user.email", "test@test.com"]);
    gitForUpdateIdempotency(root, ["config", "user.name", "test"]);
    gitForUpdateIdempotency(root, ["add", "-A"]);
    gitForUpdateIdempotency(root, ["commit", "-q", "-m", "fixture"]);
  }
  return root;
}

/** Runs `keryx update` in `root` and returns everything it printed. */
async function runEntrypointUpdate(root: string): Promise<string> {
  const { logs, restore } = captureUpdateConsoleLog();
  try {
    await withCwd(root, async () => {
      await updateCommand(["--skip-runtime", "--no-tasks"]);
    });
  } finally {
    restore();
  }
  return logs.join("\n");
}

/** The managed block as an older keryx left it in a tracked file: inserted, then refreshed (padding, then blank-line collapsing). */
async function writeLegacyBlockInto(root: string, rel: string): Promise<void> {
  await ensureMetaprojectReference(path.join(root, rel), { enableTasks: true, root });
  await ensureMetaprojectReference(path.join(root, rel), { enableTasks: false, root });
}

/**
 * Brings the fixture to what a repository an older keryx maintained looks
 * like: service files already generated, the manifest still holding the
 * legacy string array, no local target yet. The first `update` over a
 * hand-rolled manifest always takes a second round to settle the dashboard
 * (it embeds docs that the same run is about to write — see the R700-06 test
 * above), which has nothing to do with entrypoints; settling first keeps the
 * "second update changes no file" assertions about the migration alone.
 */
async function settleAsLegacyRepository(root: string, legacyRoot: string[]): Promise<void> {
  await runEntrypointUpdate(root);
  const manifestPath = path.join(root, ".metaproject", "metaproject.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.agentEntrypoints = { root: legacyRoot, metaproject: ".metaproject/index.md" };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rm(path.join(root, "CLAUDE.local.md"), { force: true });
  await rm(path.join(root, "AGENTS.override.md"), { force: true });
}

function diffIsQuiet(root: string, rel: string): boolean {
  return Bun.spawnSync(["git", "diff", "--quiet", "--", rel], { cwd: root }).exitCode === 0;
}

async function readEntrypointsManifest(root: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
    agentEntrypoints: Record<string, unknown>;
  };
  return manifest.agentEntrypoints;
}

/**
 * Every file under `root`, as path → sha256 of its bytes. Left out: `.git`,
 * and `.metaproject/runtime/` — the install journal there is a gitignored
 * run record that carries each run's timestamps by design.
 */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const rel = path.relative(root, absolute).split(path.sep).join("/");
    if (rel.startsWith(".git/") || rel.startsWith(".metaproject/runtime/")) continue;
    snapshot[rel] = createHash("sha256").update(await readFile(absolute)).digest("hex");
  }
  return snapshot;
}

test("flow 361: one update migrates a legacy repository off its tracked entrypoints, and a second changes no file", async () => {
  const agents = "# Team\n\nUse metaproject rules.\n";
  const claude = "# Claude\nPrefer compact context.\n";
  const root = await entrypointFixture("keryx-update-entry-migrate-", { "AGENTS.md": agents, "CLAUDE.md": claude }, { root: ["AGENTS.md", "CLAUDE.md"] });
  try {
    await settleAsLegacyRepository(root, ["AGENTS.md", "CLAUDE.md"]);
    await writeLegacyBlockInto(root, "AGENTS.md");
    await writeLegacyBlockInto(root, "CLAUDE.md");
    expect(diffIsQuiet(root, "AGENTS.md")).toBe(false);
    // A plain strip does not get back to HEAD: that is why the file is restored.
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).not.toBe(claude);

    const output = await runEntrypointUpdate(root);

    expect(diffIsQuiet(root, "AGENTS.md")).toBe(true);
    expect(diffIsQuiet(root, "CLAUDE.md")).toBe(true);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(claude);
    const status = gitForUpdateIdempotency(root, ["status", "--porcelain"]);
    expect(status).not.toMatch(/ AGENTS\.md$/m);
    expect(status).not.toMatch(/ CLAUDE\.md$/m);
    expect(output).toContain("AGENTS.md: moved the managed keryx block");

    // The block exists only in the local targets.
    const localClaude = await readFile(path.join(root, "CLAUDE.local.md"), "utf8");
    expect(countOccurrences(localClaude, BLOCK_START)).toBe(1);
    expect(localClaude.split("\n")).not.toContain("@AGENTS.md");
    const override = await readFile(path.join(root, "AGENTS.override.md"), "utf8");
    expect(countOccurrences(override, BLOCK_START)).toBe(1);
    expect(override).toContain(agents);

    // AC1: the legacy string array was rewritten to the entry form.
    const entrypoints = await readEntrypointsManifest(root);
    expect(entrypoints.root).toEqual([LOCAL_CODEX, LOCAL_CLAUDE]);
    expect(entrypoints.claudeSettings).toEqual({ path: ".claude/settings.local.json", scope: "local" });

    const afterFirst = await snapshotTree(root);
    await runEntrypointUpdate(root);
    expect(await snapshotTree(root)).toEqual(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: update --preview names where the index block would move and writes nothing", async () => {
  const agents = "# Team\n\nUse metaproject rules.\n";
  const root = await entrypointFixture("keryx-update-entry-preview-", { "AGENTS.md": agents, "CLAUDE.md": "# Claude\n" }, { root: ["AGENTS.md", "CLAUDE.md"] });
  try {
    await settleAsLegacyRepository(root, ["AGENTS.md", "CLAUDE.md"]);
    await writeLegacyBlockInto(root, "AGENTS.md");
    const before = await snapshotTree(root);
    const { logs, restore } = captureUpdateConsoleLog();
    try {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks", "--preview"]);
      });
    } finally {
      restore();
    }
    const output = logs.join("\n");

    expect(output).toContain("AGENTS.md: the managed keryx block would be taken out");
    expect(output).toContain("CLAUDE.local.md: would be created with the managed keryx block");
    expect(output).toContain("AGENTS.override.md: would be generated from AGENTS.md");
    expect(output).not.toContain("CLAUDE.md: the managed keryx block would be taken out");
    expect(await snapshotTree(root)).toEqual(before);
    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

/** A hand edit of `metaproject.json`: `runtime`'s root entry set to `entry`. */
async function switchRootEntry(root: string, runtime: string, entry: Record<string, unknown>): Promise<void> {
  const manifestPath = path.join(root, ".metaproject", "metaproject.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { agentEntrypoints: { root: Array<{ runtime: string }> } };
  manifest.agentEntrypoints.root = manifest.agentEntrypoints.root.map((item) => (item.runtime === runtime ? { runtime, ...entry } : item));
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

test("flow 361 T12: Claude switched back to shared — a keryx-only CLAUDE.local.md is removed, the block is in CLAUDE.md once, and a second update changes no file", async () => {
  const root = await entrypointFixture("keryx-update-entry-back-claude-", { "AGENTS.md": "# Team\n\nUse metaproject rules.\n" }, ENTRY_FORM_DEFAULT);
  try {
    await runEntrypointUpdate(root);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain(BLOCK_START);
    await switchRootEntry(root, "claude", { path: "CLAUDE.md", scope: "shared" });

    const output = await runEntrypointUpdate(root);

    expect(existsSync(path.join(root, "CLAUDE.local.md"))).toBe(false);
    expect(countOccurrences(await readFile(path.join(root, "CLAUDE.md"), "utf8"), BLOCK_START)).toBe(1);
    expect(output).toContain("CLAUDE.local.md: removed the file");

    const afterFirst = await snapshotTree(root);
    await runEntrypointUpdate(root);
    expect(await snapshotTree(root)).toEqual(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361 T12: Claude switched back to shared — the developer's own CLAUDE.local.md keeps their content byte for byte and stays out of git status", async () => {
  const mine = "# My notes\n\nMy sandbox URL is http://localhost:4000.\n";
  const root = await entrypointFixture("keryx-update-entry-back-mine-", { "AGENTS.md": "# Team\n\nUse metaproject rules.\n" }, ENTRY_FORM_DEFAULT);
  try {
    await writeFile(path.join(root, "CLAUDE.local.md"), mine, "utf8");
    await runEntrypointUpdate(root);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain(BLOCK_START);
    await switchRootEntry(root, "claude", { path: "CLAUDE.md", scope: "shared" });

    const output = await runEntrypointUpdate(root);

    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toBe(mine);
    expect(output).toContain("CLAUDE.local.md: removed the managed keryx block");
    expect(gitForUpdateIdempotency(root, ["status", "--porcelain"])).not.toContain("CLAUDE.local.md");

    const afterFirst = await snapshotTree(root);
    await runEntrypointUpdate(root);
    expect(await snapshotTree(root)).toEqual(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361 T12: Codex switched back to shared — the keryx-generated AGENTS.override.md is removed and the block is in AGENTS.md", async () => {
  const root = await entrypointFixture("keryx-update-entry-back-codex-", { "AGENTS.md": "# Team\n\nUse metaproject rules.\n" }, ENTRY_FORM_DEFAULT);
  try {
    await runEntrypointUpdate(root);
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(true);
    await switchRootEntry(root, "codex", { path: "AGENTS.md", scope: "shared" });

    const output = await runEntrypointUpdate(root);

    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(countOccurrences(await readFile(path.join(root, "AGENTS.md"), "utf8"), BLOCK_START)).toBe(1);
    expect(output).toContain("AGENTS.override.md: removed");

    const afterFirst = await snapshotTree(root);
    await runEntrypointUpdate(root);
    expect(await snapshotTree(root)).toEqual(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361 T12: update --preview after a switch back to shared says what would be removed and removes nothing", async () => {
  const root = await entrypointFixture("keryx-update-entry-back-preview-", { "AGENTS.md": "# Team\n\nUse metaproject rules.\n" }, ENTRY_FORM_DEFAULT);
  try {
    await runEntrypointUpdate(root);
    await switchRootEntry(root, "claude", { path: "CLAUDE.md", scope: "shared" });
    await switchRootEntry(root, "codex", { path: "AGENTS.md", scope: "shared" });
    const before = await snapshotTree(root);
    const { logs, restore } = captureUpdateConsoleLog();
    try {
      await withCwd(root, async () => {
        await updateCommand(["--skip-runtime", "--no-tasks", "--preview"]);
      });
    } finally {
      restore();
    }
    const output = logs.join("\n");

    expect(output).toContain("CLAUDE.local.md: would be removed");
    expect(output).toContain("AGENTS.override.md: would be removed");
    expect(await snapshotTree(root)).toEqual(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: a tracked file with the block plus unrelated edits loses only the block and is named", async () => {
  const agents = "# Team\n\nUse metaproject rules.\n\n## Build\n\nRun the suite.\n";
  const root = await entrypointFixture("keryx-update-entry-edits-", { "AGENTS.md": agents }, { root: ["AGENTS.md"] });
  try {
    await writeLegacyBlockInto(root, "AGENTS.md");
    const withBlock = await readFile(path.join(root, "AGENTS.md"), "utf8");
    await writeFile(path.join(root, "AGENTS.md"), withBlock.replace("Run the suite.", "Run the suite twice.\t \n\n\nMy uncommitted note."), "utf8");

    const output = await runEntrypointUpdate(root);

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(
      "# Team\n\nUse metaproject rules.\n\n## Build\n\nRun the suite twice.\t \n\n\nMy uncommitted note.\n",
    );
    expect(output).toContain("AGENTS.md: removed the managed keryx block; your other uncommitted edits in AGENTS.md are kept");
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toContain("My uncommitted note.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: a block committed in HEAD keeps its entry shared, the file untouched, and says how to switch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-update-entry-head-"));
  try {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), "# Team\n\nUse metaproject rules.\n", "utf8");
    await ensureMetaprojectReference(path.join(root, "AGENTS.md"), { enableTasks: false, root });
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      JSON.stringify({ modules: {}, agentEntrypoints: { root: ["AGENTS.md"] } }),
      "utf8",
    );
    gitForUpdateIdempotency(root, ["init", "-q"]);
    gitForUpdateIdempotency(root, ["config", "user.email", "test@test.com"]);
    gitForUpdateIdempotency(root, ["config", "user.name", "test"]);
    gitForUpdateIdempotency(root, ["add", "-A"]);
    gitForUpdateIdempotency(root, ["commit", "-q", "-m", "fixture"]);
    const committed = await readFile(path.join(root, "AGENTS.md"));
    await settleAsLegacyRepository(root, ["AGENTS.md"]);

    const output = await runEntrypointUpdate(root);

    expect((await readFile(path.join(root, "AGENTS.md"))).equals(committed)).toBe(true);
    expect(diffIsQuiet(root, "AGENTS.md")).toBe(true);
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
    expect((await readEntrypointsManifest(root)).root).toEqual([{ runtime: "codex", path: "AGENTS.md", scope: "shared" }, LOCAL_CLAUDE]);
    expect(output).toContain("AGENTS.md: the managed keryx block is committed in HEAD");
    expect(output).toContain('scope to "local"');
    expect(output).toContain("keryx update");
    // H1: CLAUDE.local.md would stop Claude Code's AGENTS.md fallback, so it imports the team file.
    expect((await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).split("\n")).toContain("@AGENTS.md");

    const afterFirst = await snapshotTree(root);
    const second = await runEntrypointUpdate(root);
    expect(await snapshotTree(root)).toEqual(afterFirst);
    expect(second).not.toContain("committed in HEAD");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: Codex override carries the full AGENTS.md plus the block and is regenerated after AGENTS.md changes", async () => {
  const agents = "# Team\n\nUse metaproject rules.\n";
  const root = await entrypointFixture("keryx-update-entry-override-", { "AGENTS.md": agents, "CLAUDE.md": "# Claude\n" }, ENTRY_FORM_DEFAULT);
  try {
    await runEntrypointUpdate(root);
    const first = await readFile(path.join(root, "AGENTS.override.md"), "utf8");
    expect(first).toMatch(/^<!-- keryx:override source="AGENTS\.md" sha256=[0-9a-f]{64} /);
    expect(countOccurrences(first, BLOCK_START)).toBe(1);
    expect(first.endsWith(agents)).toBe(true);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents);

    const revised = `${agents}\n## New section\n\nAdded upstream.\n`;
    await writeFile(path.join(root, "AGENTS.md"), revised, "utf8");
    expect(await isCodexOverrideStale(root, LOCAL_CODEX)).toBe(true);

    await runEntrypointUpdate(root);
    const second = await readFile(path.join(root, "AGENTS.override.md"), "utf8");
    expect(second.endsWith(revised)).toBe(true);
    expect(countOccurrences(second, BLOCK_START)).toBe(1);
    expect(await isCodexOverrideStale(root, LOCAL_CODEX)).toBe(false);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(revised);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: with no AGENTS.md Codex is skipped with a message and no tracked entrypoint is created", async () => {
  const root = await entrypointFixture("keryx-update-entry-absent-", { "README.md": "readme\n" }, ENTRY_FORM_DEFAULT);
  try {
    const output = await runEntrypointUpdate(root);

    expect(existsSync(path.join(root, "AGENTS.md"))).toBe(false);
    expect(existsSync(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain(BLOCK_START);
    expect(output).toContain("Codex: skipped");
    expect(output).toContain("AGENTS.md does not exist");
    expect(output).toContain('scope to "shared"');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: Codex mode skip writes and modifies no Codex file and says so", async () => {
  const agents = "# Team\n\nUse metaproject rules.\n";
  const skip = { ...LOCAL_CODEX, mode: "skip" };
  const root = await entrypointFixture(
    "keryx-update-entry-skip-",
    { "AGENTS.md": agents },
    { root: [LOCAL_CLAUDE, skip], claudeSettings: ENTRY_FORM_DEFAULT.claudeSettings },
  );
  try {
    const output = await runEntrypointUpdate(root);

    expect(existsSync(path.join(root, "AGENTS.override.md"))).toBe(false);
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents);
    expect(diffIsQuiet(root, "AGENTS.md")).toBe(true);
    expect(output).toContain("Codex: skipped");
    expect(output).toContain('mode "skip"');
    expect((await readEntrypointsManifest(root)).root).toEqual([LOCAL_CLAUDE, skip]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: a custom root file named by a legacy manifest is still imported as a rule source", async () => {
  const team = "# Team conventions\n\nPrefer small modules.\n";
  const root = await entrypointFixture(
    "keryx-update-entry-custom-",
    { "AGENTS.md": "# Team\n\nUse metaproject rules.\n", "TEAM.md": team },
    { root: ["AGENTS.md", "TEAM.md"] },
  );
  try {
    await runEntrypointUpdate(root);

    const imported = await readFile(path.join(root, ".metaproject", "rules", "team-md.md"), "utf8");
    expect(imported).toContain('source: "TEAM.md"');
    expect(imported).toContain("Prefer small modules.");
    expect(await readFile(path.join(root, ".metaproject", "routing.md"), "utf8")).toContain("| TEAM.md | high |");
    expect(await readFile(path.join(root, "TEAM.md"), "utf8")).toBe(team);
    const entrypoints = await readEntrypointsManifest(root);
    expect(entrypoints.importSources).toEqual(["TEAM.md"]);
    expect(entrypoints.root).toEqual([LOCAL_CODEX, LOCAL_CLAUDE]);

    // It stays an import source once the manifest is in entry form.
    await appendFile(path.join(root, "TEAM.md"), "\nAnd short functions.\n", "utf8");
    await runEntrypointUpdate(root);
    expect(await readFile(path.join(root, ".metaproject", "rules", "team-md.md"), "utf8")).toContain("And short functions.");
    expect((await readEntrypointsManifest(root)).importSources).toEqual(["TEAM.md"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: outside a git repository the local targets are written and the team file is strip-only, with a note", async () => {
  const agents = "# Team\n\nUse metaproject rules.\n";
  const root = await entrypointFixture("keryx-update-entry-nogit-", { "AGENTS.md": agents }, { root: ["AGENTS.md"] }, { git: false });
  try {
    await settleAsLegacyRepository(root, ["AGENTS.md"]);
    await writeLegacyBlockInto(root, "AGENTS.md");

    const output = await runEntrypointUpdate(root);

    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain(BLOCK_START);
    expect(await readFile(path.join(root, "AGENTS.override.md"), "utf8")).toContain(agents);
    expect(output).toContain("AGENTS.md: removed the managed keryx block. Not a git repository");
    expect((await readEntrypointsManifest(root)).root).toEqual([LOCAL_CODEX, LOCAL_CLAUDE]);

    const afterFirst = await snapshotTree(root);
    await runEntrypointUpdate(root);
    expect(await snapshotTree(root)).toEqual(afterFirst);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test("flow 361: an entry-form local manifest whose tracked file still carries a block is migrated by the same path", async () => {
  const claude = "# Claude\n\nPrefer compact context.\n";
  const root = await entrypointFixture("keryx-update-entry-entryform-", { "AGENTS.md": "# Team\n", "CLAUDE.md": claude }, ENTRY_FORM_DEFAULT);
  try {
    await writeLegacyBlockInto(root, "CLAUDE.md");
    expect(diffIsQuiet(root, "CLAUDE.md")).toBe(false);

    await runEntrypointUpdate(root);

    expect(diffIsQuiet(root, "CLAUDE.md")).toBe(true);
    expect(await readFile(path.join(root, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(await readFile(path.join(root, "CLAUDE.local.md"), "utf8")).toContain(BLOCK_START);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

// Flow 361 T7: `keryx update` never writes the tracked `.gitignore`. The
// managed ignore block goes to `<git-common-dir>/info/exclude`, and a block
// an older keryx left in `.gitignore` is moved out by the same three cases as
// the index block.
describe("flow 361: ignore rules go to info/exclude", () => {
  const LOCAL_TARGETS = ["CLAUDE.local.md", "AGENTS.override.md", ".claude/settings.local.json"];
  /** The block exactly as the pre-361 writer appended it to `.gitignore`. */
  const LEGACY_IGNORE_BLOCK = `# keryx:begin\n${renderMetaprojectGitignoreBlock().trim()}\n# keryx:end`;
  const AGENTS = "# Team\n\nUse metaproject rules.\n";

  /**
   * An `entrypointFixture` whose `core.excludesFile` points at a file that
   * does not exist, so the developer's own global excludes (Claude Code adds
   * `.claude/settings.local.json` there) cannot answer for the fixture.
   */
  async function ignoreFixture(prefix: string, files: Record<string, string>): Promise<string> {
    const root = await entrypointFixture(prefix, files, ENTRY_FORM_DEFAULT);
    gitForUpdateIdempotency(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
    return root;
  }

  function checkIgnore(root: string, target: string): number | null {
    return Bun.spawnSync(["git", "check-ignore", "-q", "--", target], { cwd: root, stdout: "ignore", stderr: "ignore" }).exitCode;
  }

  async function readExclude(root: string): Promise<string> {
    return readFile(path.join(root, ".git", "info", "exclude"), "utf8").catch(() => "");
  }

  function managedLines(exclude: string): string[] {
    const match = /^# keryx:begin\n([\s\S]*?)^# keryx:end$/m.exec(exclude);
    return match === null ? [] : (match[1] ?? "").split("\n").filter((line) => line.length > 0);
  }

  /**
   * A repository an older keryx maintained: service files generated, and the
   * ignore block sitting in `.gitignore` as an uncommitted edit instead of in
   * `info/exclude` (which the settling run wrote, so it is emptied again).
   */
  async function legacyIgnoreFixture(prefix: string, committedGitignore: string, workingGitignore: string): Promise<string> {
    const root = await ignoreFixture(prefix, { "AGENTS.md": AGENTS, ".gitignore": committedGitignore });
    await runEntrypointUpdate(root);
    await writeFile(path.join(root, ".git", "info", "exclude"), "", "utf8");
    await writeFile(path.join(root, ".gitignore"), workingGitignore, "utf8");
    return root;
  }

  test("one update moves an uncommitted legacy block out of .gitignore, and a second changes no file (AC8)", async () => {
    const root = await legacyIgnoreFixture("keryx-update-ignore-migrate-", "node_modules/\n", `node_modules/\n\n${LEGACY_IGNORE_BLOCK}\n`);
    try {
      expect(diffIsQuiet(root, ".gitignore")).toBe(false);

      const output = await runEntrypointUpdate(root);

      expect(diffIsQuiet(root, ".gitignore")).toBe(true);
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\n");
      expect(output).toContain(".gitignore: moved the managed keryx ignore block");
      const status = gitForUpdateIdempotency(root, ["status", "--porcelain"]);
      expect(status).not.toContain(".gitignore");
      const exclude = await readExclude(root);
      expect(managedLines(exclude)).toContain(".metaproject/runtime/");
      for (const target of LOCAL_TARGETS) {
        expect(managedLines(exclude)).toContain(target);
        expect(checkIgnore(root, target)).toBe(0);
      }

      const afterFirst = await snapshotTree(root);
      const second = await runEntrypointUpdate(root);
      expect(await snapshotTree(root)).toEqual(afterFirst);
      expect(await readExclude(root)).toBe(exclude);
      expect(gitForUpdateIdempotency(root, ["status", "--porcelain"])).toBe(status);
      expect(second).not.toContain(".gitignore");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("unrelated uncommitted edits in .gitignore survive byte-for-byte and the file is named (AC9)", async () => {
    const root = await legacyIgnoreFixture(
      "keryx-update-ignore-edits-",
      "node_modules/\n",
      `node_modules/\ndist/\n\n${LEGACY_IGNORE_BLOCK}\n`,
    );
    try {
      const output = await runEntrypointUpdate(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe("node_modules/\ndist/\n");
      expect(output).toContain(".gitignore: removed the managed keryx ignore block");
      expect(output).toContain("your other uncommitted edits in .gitignore are kept");
      expect(managedLines(await readExclude(root))).toContain(".metaproject/runtime/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  // Review round 1, F-005: info/exclude is shared by every worktree, and
  // another worktree's branch may not carry the committed block — so the
  // entries are written there as well; a redundant line is harmless.
  test("a block committed in HEAD stays in .gitignore, and info/exclude still carries every entry", async () => {
    const gitignore = `node_modules/\n\n${LEGACY_IGNORE_BLOCK}\n`;
    const root = await ignoreFixture("keryx-update-ignore-head-", { "AGENTS.md": AGENTS, ".gitignore": gitignore });
    try {
      const output = await runEntrypointUpdate(root);

      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
      expect(diffIsQuiet(root, ".gitignore")).toBe(true);
      expect(output).toContain(".gitignore: the managed keryx ignore block is committed in HEAD");
      const lines = managedLines(await readExclude(root)).filter((line) => !line.startsWith("#"));
      expect(lines).toContain(".metaproject/runtime/");
      expect(lines.slice(-LOCAL_TARGETS.length)).toEqual(LOCAL_TARGETS);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("update writes no ignore block anywhere when .metaproject/ is ignored as a whole (AC6)", async () => {
    const gitignore = `.metaproject/\n${LOCAL_TARGETS.join("\n")}\n`;
    const root = await ignoreFixture("keryx-update-ignore-whole-", { "AGENTS.md": AGENTS, ".gitignore": gitignore });
    try {
      const excludeBefore = await readExclude(root);
      await runEntrypointUpdate(root);

      expect(await readExclude(root)).toBe(excludeBefore);
      expect(excludeBefore).not.toContain("# keryx:begin");
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(gitignore);
      expect(gitForUpdateIdempotency(root, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("from a linked worktree update writes the common dir's info/exclude and no .gitignore (AC6)", async () => {
    const main = await ignoreFixture("keryx-update-ignore-worktree-", { "AGENTS.md": AGENTS });
    const linked = `${main}-linked`;
    try {
      gitForUpdateIdempotency(main, ["worktree", "add", "-q", linked, "-b", "linked-branch"]);

      await runEntrypointUpdate(linked);

      const exclude = await readExclude(main);
      expect(managedLines(exclude)).toContain(".metaproject/runtime/");
      expect(existsSync(path.join(main, ".git", "worktrees", path.basename(linked), "info", "exclude"))).toBe(false);
      expect(existsSync(path.join(linked, ".gitignore"))).toBe(false);
      expect(existsSync(path.join(main, ".gitignore"))).toBe(false);
      expect(gitForUpdateIdempotency(linked, ["status", "--porcelain"])).not.toContain(".gitignore");
      for (const checkout of [main, linked]) {
        for (const target of LOCAL_TARGETS) {
          expect(checkIgnore(checkout, target)).toBe(0);
        }
      }

      await runEntrypointUpdate(linked);
      expect(await readExclude(main)).toBe(exclude);
    } finally {
      await rm(linked, { recursive: true, force: true });
      await rm(main, { recursive: true, force: true });
    }
  }, 120_000);

  test("update --preview neither migrates .gitignore nor writes info/exclude, and says what it would do", async () => {
    const working = `node_modules/\n\n${LEGACY_IGNORE_BLOCK}\n`;
    const root = await legacyIgnoreFixture("keryx-update-ignore-preview-", "node_modules/\n", working);
    try {
      const { logs, restore } = captureUpdateConsoleLog();
      try {
        await withCwd(root, async () => {
          await updateCommand(["--skip-runtime", "--no-tasks", "--preview"]);
        });
      } finally {
        restore();
      }
      const output = logs.join("\n");

      expect(output).toContain(".gitignore: the managed keryx ignore block would move to info/exclude");
      // The entries the .gitignore block covers today are counted as moving,
      // not as "already ignored".
      expect(output).toMatch(/info\/exclude .*would write keryx's managed block \(\d+ entries\)/);
      expect(output).toContain("CLAUDE.local.md, AGENTS.override.md, .claude/settings.local.json");
      expect(await readFile(path.join(root, ".gitignore"), "utf8")).toBe(working);
      expect(await readExclude(root)).toBe("");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("outside a git repository update writes no .gitignore and prints one note", async () => {
    const root = await entrypointFixture("keryx-update-ignore-nogit-", { "AGENTS.md": AGENTS }, ENTRY_FORM_DEFAULT, { git: false });
    try {
      const output = await runEntrypointUpdate(root);

      expect(existsSync(path.join(root, ".gitignore"))).toBe(false);
      expect(output.split("Ignore rules: skipped").length - 1).toBe(1);
      expect(output).toContain("not a git repository");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});

// Flow 361 T8: keryx-managed Claude Code hooks live in the file
// `agentEntrypoints.claudeSettings` names. `keryx update` moves the ones an
// older keryx merged into the tracked `.claude/settings.json` — every surface,
// not only the security pair update itself refreshes.
describe("flow 361: Claude hooks follow agentEntrypoints.claudeSettings", () => {
  const SHARED_SETTINGS = ".claude/settings.json";
  const LOCAL_SETTINGS = ".claude/settings.local.json";
  // Hand formatting a JSON re-serialisation would not reproduce.
  const TEAM_SETTINGS = '{\n    "model": "sonnet",\n    "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "team-audit" } ] } ] }\n}\n';
  const AGENTS = "# Team\n\nUse metaproject rules.\n";
  // Security last: `keryx update` re-merges it on every run, which is where an
  // updated repository's file has settled.
  const EVERY_SURFACE = [
    CTX_GUARD_CLAUDE,
    ORIENT_CLAUDE,
    LEARNING_OBSERVER_CLAUDE,
    JEV_EDIT_GUARD_SURFACE,
    SECURITY_CHECK_INPUT_CLAUDE,
    SECURITY_CHECK_OUTPUT_CLAUDE,
  ];

  /** `base` with every Claude surface merged in, the way an older keryx left them in one tracked file. */
  function withEverySurface(base: string): string {
    let settings = JSON.parse(base) as Record<string, unknown>;
    for (const surface of EVERY_SURFACE) settings = surface.merge!(settings);
    return `${JSON.stringify(settings, null, 2)}\n`;
  }

  /** A committed repository with the security module's agent hook recorded, and `settings` (when given) committed as `.claude/settings.json`. */
  async function hooksFixture(prefix: string, settings: string | undefined, agentEntrypoints: unknown, options: { git?: boolean } = {}): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), prefix));
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, "AGENTS.md"), AGENTS, "utf8");
    if (settings !== undefined) await writeFile(path.join(root, SHARED_SETTINGS), settings, "utf8");
    await writeFile(
      path.join(root, ".metaproject", "metaproject.json"),
      `${JSON.stringify({ modules: { security: { enabled: true, hooks: { agent: SHARED_SETTINGS } } }, agentEntrypoints }, null, 2)}\n`,
      "utf8",
    );
    if (options.git !== false) {
      gitForUpdateIdempotency(root, ["init", "-q"]);
      gitForUpdateIdempotency(root, ["config", "user.email", "test@test.com"]);
      gitForUpdateIdempotency(root, ["config", "user.name", "test"]);
      gitForUpdateIdempotency(root, ["config", "core.excludesFile", path.join(root, ".git", "no-global-excludes")]);
      gitForUpdateIdempotency(root, ["add", "-A"]);
      gitForUpdateIdempotency(root, ["commit", "-q", "-m", "fixture"]);
    }
    return root;
  }

  /**
   * What an older keryx left behind: service files generated, the manifest
   * still legacy and naming the tracked file, install-state naming it too,
   * and every managed hook merged into `.claude/settings.json` as an
   * uncommitted edit on top of `base`.
   */
  async function settleWithLegacyHooks(root: string, base: string): Promise<void> {
    await settleAsLegacyRepository(root, ["AGENTS.md"]);
    await rm(path.join(root, LOCAL_SETTINGS), { force: true });
    await rm(path.join(root, ".metaproject", "data", "integrations"), { recursive: true, force: true });
    for (const [moduleId, surface] of [["ctx-guard", "block"], ["security-check-input", "prompt-gate"], ["security-check-output", "block"]] as const) {
      await recordSurfaceInstalled(root, "claude", { moduleId, surface, writtenPaths: [SHARED_SETTINGS], managedSentinel: true, hashPaths: [] });
    }
    const manifestPath = path.join(root, ".metaproject", "metaproject.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { modules: { security: { hooks: { agent: string } } } };
    manifest.modules.security.hooks.agent = SHARED_SETTINGS;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await writeFile(path.join(root, SHARED_SETTINGS), withEverySurface(base), "utf8");
  }

  type ManagedGroup = { _keryxManaged?: string; hooks?: Array<{ command?: string }> };

  /** `event → command → number of managed groups running it`, over both Claude settings files. */
  async function managedCommandCounts(root: string): Promise<Record<string, Record<string, number>>> {
    const counts: Record<string, Record<string, number>> = {};
    for (const rel of [SHARED_SETTINGS, LOCAL_SETTINGS]) {
      if (!existsSync(path.join(root, rel))) continue;
      const settings = JSON.parse(await readFile(path.join(root, rel), "utf8")) as { hooks?: Record<string, ManagedGroup[]> };
      for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
        for (const group of groups) {
          if (typeof group._keryxManaged !== "string") continue;
          for (const hook of group.hooks ?? []) {
            const byCommand = (counts[event] ??= {});
            byCommand[hook.command ?? ""] = (byCommand[hook.command ?? ""] ?? 0) + 1;
          }
        }
      }
    }
    return counts;
  }

  const EVERY_SURFACE_ONCE = {
    PreToolUse: {
      "keryx ctx hook claude": 1,
      "keryx security check-output --runtime claude": 1,
      "keryx learn observe --hook claude": 1,
    },
    UserPromptSubmit: {
      "keryx orient claude": 1,
      "keryx security check-input --source untrusted-external --runtime claude": 1,
      "keryx learn observe --hook claude": 1,
    },
    PostToolUse: { "keryx learn observe --hook claude": 1, "keryx review jev-edit-guard --hook claude": 1 },
    PostToolUseFailure: { "keryx learn observe --hook claude": 1 },
    SessionStart: { "keryx learn observe --hook claude": 1 },
    Stop: { "keryx learn observe --hook claude": 1 },
    SessionEnd: { "keryx learn observe --hook claude": 1 },
  };

  async function readHookManifest(root: string): Promise<{ agent: unknown; claudeSettings: unknown }> {
    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: { security: { hooks?: { agent?: unknown } } };
      agentEntrypoints: { claudeSettings?: unknown };
    };
    return { agent: manifest.modules.security.hooks?.agent, claudeSettings: manifest.agentEntrypoints.claudeSettings };
  }

  test("one update moves uncommitted managed hooks of every surface to settings.local.json, and a second changes no file (AC5, AC8)", async () => {
    const root = await hooksFixture("keryx-update-hooks-migrate-", TEAM_SETTINGS, { root: ["AGENTS.md"] });
    try {
      await settleWithLegacyHooks(root, TEAM_SETTINGS);
      // A built-in hook the user disabled through `keryx hooks` is recorded in .metaproject/hooks.json.
      const hooksDoc = `${JSON.stringify({ schemaVersion: "1.0.0", _keryxManaged: { tool: "keryx", version: "0.3.40", managedHookIds: ["keryx.learning-observer"] }, hooks: { PostToolUse: [{ id: "keryx.learning-observer", enabled: false }] } }, null, 2)}\n`;
      await writeFile(path.join(root, ".metaproject", "hooks.json"), hooksDoc, "utf8");
      expect(diffIsQuiet(root, SHARED_SETTINGS)).toBe(false);

      const output = await runEntrypointUpdate(root);

      expect(diffIsQuiet(root, SHARED_SETTINGS)).toBe(true);
      expect(await readFile(path.join(root, SHARED_SETTINGS), "utf8")).toBe(TEAM_SETTINGS);
      const status = gitForUpdateIdempotency(root, ["status", "--porcelain"]);
      expect(status).not.toContain(".claude/");
      expect(await managedCommandCounts(root)).toEqual(EVERY_SURFACE_ONCE);
      expect(output).toContain(`${SHARED_SETTINGS}: moved the keryx-managed hooks to ${LOCAL_SETTINGS}; the file is back at HEAD.`);

      // The tracked records name the resolved path.
      expect(await readHookManifest(root)).toEqual({ agent: LOCAL_SETTINGS, claudeSettings: { path: LOCAL_SETTINGS, scope: "local" } });
      const state = await readInstallState(root, "claude");
      expect(state?.installedModules.map((record) => record.writtenPaths)).toEqual([[LOCAL_SETTINGS], [LOCAL_SETTINGS], [LOCAL_SETTINGS]]);
      // The disabled built-in stays disabled: that file is not part of the move.
      expect(await readFile(path.join(root, ".metaproject", "hooks.json"), "utf8")).toBe(hooksDoc);

      const afterFirst = await snapshotTree(root);
      const second = await runEntrypointUpdate(root);
      expect(await snapshotTree(root)).toEqual(afterFirst);
      expect(second).not.toContain("settings.json:");
      expect(await managedCommandCounts(root)).toEqual(EVERY_SURFACE_ONCE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("managed hooks committed in HEAD keep claudeSettings shared, the file untouched, and update says how to switch", async () => {
    const committed = withEverySurface(TEAM_SETTINGS);
    const root = await hooksFixture("keryx-update-hooks-head-", committed, { root: ["AGENTS.md"] });
    try {
      await settleAsLegacyRepository(root, ["AGENTS.md"]);
      expect(existsSync(path.join(root, LOCAL_SETTINGS))).toBe(false);

      const output = await runEntrypointUpdate(root);

      expect(await readFile(path.join(root, SHARED_SETTINGS), "utf8")).toBe(committed);
      expect(diffIsQuiet(root, SHARED_SETTINGS)).toBe(true);
      expect(existsSync(path.join(root, LOCAL_SETTINGS))).toBe(false);
      expect(await readHookManifest(root)).toEqual({ agent: SHARED_SETTINGS, claudeSettings: { path: SHARED_SETTINGS, scope: "shared" } });
      expect(await managedCommandCounts(root)).toEqual(EVERY_SURFACE_ONCE);

      // An entry-form manifest that says local does not override what the team committed.
      const manifestPath = path.join(root, ".metaproject", "metaproject.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { agentEntrypoints: Record<string, unknown> };
      manifest.agentEntrypoints.claudeSettings = { path: LOCAL_SETTINGS, scope: "local" };
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const switched = await runEntrypointUpdate(root);
      expect(switched).toContain(`${SHARED_SETTINGS}: keryx-managed hooks are committed in HEAD`);
      expect(switched).toContain("keryx update");
      expect(await readFile(path.join(root, SHARED_SETTINGS), "utf8")).toBe(committed);
      expect(existsSync(path.join(root, LOCAL_SETTINGS))).toBe(false);
      expect((await readHookManifest(root)).claudeSettings).toEqual({ path: SHARED_SETTINGS, scope: "shared" });
      expect(output).not.toContain("moved the keryx-managed hooks");

      const afterFirst = await snapshotTree(root);
      const second = await runEntrypointUpdate(root);
      expect(await snapshotTree(root)).toEqual(afterFirst);
      expect(second).not.toContain("committed in HEAD");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("unrelated uncommitted keys and hooks in settings.json survive, and the file is named", async () => {
    const root = await hooksFixture("keryx-update-hooks-edits-", TEAM_SETTINGS, { root: ["AGENTS.md"] });
    try {
      const edited = JSON.parse(TEAM_SETTINGS) as { env?: unknown; hooks: Record<string, unknown[]> };
      edited.env = { MY_FLAG: "1" };
      edited.hooks.Stop = [{ hooks: [{ type: "command", command: "my-uncommitted-hook" }] }];
      await settleWithLegacyHooks(root, JSON.stringify(edited));

      const output = await runEntrypointUpdate(root);

      expect(JSON.parse(await readFile(path.join(root, SHARED_SETTINGS), "utf8"))).toEqual(edited);
      expect(await managedCommandCounts(root)).toEqual(EVERY_SURFACE_ONCE);
      expect(output).toContain(`${SHARED_SETTINGS}: removed the keryx-managed hooks`);
      expect(output).toContain(`your other uncommitted edits in ${SHARED_SETTINGS} are kept`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("scope shared keeps writing .claude/settings.json", async () => {
    const root = await hooksFixture("keryx-update-hooks-shared-", TEAM_SETTINGS, {
      root: defaultEntrypointTargets().root,
      claudeSettings: { path: SHARED_SETTINGS, scope: "shared" },
    });
    try {
      await runEntrypointUpdate(root);

      expect(existsSync(path.join(root, LOCAL_SETTINGS))).toBe(false);
      const counts = await managedCommandCounts(root);
      expect(counts.UserPromptSubmit).toEqual({ "keryx security check-input --source untrusted-external --runtime claude": 1 });
      expect(counts.PreToolUse).toEqual({ "keryx security check-output --runtime claude": 1 });
      expect(await readHookManifest(root)).toEqual({ agent: SHARED_SETTINGS, claudeSettings: { path: SHARED_SETTINGS, scope: "shared" } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("outside a git repository the hooks move to settings.local.json, settings.json is cleaned, and update says so", async () => {
    const root = await hooksFixture("keryx-update-hooks-nogit-", undefined, { root: ["AGENTS.md"] }, { git: false });
    try {
      await settleWithLegacyHooks(root, '{ "model": "sonnet" }');

      const output = await runEntrypointUpdate(root);

      expect(JSON.parse(await readFile(path.join(root, SHARED_SETTINGS), "utf8"))).toEqual({ model: "sonnet" });
      expect(await managedCommandCounts(root)).toEqual(EVERY_SURFACE_ONCE);
      expect(output).toContain(`${SHARED_SETTINGS}: removed the keryx-managed hooks`);
      expect(output).toContain("Not a git repository");

      const afterFirst = await snapshotTree(root);
      await runEntrypointUpdate(root);
      expect(await snapshotTree(root)).toEqual(afterFirst);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  test("update --preview moves no hook, and says which would move", async () => {
    const root = await hooksFixture("keryx-update-hooks-preview-", TEAM_SETTINGS, { root: ["AGENTS.md"] });
    try {
      await settleWithLegacyHooks(root, TEAM_SETTINGS);
      const working = await readFile(path.join(root, SHARED_SETTINGS), "utf8");
      const before = await snapshotTree(root);
      const { logs, restore } = captureUpdateConsoleLog();
      try {
        await withCwd(root, async () => {
          await updateCommand(["--skip-runtime", "--no-tasks", "--preview"]);
        });
      } finally {
        restore();
      }

      expect(logs.join("\n")).toContain(`${SHARED_SETTINGS}: the keryx-managed hooks would move to ${LOCAL_SETTINGS}`);
      expect(await readFile(path.join(root, SHARED_SETTINGS), "utf8")).toBe(working);
      expect(existsSync(path.join(root, LOCAL_SETTINGS))).toBe(false);
      expect(await snapshotTree(root)).toEqual(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
