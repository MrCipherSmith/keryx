// Flow 308 (W8, Lane B, T6 / AC9): `buildAffectedReport` is the ONE builder
// behind both `keryx gdgraph affected <file> --json` and the impact-evidence
// "importers" section. This asserts they print byte-identical JSON at the
// same graph state, plus the two failure shapes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gdgraphCommand } from "../commands/gdgraph";
import { buildAffectedReport } from "./affected-report";

describe("buildAffectedReport", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let originalLog: typeof console.log;
  let originalError: typeof console.error;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-affected-report-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, ".metaproject", "data", "gdgraph", "storage"), { recursive: true });
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      [
        '{"id":"src/a.ts","kind":"file","path":"src/a.ts","language":"typescript"}',
        '{"id":"src/b.ts","kind":"file","path":"src/b.ts","language":"typescript"}',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl"),
      '{"id":"e1","from":"src/b.ts","to":"src/a.ts","kind":"imports","specifier":"./a"}\n',
      "utf8",
    );

    loggedOut = [];
    originalLog = console.log;
    originalError = console.error;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
    console.error = () => {};
    process.exitCode = 0;
  });

  afterEach(async () => {
    console.log = originalLog;
    console.error = originalError;
    process.chdir(cwd);
    process.exitCode = 0;
    await rm(root, { recursive: true, force: true });
  });

  test("AC9: byte-identical to `keryx gdgraph affected --json` at the same graph state", async () => {
    await gdgraphCommand(["affected", "src/a.ts", "--json"]);
    const cliOutput = loggedOut.join("\n");

    const report = await buildAffectedReport(root, "src/a.ts");

    expect(JSON.stringify(report.json, null, 2)).toBe(cliOutput);
    expect(report.exitCode).toBe(0);
  });

  test("success shape carries dependents, dependencies and a ranked blast radius", async () => {
    const report = await buildAffectedReport(root, "src/a.ts");
    expect(report.json.target).toBe("src/a.ts");
    expect(report.json.dependents).toEqual(["src/b.ts"]);
    expect(report.json.dependencies).toEqual([]);
    expect(Array.isArray(report.json.ranked)).toBe(true);
  });

  test("target-not-indexed: never silently reported as an empty result", async () => {
    const report = await buildAffectedReport(root, "src/does-not-exist.ts");
    expect(report.exitCode).toBe(1);
    expect(report.json.code).toBe("target-not-indexed");
    expect(report.json.dependencies).toEqual([]);
    expect(report.json.dependents).toEqual([]);
  });

  test("index-incomplete: an empty graph refuses to answer for any target", async () => {
    await rm(path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"));
    await writeFile(path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"), "", "utf8");

    const report = await buildAffectedReport(root, "src/a.ts");
    expect(report.exitCode).toBe(1);
    expect(report.json.code).toBe("index-incomplete");
  });

  // F25 (review round 1, info): the ambiguous-suffix caller-error path
  // (`resolveGraphTarget` throwing) is NOT built by `buildAffectedReport` —
  // it propagates the throw, and `runAffected --json`'s catch block is what
  // must reproduce the PRE-REFACTOR behavior byte-for-byte: the message on
  // stderr, exit 1, and — critically — NO stdout at all (a `--json` caller
  // must never see a prose error mixed into what should be parseable JSON,
  // nor a half-printed JSON document). Verified against
  // `git show stack/wave0:src/commands/gdgraph.ts`'s own catch block, which
  // this reproduces exactly (same message format, same exit code, same
  // "print nothing to stdout" contract regardless of `--json`).
  test("F25: an ambiguous suffix throws (never silently guesses), and the CLI's --json path reproduces stderr+exit-1+no-stdout byte-identically", async () => {
    await writeFile(
      path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"),
      [
        '{"id":"src/foo/a.ts","kind":"file","path":"src/foo/a.ts","language":"typescript"}',
        '{"id":"src/bar/a.ts","kind":"file","path":"src/bar/a.ts","language":"typescript"}',
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(path.join(root, ".metaproject", "data", "gdgraph", "storage", "edges.jsonl"), "", "utf8");

    await expect(buildAffectedReport(root, "a.ts")).rejects.toThrow(/ambiguous/);

    let directMessage = "";
    try {
      await buildAffectedReport(root, "a.ts");
    } catch (error) {
      directMessage = error instanceof Error ? error.message : String(error);
    }

    const loggedErr: string[] = [];
    const originalError = console.error;
    console.error = (...parts: unknown[]) => {
      loggedErr.push(parts.map(String).join(" "));
    };
    try {
      await gdgraphCommand(["affected", "a.ts", "--json"]);
    } finally {
      console.error = originalError;
    }

    expect(loggedOut.length).toBe(0); // no stdout at all, `--json` or not
    expect(process.exitCode).toBe(1);
    expect(loggedErr.join("\n")).toBe(`gdgraph: ${directMessage}`);
  });

  // F22 (review round 1, info): the AC9 test above calls `buildAffectedReport`
  // from BOTH sides of its own comparison (once directly, once indirectly
  // through `gdgraphCommand` → `runAffected` → `buildAffectedReport`) — it
  // proves the function is deterministic, not that today's shape matches
  // what `runAffected --json` printed BEFORE the T6 extraction. This locks
  // the three JSON shapes to the exact key sets and exit codes the
  // pre-refactor inline builder produced (`git show
  // stack/wave0:src/commands/gdgraph.ts`, its three `console.log(JSON.stringify(...))`
  // call sites for the success / target-not-indexed / index-incomplete
  // paths) — a change to any key here is a behavior change for every
  // existing `--json` consumer, not a refactor.
  describe("F22: golden — shape is byte-identical to the pre-refactor (stack/wave0) inline builder", () => {
    test("success shape: exactly {...affected, freshness} — schemaVersion is NOT re-added by the wrapper", async () => {
      const report = await buildAffectedReport(root, "src/a.ts");
      expect(report.exitCode).toBe(0);
      expect(Object.keys(report.json).sort()).toEqual(
        ["target", "depth", "dependencies", "dependents", "ranked", "freshness"].sort(),
      );
    });

    test("target-not-indexed shape: schemaVersion, code, error, reason, nextActions, target, dependencies, dependents, removal, freshness", async () => {
      const report = await buildAffectedReport(root, "src/does-not-exist.ts");
      expect(report.exitCode).toBe(1);
      expect(Object.keys(report.json).sort()).toEqual(
        [
          "schemaVersion",
          "code",
          "error",
          "reason",
          "nextActions",
          "target",
          "dependencies",
          "dependents",
          "removal",
          "freshness",
        ].sort(),
      );
      expect(report.json.code).toBe("target-not-indexed");
      expect(report.json.error).toBe("target-not-indexed");
      const removal = report.json.removal as Record<string, unknown>;
      expect(Object.keys(removal).sort()).toEqual(["verdict", "reason", "referencedBy", "trailPath"].sort());
    });

    test("index-incomplete shape: schemaVersion, code, error, reason, nextActions, target, dependencies (empty), dependents (empty), freshness — no removal key", async () => {
      await rm(path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"));
      await writeFile(path.join(root, ".metaproject", "data", "gdgraph", "storage", "nodes.jsonl"), "", "utf8");

      const report = await buildAffectedReport(root, "src/a.ts");
      expect(report.exitCode).toBe(1);
      expect(Object.keys(report.json).sort()).toEqual(
        ["schemaVersion", "code", "error", "reason", "nextActions", "target", "dependencies", "dependents", "freshness"].sort(),
      );
      expect(report.json.code).toBe("index-incomplete");
      expect(report.json.dependencies).toEqual([]);
      expect(report.json.dependents).toEqual([]);
      expect("removal" in report.json).toBe(false);
    });
  });
});
