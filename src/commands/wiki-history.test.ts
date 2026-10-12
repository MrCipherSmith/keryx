// T-002 (flow 367 review r1): `keryx wiki history` and `keryx wiki restore`
// (`wiki-history.ts`) were untested. The functions run in-process with cwd
// pointed at a temp project; stdout, stderr and the exit code are captured and
// restored around each call.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withCwd } from "../lib/test-cwd";
import { createWikiWriteContext, readPageHistory, type WikiWriteContext, writeWikiPage } from "../wiki/history";
import { runHistoryCommand, runRestoreCommand } from "./wiki-history";

let root: string;
let runs: WikiWriteContext[];

const wikiFile = (page: string): string => path.join(root, ".metaproject", "wiki", ...page.split("/"));

/** Three runs: r1 writes a (v1) and b (v1); r2 updates a (v2) and b (v2); r3 updates a again (v3). */
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-history-cmd-"));
  let tick = 0;
  const now = (): Date => new Date(Date.UTC(2026, 9, 1, 10, 0, tick++));
  runs = ["wiki enrich", "wiki collect --force", "wiki refresh"].map((command) => createWikiWriteContext(root, command, { now }));
  await writeWikiPage(runs[0]!, wikiFile("components/a.md"), "a one\n");
  await writeWikiPage(runs[0]!, wikiFile("components/b.md"), "b one\n");
  await writeWikiPage(runs[1]!, wikiFile("components/a.md"), "a two\n");
  await writeWikiPage(runs[1]!, wikiFile("components/b.md"), "b two\n");
  await writeWikiPage(runs[2]!, wikiFile("components/a.md"), "a three\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Run `fn` with cwd at the project, capturing everything it prints and the exit code it sets. */
async function capture(fn: () => Promise<void>): Promise<Captured> {
  const realWrite = process.stdout.write.bind(process.stdout);
  const realLog = console.log;
  const realError = console.error;
  const realExit = process.exitCode;
  let stdout = "";
  let stderr = "";
  try {
    process.exitCode = 0;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    console.log = (...parts: unknown[]) => {
      stdout += `${parts.map(String).join(" ")}\n`;
    };
    console.error = (...parts: unknown[]) => {
      stderr += `${parts.map(String).join(" ")}\n`;
    };
    await withCwd(root, fn);
    return { stdout, stderr, exitCode: Number(process.exitCode ?? 0) };
  } finally {
    process.stdout.write = realWrite;
    console.log = realLog;
    console.error = realError;
    process.exitCode = realExit;
  }
}

describe("wiki history <page>", () => {
  test("T-002 prints the page's version index, newest first with the current row marked", async () => {
    const out = await capture(() => runHistoryCommand(["components/a.md"]));

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("# History: components/a.md");
    expect(out.stdout).toContain("v0003 (current)");
    expect(out.stdout).toContain("v0002");
    expect(out.stdout).toContain("v0001");
    expect(out.stdout).toContain(runs[2]!.runId);
    expect(out.stdout).toContain("wiki refresh");
  });

  test("T-002 --json prints the parsed rows", async () => {
    const out = await capture(() => runHistoryCommand(["components/a.md", "--json"]));

    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { page: string; rows: { version: number; by: string; run: string }[] };
    expect(parsed.page).toBe("components/a.md");
    expect(parsed.rows.map((row) => row.version)).toEqual([3, 2, 1]);
    expect(parsed.rows.map((row) => row.run)).toEqual([runs[2]!.runId, runs[1]!.runId, runs[0]!.runId]);
    expect(parsed.rows[0]!.by).toBe("wiki refresh");
  });

  test("T-002 the page path is normalised: the three spellings print the same history", async () => {
    const spellings = [".metaproject/wiki/components/a.md", "components/a", "components/a.md"];
    const outputs: string[] = [];
    for (const spelling of spellings) {
      const out = await capture(() => runHistoryCommand([spelling]));
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain("# History: components/a.md");
      outputs.push(out.stdout);
    }
    expect(new Set(outputs).size).toBe(1);
  });

  test("T-002 a path leaving the wiki root is refused with exit code 1", async () => {
    for (const args of [["../x"], ["../x", "--json"], ["components/../../x"]]) {
      const out = await capture(() => runHistoryCommand(args));
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toMatch(/not a wiki page path|no history recorded/);
      expect(out.stdout).toBe("");
    }
  });

  test("T-002 a page keryx never wrote says so and exits 1; no page argument prints usage and exits 1", async () => {
    const unknown = await capture(() => runHistoryCommand(["components/never.md"]));
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("no history recorded for components/never.md");

    const bare = await capture(() => runHistoryCommand([]));
    expect(bare.exitCode).toBe(1);
    expect(bare.stderr).toContain("Usage: keryx wiki history");
  });
});

describe("wiki history --runs", () => {
  test("T-002 lists runs newest first with their command and page count", async () => {
    const out = await capture(() => runHistoryCommand(["--runs"]));

    expect(out.exitCode).toBe(0);
    const rows = out.stdout.split("\n").filter((line) => line.startsWith("run-"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain(runs[2]!.runId);
    expect(rows[0]).toContain("1 page(s)");
    expect(rows[0]).toContain("wiki refresh");
    expect(rows[1]).toContain(runs[1]!.runId);
    expect(rows[1]).toContain("2 page(s)");
    expect(rows[2]).toContain(runs[0]!.runId);
    expect(out.stdout).toContain("wiki restore --run <run-id>");
  });

  test("T-002 --json prints the runs as parseable JSON", async () => {
    const out = await capture(() => runHistoryCommand(["--runs", "--json"]));

    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { runId: string; command: string; pages: number }[];
    expect(parsed.map((run) => run.runId)).toEqual([runs[2]!.runId, runs[1]!.runId, runs[0]!.runId]);
    expect(parsed.map((run) => run.command)).toEqual(["wiki refresh", "wiki collect --force", "wiki enrich"]);
    expect(parsed.map((run) => run.pages)).toEqual([1, 2, 2]);
  });

  test("T-002 with no runs recorded it says so", async () => {
    await rm(path.join(root, ".metaproject"), { recursive: true, force: true });
    const out = await capture(() => runHistoryCommand(["--runs"]));
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("no wiki history runs recorded yet");
  });
});

describe("wiki restore <page>", () => {
  test("T-002 --version puts that version back and records the restore as a new version", async () => {
    const out = await capture(() => runRestoreCommand(["components/a.md", "--version", "v1"]));

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("restored: components/a.md -> v0001");
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a one\n");
    expect(out.stdout).toContain("wiki restore --run run-"); // the undo hint
    const history = await readPageHistory(root, "components/a.md");
    expect(history!.rows.map((row) => row.version)).toEqual([4, 3, 2, 1]);
    expect(history!.rows[0]!.by).toBe("wiki restore components/a.md --version v1");
  });

  test("T-002 without --version it undoes the last change; --json parses and names the undo run", async () => {
    const out = await capture(() => runRestoreCommand(["components/a", "--json"]));

    expect(out.exitCode).toBe(0);
    const parsed = JSON.parse(out.stdout) as { page: string; restoredTo: string; action: string; undoRunId: string };
    expect(parsed).toMatchObject({ page: "components/a.md", restoredTo: "v0002", action: "restored" });
    expect(parsed.undoRunId).toMatch(/^run-/);
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a two\n");
  });

  test("T-002 a version the page does not have fails with exit code 1, as text and as JSON", async () => {
    const text = await capture(() => runRestoreCommand(["components/a.md", "--version", "v9"]));
    expect(text.exitCode).toBe(1);
    expect(text.stderr).toContain("components/a.md has no v0009");

    const json = await capture(() => runRestoreCommand(["components/a.md", "--version", "v9", "--json"]));
    expect(json.exitCode).toBe(1);
    expect((JSON.parse(json.stdout) as { error: string }).error).toContain("has no v0009");
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a three\n");
  });
});

describe("wiki restore --run", () => {
  test("T-002 a page changed after the run is a conflict: listed, left alone, exit code 1; the others are restored", async () => {
    // r2 touched a and b; r3 then changed a again.
    const out = await capture(() => runRestoreCommand(["--run", runs[1]!.runId]));

    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("CONFLICT  components/a.md: changed after this run");
    expect(out.stdout).toContain("components/b.md -> v0001");
    expect(out.stdout).toContain("restored 1 page(s)");
    expect(out.stdout).toContain("1 conflict(s)");
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a three\n");
    expect(await readFile(wikiFile("components/b.md"), "utf8")).toBe("b one\n");
  });

  test("T-002 --json lists restored pages and conflicts, and parses", async () => {
    const out = await capture(() => runRestoreCommand(["--run", runs[1]!.runId, "--json"]));

    expect(out.exitCode).toBe(1);
    const parsed = JSON.parse(out.stdout) as {
      runId: string;
      restored: { page: string; restoredTo: string }[];
      conflicts: { page: string; reason: string }[];
      undoRunId: string;
    };
    expect(parsed.runId).toBe(runs[1]!.runId);
    expect(parsed.restored.map((entry) => entry.page)).toEqual(["components/b.md"]);
    expect(parsed.conflicts.map((entry) => entry.page)).toEqual(["components/a.md"]);
    expect(parsed.undoRunId).toMatch(/^run-/);
  });

  test("T-002 --force restores the conflicting page too and exits cleanly", async () => {
    const out = await capture(() => runRestoreCommand(["--run", runs[1]!.runId, "--force"]));

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("0 conflict(s)");
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a one\n");
    expect(await readFile(wikiFile("components/b.md"), "utf8")).toBe("b one\n");
  });

  test("T-002 the newest run restores cleanly with exit code 0", async () => {
    const out = await capture(() => runRestoreCommand(["--run", runs[2]!.runId]));

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("restored 1 page(s)");
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a two\n");
  });

  test("T-002 an unknown run id fails with exit code 1", async () => {
    const out = await capture(() => runRestoreCommand(["--run", "run-nope"]));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("no pages recorded for run-nope");
  });
});

describe("wiki restore usage", () => {
  test("T-002 neither a page nor --run prints usage and exits 1", async () => {
    for (const args of [[], ["--version", "v1"], ["--force"]]) {
      const out = await capture(() => runRestoreCommand(args));
      expect(out.exitCode).toBe(1);
      expect(out.stderr).toContain("Usage: keryx wiki restore");
    }
  });

  test("T-002 both a page and --run prints usage, exits 1, and changes nothing", async () => {
    const out = await capture(() => runRestoreCommand(["components/a.md", "--run", runs[2]!.runId]));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Usage: keryx wiki restore");
    expect(await readFile(wikiFile("components/a.md"), "utf8")).toBe("a three\n");
  });
});
