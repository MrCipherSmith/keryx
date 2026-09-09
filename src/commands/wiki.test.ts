// AFC-06 (flow 234) T22 -- AC1's second half: "historical режим явно
// размечен". Wiki had NO historical mode at all before this task: a
// non-current page was dropped, never shown and marked, and `WikiAskInput`
// had no mode flag. These tests exercise the real `keryx wiki ask` CLI
// (`wikiCommand`, mirrors `memory.test.ts`'s `memoryCommand` pattern: chdir
// into a fixture, capture console output, reset `process.exitCode`), not
// `wikiAsk` called directly, so the demonstration is the actual command line
// a model or operator would run.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiCommand } from "./wiki";

describe("keryx wiki ask — historical mode (--as-of) is explicit and its items are marked", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let loggedErr: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-wiki-ask-cmd-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "wiki", "architecture"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "wiki", "architecture", "legacy-billing.md"),
      "# Legacy billing pipeline probe\n\nType: architecture\nStatus: deprecated\n\n## Summary\n\nLegacy billing pipeline probe instructions for nightly invoices.\n",
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "wiki", "architecture", "current-billing.md"),
      "# Current billing pipeline probe\n\nType: architecture\nStatus: accepted\n\n## Summary\n\nCurrent billing pipeline probe instructions for nightly invoices.\n",
      "utf8",
    );

    loggedOut = [];
    loggedErr = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("default retrieval: the deprecated page is absent and nothing is marked HISTORICAL", async () => {
    await wikiCommand(["ask", "billing pipeline probe instructions nightly invoices"]);

    expect(process.exitCode).toBe(0);
    const output = loggedOut.join("\n");
    expect(output).toContain("Current billing pipeline probe");
    expect(output).not.toContain("Legacy billing pipeline probe");
    expect(output).not.toContain("HISTORICAL");
  });

  test("--as-of <today> admits the deprecated page, visibly labelled with its state and reason", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await wikiCommand(["ask", "billing pipeline probe instructions nightly invoices", "--as-of", today]);

    expect(process.exitCode).toBe(0);
    const output = loggedOut.join("\n");
    expect(output).toContain("Legacy billing pipeline probe");
    expect(output).toContain("HISTORICAL");
    expect(output).toContain("state=deprecated");
    expect(output).toContain("reason=status-deprecated");
    // The current page in the same result carries no historical marker.
    const currentLine = output.split("\n").find((line) => line.includes("Current billing pipeline probe"));
    expect(currentLine).toBeDefined();
    expect(currentLine).not.toContain("HISTORICAL");
  });

  test("--as-of <today> --json: the same labelling appears as structured citation fields", async () => {
    const today = new Date().toISOString().slice(0, 10);
    await wikiCommand([
      "ask",
      "billing pipeline probe instructions nightly invoices",
      "--as-of",
      today,
      "--json",
    ]);

    expect(process.exitCode).toBe(0);
    const payload = JSON.parse(loggedOut.join("\n")) as {
      citations: Array<{ path: string; historical?: boolean; lifecycleState?: string; lifecycleReasons?: string[] }>;
    };
    const legacy = payload.citations.find((c) => c.path === "wiki/architecture/legacy-billing.md");
    expect(legacy?.historical).toBe(true);
    expect(legacy?.lifecycleState).toBe("deprecated");
    expect(legacy?.lifecycleReasons).toEqual(["status-deprecated"]);

    const current = payload.citations.find((c) => c.path === "wiki/architecture/current-billing.md");
    expect(current?.historical).toBeUndefined();
  });

  test("a malformed --as-of date is rejected with a clear, actionable error instead of silently misclassifying every page", async () => {
    await wikiCommand(["ask", "billing pipeline probe", "--as-of", "not-a-date"]);

    expect(process.exitCode).toBe(1);
    const errOutput = loggedErr.join("\n");
    expect(errOutput).toContain("invalid-temporal-date");
  });
});

// Flow 236 T8, defect 3: `keryx wiki freshness` described itself as a
// "read-only backlog" in both `--help` and its own doc comment, while
// `runFreshness` persists `latest.{json,md}` AND calls `clearQueue`, deleting
// the accumulated `freshness-queue.jsonl`. A phase-4 inventory pass refused to
// run the command for exactly that reason — a real queue existed in the tree
// and running the "read-only" command would have consumed it. Same defect
// class as the earlier command in this programme that declared itself
// non-mutating and wrote the user's query to disk. The help text is the
// contract a user reads before deciding whether a command is safe to run.
describe("keryx wiki --help declares what `freshness` actually does", () => {
  let logged: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    logged = [];
    originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    };
  });

  afterEach(() => {
    console.log = originalLog;
  });

  test("the freshness line does not call the command read-only", async () => {
    await wikiCommand(["--help"]);
    const help = logged.join("\n");
    const line = help.split("\n").find((entry) => entry.includes("wiki freshness")) ?? "";

    expect(line).not.toBe("");
    expect(line.toLowerCase()).not.toContain("read-only");
  });

  test("the help states that the run consumes the queue and writes the report", async () => {
    await wikiCommand(["--help"]);
    const help = logged.join("\n").toLowerCase();

    expect(help).toContain("freshness-queue.jsonl");
    expect(help).toMatch(/consumes|clears|drains/);
    expect(help).toContain("latest.json");
  });
});
