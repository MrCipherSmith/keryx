import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createSecurityService, runScanPath, scanContent } from "./service";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-source-context-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("only filesystem source scans filter properties; output checks retain them", async () => {
  const content = "fetch(url, process.env);";
  await writeFile(path.join(root, "example.ts"), content);
  const input = { content, source: "trusted-project" as const, path: "example.ts" };
  const pure = await scanContent(root, input);
  expect(pure.decision.findings.some((f) => f.policyId === "egress.private-file-publish")).toBe(true);
  const runtime = await createSecurityService(root).check(input);
  expect(runtime.findings.some((f) => f.policyId === "egress.private-file-publish")).toBe(true);
  const source = await runScanPath(root, {
    ownerRoot: root, targetPath: path.join(root, "example.ts"), source: "trusted-project",
  });
  expect(source.report.coverage?.status).toBe("complete");
  expect(source.decision.findings).toEqual([]);
  expect(source.decision.gate).toBe("pass");
  const untrusted = await runScanPath(root, {
    ownerRoot: root, targetPath: path.join(root, "example.ts"), source: "generated",
  });
  expect(untrusted.decision.findings.some((f) => f.policyId === "egress.private-file-publish")).toBe(true);
});

test("filesystem scan retains a real private-file publication", async () => {
  await writeFile(path.join(root, "example.ts"), 'fetch(url, process.env); upload(".env");');
  const result = await runScanPath(root, {
    ownerRoot: root, targetPath: path.join(root, "example.ts"), source: "trusted-project",
  });
  expect(result.report.coverage?.status).toBe("complete");
  expect(result.decision.findings.filter((f) => f.policyId === "egress.private-file-publish")).toHaveLength(1);
  expect(result.decision.gate).toBe("fail");
});

test("filesystem scan retains findings and reports conservative fallback for invalid syntax", async () => {
  await writeFile(path.join(root, "example.ts"), "fetch(url, process.env); const = ;");
  const result = await runScanPath(root, {
    ownerRoot: root, targetPath: path.join(root, "example.ts"), source: "trusted-project",
  });
  expect(result.report.coverage?.status).toBe("complete");
  expect(result.report.files).toEqual([{ path: "example.ts", status: "scanned" }]);
  expect(result.decision.findings.some((finding) =>
    finding.policyId === "egress.private-file-publish")).toBe(true);
  expect(result.decision.gate).toBe("fail");
  expect(result.warnings.some((warning) =>
    warning.includes("source syntax unverified; conservative security matches retained"))).toBe(true);
});

test("shell and TUI source scans are clean with complete coverage", async () => {
  for (const [name, relative] of [
    ["shell.ts", "../commands/shell.ts"],
    ["tui-shell.ts", "../tui/tui-shell.ts"],
  ] as const) {
    const content = await readFile(new URL(relative, import.meta.url), "utf8");
    await writeFile(path.join(root, name), content);
    const result = await runScanPath(root, {
      ownerRoot: root, targetPath: path.join(root, name), source: "trusted-project",
    });
    expect(result.report.coverage?.status).toBe("complete");
    expect(result.report.files).toEqual([{ path: name, status: "scanned" }]);
    expect(result.warnings).toEqual([]);
    expect(result.decision.findings).toEqual([]);
    expect(result.decision.gate).toBe("pass");
  }
});
