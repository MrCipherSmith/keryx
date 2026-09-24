// Flow 308 (W8, Lane B, T6): `buildRelatedTestsReport` is the shared builder
// behind `keryx test related <file> --json`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { testCommand } from "../commands/test";
import { buildRelatedTestsReport } from "./related-report";

describe("buildRelatedTestsReport", () => {
  let root = "";
  let cwd = "";
  let loggedOut: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "keryx-related-report-"));
    cwd = process.cwd();
    process.chdir(root);

    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "foo.ts"), "export const foo = 1;\n", "utf8");
    await writeFile(path.join(root, "src", "foo.test.ts"), "import { foo } from './foo';\n", "utf8");

    loggedOut = [];
    originalLog = console.log;
    console.log = (...parts: unknown[]) => {
      loggedOut.push(parts.map(String).join(" "));
    };
  });

  afterEach(async () => {
    console.log = originalLog;
    process.chdir(cwd);
    await rm(root, { recursive: true, force: true });
  });

  test("matches `keryx test related --json` byte-for-byte at the same tree state", async () => {
    await testCommand(["related", "src/foo.ts", "--json"]);
    const cliOutput = loggedOut.join("\n");

    const report = await buildRelatedTestsReport(root, "src/foo.ts");
    expect(JSON.stringify(report, null, 2)).toBe(cliOutput);
  });

  test("finds the naming-related test file", async () => {
    const report = await buildRelatedTestsReport(root, "src/foo.ts");
    expect(report.schemaVersion).toBe(1);
    expect(report.target).toBe("src/foo.ts");
    expect(report.related).toContain("src/foo.test.ts");
    expect(report.context.status).toBe("complete");
  });
});
