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
});
