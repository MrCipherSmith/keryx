import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { memoryCommand } from "./memory";
import { initCommand } from "./init";

test("writes gdwiki as the canonical wiki manifest key", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-"));

  try {
    await withCwd(root, async () => {
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
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init ignores generated memory data but tracks canonical memory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-memory-policy-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await withCwd(root, async () => {
      await initCommand([
        "--yes",
        "--no-gdgraph",
        "--no-gdctx",
        "--no-gdwiki",
        "--no-gdskills",
        "--no-health",
        "--no-testing",
        "--no-tasks",
        "--no-security",
      ]);
    });
    await writeFile(path.join(root, ".metaproject", "memory", "decisions", "example.md"), "# Example\n", "utf8");
    const generatedPaths = [
      ".metaproject/data/memory/index/index.json",
      ".metaproject/data/memory/embeddings/vectors.jsonl",
      ".metaproject/data/memory/artifacts/legacy.md",
      ".metaproject/runtime/memory/search/run/report.json",
      ".metaproject/runtime/memory/tmp/staging",
    ];
    for (const candidate of generatedPaths) {
      const result = Bun.spawnSync(["git", "check-ignore", "--no-index", "--quiet", "--", candidate], {
        cwd: root,
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(result.exitCode).toBe(0);
    }
    const canonical = Bun.spawnSync([
      "git",
      "check-ignore",
      "--no-index",
      "--quiet",
      "--",
      ".metaproject/memory/decisions/example.md",
    ], { cwd: root, stdout: "ignore", stderr: "ignore" });
    expect(canonical.exitCode).not.toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("memory index output is ignored and reproducible after init", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-memory-index-"));
  try {
    Bun.spawnSync(["git", "init", "-q"], { cwd: root, stdout: "ignore", stderr: "ignore" });
    await withCwd(root, async () => {
      await initCommand([
        "--yes",
        "--no-gdgraph",
        "--no-gdctx",
        "--no-gdwiki",
        "--no-gdskills",
        "--no-health",
        "--no-testing",
        "--no-tasks",
        "--no-security",
      ]);
      await memoryCommand(["index"]);
      const indexPath = path.join(root, ".metaproject", "data", "memory", "index", "index.json");
      const first = await readFile(indexPath, "utf8");
      await memoryCommand(["index"]);
      const second = await readFile(indexPath, "utf8");
      expect(JSON.parse(second).entries).toEqual(JSON.parse(first).entries);
      const ignored = Bun.spawnSync([
        "git",
        "check-ignore",
        "--no-index",
        "--quiet",
        "--",
        ".metaproject/data/memory/index/index.json",
      ], { cwd: root, stdout: "ignore", stderr: "ignore" });
      expect(ignored.exitCode).toBe(0);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
