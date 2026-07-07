import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { initCommand } from "./init";

test("writes gdwiki as the canonical wiki manifest key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-init-"));
  const previousCwd = process.cwd();

  try {
    process.chdir(root);
    await initCommand([
      "--yes",
      "--no-gdgraph",
      "--no-gdctx",
      "--no-gdskills",
      "--no-health",
      "--no-testing",
      "--no-memory",
      "--no-tasks",
    ]);

    const manifest = JSON.parse(await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8")) as {
      modules: Record<string, { enabled: boolean }>;
    };

    expect(manifest.modules.gdwiki?.enabled).toBe(true);
    expect(manifest.modules.wiki).toBeUndefined();
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).not.toContain("Metaproject flow skill");
  } finally {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  }
});
