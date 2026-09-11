import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { withCwd } from "../lib/test-cwd";
import { RETIRED_RULES } from "../gdskills/retired-rules";
import { memoryCommand } from "./memory";
import { initCommand } from "./init";

// Round-1 finding T-001: the retired-rule warning print was tested only at
// the `keryx skills install` call site (skills-install-warnings.test.ts).
// `installGdskills` is also called from `keryx init` (init.ts:624, printed
// at init.ts:1089) and `keryx update` (see update.test.ts) — a regression
// that silences either print stayed green under the old coverage. These two
// tests drive `keryx init` directly.
const retiredFixturesRootForInit = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "gdskills",
  "__fixtures__",
  "retired-rules",
);

const MINIMAL_INIT_ARGS_KEEPING_GDSKILLS = [
  "--yes",
  "--no-gdgraph",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security",
];

/** Patches `console.log` to capture every call's stringified arguments. */
function captureInitConsoleLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const original = console.log;
  // biome-ignore lint: intentional console capture for assertions in this test only.
  console.log = (...values: unknown[]) => {
    logs.push(values.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" "));
  };
  return { logs, restore: () => { console.log = original; } };
}

function retiredEntryForInitOrThrow() {
  const retiredEntry = RETIRED_RULES[0];
  if (!retiredEntry) {
    throw new Error("RETIRED_RULES is empty; this test needs at least one entry to exercise.");
  }
  return retiredEntry;
}

test("keryx init: a modified retired rule prints a Warnings heading and the warning line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-retired-rules-"));
  try {
    const retiredEntry = retiredEntryForInitOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRootForInit, retiredEntry.fileName), "utf8");
    const modifiedContent = `${unmodifiedContent}\n<!-- project-local note added after install -->\n`;
    await writeFile(path.join(rulesCore, retiredEntry.fileName), modifiedContent, "utf8");

    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT_ARGS_KEEPING_GDSKILLS);
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

test("keryx init: an unmodified retired rule is removed with no Warnings printed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-init-retired-rules-"));
  try {
    const retiredEntry = retiredEntryForInitOrThrow();
    const rulesCore = path.join(root, ".metaproject", "rules", "core");
    await mkdir(rulesCore, { recursive: true });

    const unmodifiedContent = await readFile(path.join(retiredFixturesRootForInit, retiredEntry.fileName));
    await writeFile(path.join(rulesCore, retiredEntry.fileName), unmodifiedContent);

    const { logs, restore } = captureInitConsoleLog();
    try {
      await withCwd(root, async () => {
        await initCommand(MINIMAL_INIT_ARGS_KEEPING_GDSKILLS);
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
