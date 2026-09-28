// G-4 (flow 356, audit remediation 3): `keryx standard validate` on a fresh
// `keryx init` tree must report zero warnings — a module's own `data`
// directory (`missing-module-path`) is created either by `init` itself or
// lazily by the module's first run, never left declared-but-absent.
//
// This pins the CURRENT, already-correct behaviour (verified directly
// against a real `keryx init --yes` tree, and again after `keryx modules
// enable mcp`, 2026-09-28): every enabled module's `data` directory exists
// the moment it is enabled. The `missing-module-path` warnings observed on
// THIS repository's own long-lived `.metaproject/` (flow 356's own worktree)
// are local runtime-state drift — `.metaproject/data/{tasks,health,mcp}`
// never having been populated because nothing in this particular worktree
// ever ran `keryx tasks`/`keryx health run`/`keryx serve-mcp` — not a code
// defect a fresh tree reproduces.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { initCommand } from "../commands/init";
import { modulesCommand } from "../commands/modules";
import { validateWorkspace } from "./validate";

async function freshGitRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-standard-fresh-init-"));
  const proc = Bun.spawn(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
  await proc.exited;
  return root;
}

test("a fresh `keryx init --yes` tree reports zero standard-validate warnings", async () => {
  const root = await freshGitRoot();
  try {
    await withCwd(root, async () => {
      await initCommand(["--yes"]);
    });
    const result = await validateWorkspace(root);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("enabling the mcp module afterwards (keryx modules enable mcp) still reports zero warnings — its data dir is created on enable", async () => {
  const root = await freshGitRoot();
  try {
    await withCwd(root, async () => {
      await initCommand(["--yes"]);
      await modulesCommand(["enable", "mcp"]);
    });
    const result = await validateWorkspace(root);
    expect(result.warnings.filter((w) => w.code === "missing-module-path")).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.ok).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
