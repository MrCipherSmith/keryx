import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { updateCommand } from "./update";

test("refreshes service files without touching data artifacts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "gd-metapro-update-"));
  const previousCwd = process.cwd();
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

    process.chdir(root);
    await updateCommand(["--skip-runtime"]);

    expect(await readFile(path.join(root, ".metaproject", "gd-metapro-dashboard.html"), "utf8")).toContain("Metaproject");
    expect(await readFile(path.join(root, ".metaproject", "core", "gdgraph", "build.ts"), "utf8")).toContain("buildGraph");
    expect(await readFile(path.join(root, ".metaproject", "flows", "README.md"), "utf8")).toContain("Flow");
    expect(await fileExists(path.join(root, ".metaproject", "data", "gdskills"))).toBe(false);
    expect(await fileExists(path.join(root, ".metaproject", "data", "tasks"))).toBe(false);
    expect(await readFile(graphSummaryPath, "utf8")).toBe(graphSummary);
    expect(await readFile(testingContextPath, "utf8")).toBe(testingContext);
  } finally {
    process.chdir(previousCwd);
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
