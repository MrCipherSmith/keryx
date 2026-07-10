import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  AGENT_BOOTSTRAP_END,
  AGENT_BOOTSTRAP_START,
  installAgentBootstrap,
  resolveAgentBootstrapRuntimes,
  uninstallAgentBootstrap,
} from "./bootstrap";

test("install writes an optional bootstrap block near the top and preserves user content", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "keryx-agent-bootstrap-"));
  try {
    const runtime = resolveAgentBootstrapRuntimes(["opencode"]).runtimes[0]!;
    const file = runtime.filePath(home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# AGENTS Instructions\n\nUse local user rules.\n", "utf8");

    const result = await installAgentBootstrap(runtime, { homeRoot: home });
    const content = await readFile(file, "utf8");

    expect(result.wrote).toBe(true);
    expect(result.current).toBe(true);
    expect(content.indexOf(AGENT_BOOTSTRAP_START)).toBeLessThan(content.indexOf("Use local user rules."));
    expect(content).toContain("If Keryx is NOT installed");
    expect(content).toContain("cwd or ancestors");
    expect(content).toContain("Hard gate");
    expect(content).toContain("before the first plan, search, grep, file read");
    expect(content).toContain("If you create or switch to a git worktree");
    expect(content).toContain("Every subagent prompt must include the project/worktree root");
    expect(content).toContain("Use local user rules.");
    expect(content).toContain(AGENT_BOOTSTRAP_END);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install is idempotent and dry-run does not write", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "keryx-agent-bootstrap-dry-"));
  try {
    const runtime = resolveAgentBootstrapRuntimes(["claude"]).runtimes[0]!;
    const first = await installAgentBootstrap(runtime, { homeRoot: home });
    const before = await readFile(runtime.filePath(home), "utf8");
    const second = await installAgentBootstrap(runtime, { homeRoot: home });
    const dryRun = await installAgentBootstrap(runtime, { homeRoot: home, dryRun: true });
    const after = await readFile(runtime.filePath(home), "utf8");

    expect(first.wrote).toBe(true);
    expect(second.wrote).toBe(false);
    expect(dryRun.dryRun).toBe(true);
    expect(after).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("uninstall removes only the managed bootstrap block", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "keryx-agent-bootstrap-uninstall-"));
  try {
    const runtime = resolveAgentBootstrapRuntimes(["codex"]).runtimes[0]!;
    await installAgentBootstrap(runtime, { homeRoot: home });
    const file = runtime.filePath(home);
    await writeFile(file, `${await readFile(file, "utf8")}\nKeep this user rule.\n`, "utf8");

    const result = await uninstallAgentBootstrap(runtime, { homeRoot: home });
    const content = await readFile(file, "utf8");

    expect(result.removed).toBe(true);
    expect(content).not.toContain(AGENT_BOOTSTRAP_START);
    expect(content).toContain("Keep this user rule.");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime resolver supports all requested runtimes and antigravuty alias", () => {
  const { runtimes, unknown } = resolveAgentBootstrapRuntimes(["claude,opencode,zcode,codex,antigravuty"]);

  expect(unknown).toEqual([]);
  expect(runtimes.map((runtime) => runtime.id)).toEqual([
    "claude",
    "opencode",
    "zcode",
    "codex",
    "antigravity",
  ]);
});
