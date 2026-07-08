import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { initCommand } from "./init";
import { MODULE_COMMANDS, type ModuleId } from "./module-commands";

// Guards the F-001 blocker: the generated manifest must never advertise a
// subcommand that the CLI does not dispatch. init reads MODULE_COMMANDS, so a
// stray inline array (e.g. gdgraph "explain"/"path") would fail here.
test("init writes module command lists from the canonical source of truth", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-cmds-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(root);
    await initCommand(["--yes"]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled?: boolean; commands?: string[] }>;
    };

    for (const id of Object.keys(MODULE_COMMANDS) as ModuleId[]) {
      const mod = manifest.modules[id];
      expect(mod?.enabled).toBe(true);
      expect(mod?.commands).toEqual([...MODULE_COMMANDS[id]]);
    }

    // Explicit regression assertions for the drift that motivated this fix.
    expect(manifest.modules.gdgraph?.commands).not.toContain("explain");
    expect(manifest.modules.gdgraph?.commands).not.toContain("path");
    expect(manifest.modules.gdwiki?.commands).toContain("collect");
    expect(manifest.modules.gdskills?.commands).toContain("contracts");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});

// The canonical map must not reintroduce the removed gdgraph commands
// (explain/path) and must advertise exactly the implemented surface. `repomap`
// was added by Block B (ranked repo map); it is a real, always-available
// subcommand dispatched by src/commands/gdgraph.ts.
test("MODULE_COMMANDS matches the implemented gdgraph surface", () => {
  expect([...MODULE_COMMANDS.gdgraph]).toEqual(["build", "query", "affected", "repomap"]);
});
