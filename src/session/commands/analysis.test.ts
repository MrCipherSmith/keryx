import { afterEach, expect, test } from "bun:test";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeAnalysisCommand, executeAnalysisInspection, analysisCommands, type NativeAnalysisPort, type AnalysisCommandContext } from "./analysis";
import type { SessionCommandEffect } from "./effects";
import { canonicalDigest } from "../../remote-control/protocol";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const D = "a".repeat(64);
async function fixture() {
  const cwd = await mkdtemp(path.join(tmpdir(), "native-analysis-command-")); roots.push(cwd);
  const configDir = await mkdtemp(path.join(tmpdir(), "native-analysis-config-")); roots.push(configDir);
  await mkdir(path.join(cwd, ".metaproject")); await mkdir(path.join(cwd, "src"));
  await writeFile(path.join(cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { risk: true } } }));
  for (const argv of [["init", "-q"], ["config", "user.email", "fixture@example.invalid"], ["config", "user.name", "fixture"]]) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...argv], { cwd, stdout: "ignore", stderr: "pipe" }); expect(await proc.exited).toBe(0);
  }
  await writeFile(path.join(cwd, "src/a.ts"), "export function parse(value: string) { return value; }\n");
  for (const argv of [["add", "."], ["commit", "-qm", "fixture"]]) { const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...argv], { cwd, stdout: "ignore", stderr: "pipe" }); expect(await proc.exited).toBe(0); }
  await writeFile(path.join(cwd, "src/a.ts"), "export function parse(value: string) { return JSON.parse(value); }\n");
  const config = { configVersion: 1, baselineCandidateId: "fixture", reasoningEffort: "none" as const, routing: { enabled: false, profileId: "local", candidateIds: ["fixture"], fallbackCandidateId: "fixture" }, policyDigest: D, capabilityDigest: D };
  const controller = new AbortController(); let calls = 0;
  const fetchFn: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls++; const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { type: "noul", noul: 0.1 }])), usage: { input_tokens: 5, output_tokens: 2, cost: 0.01 } }));
  }, { preconnect() {} });
  const port: NativeAnalysisPort = { enabledCommands: ["risk"], model: "jev-1.13", env: { OPENROUTER_API_KEY: "fixture-analysis-key" }, fetchFn, maxCalls: 4, policyDigest: D,
    readDiff: async (signal) => { const proc = Bun.spawn(["git", "diff", "--no-ext-diff", "--no-textconv", "--no-color"], { cwd, signal, stdout: "pipe", stderr: "pipe" });
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]); if (code !== 0) throw new Error("fixture-git-failed"); return out; } };
  const effect: SessionCommandEffect & { analysis: NativeAnalysisPort } = { runId: "run-fixture", turnId: "turn-fixture", association: { mode: "ad-hoc", profileConsentVersion: 1 },
    snapshot: { config, configDigest: canonicalDigest(config), effectiveCandidateId: "fixture", routingDecision: "baseline", fallbackReason: "none", selectionReceiptId: "selection-fixture" },
    signal: controller.signal, policy: { profileId: "native", fingerprint: D, allowedTools: ["read_file"], maxRounds: 3, maxToolCalls: 8 }, beforeAction: async () => {}, mutate: async (_kind, _paths, write) => write(), progress() {}, usage() {}, analysis: port };
  const context: AnalysisCommandContext = { cwd, configDir, effect };
  return { context, controller, port, calls: () => calls };
}

test("analysis requires admitted run, locally consented provider and exact policy before any fetch", async () => {
  const f = await fixture();
  expect(await executeAnalysisCommand({ cwd: f.context.cwd }, "risk", {})).toMatchObject({ ok: false, error: { code: "not-admitted" } });
  f.port.enabledCommands = [];
  expect(await executeAnalysisCommand(f.context, "risk", {})).toMatchObject({ ok: false, error: { code: "setup-required" } });
  expect(f.calls()).toBe(0);
});

test("risk command calls the actual existing service over a real Git diff and reports actual usage", async () => {
  const f = await fixture();
  const result = await executeAnalysisCommand(f.context, "risk", {});
  expect(result).toMatchObject({ ok: true, data: { tokens: { inputTokens: 5, outputTokens: 2 } } });
  expect(f.calls()).toBeGreaterThan(0);
});

test("closed analysis schema rejects arbitrary paths models and shell options before service effects", async () => {
  const f = await fixture();
  expect(await executeAnalysisCommand(f.context, "risk", { shell: "anything" })).toMatchObject({ ok: false, error: { code: "invalid-arguments" } });
  expect(f.calls()).toBe(0);
  const inspections = new Set(["native.analysis.ci.inspect", "native.analysis.conform.inspect"]);
  expect(analysisCommands().filter((item) => !inspections.has(item.entry.handlerId)).every((item) => item.entry.availability === "setup-required")).toBe(true);
  // An unattached read port is an implementation gap, never "missing local setup".
  expect(analysisCommands().filter((item) => inspections.has(item.entry.handlerId)).map((item) => [item.entry.commandName, item.entry.availability, item.entry.reason])).toEqual([["ci", "implementation-gap", "native-owned-read-port-not-attached"], ["conform", "implementation-gap", "native-owned-read-port-not-attached"]]);
  const bound = analysisCommands({ readInspection: true });
  expect(bound.filter((item) => inspections.has(item.entry.handlerId)).map((item) => [item.entry.availability, item.entry.mutationClass, item.entry.confirmation])).toEqual([["available", "read", "none"], ["available", "read", "none"]]);
  expect(bound.filter((item) => !inspections.has(item.entry.handlerId)).every((item) => item.entry.availability === "setup-required")).toBe(true);
});

async function tree(root: string): Promise<string> {
  const { readdir, readFile, lstat } = await import("node:fs/promises");
  const rows: string[] = [];
  for (const entry of (await readdir(root, { recursive: true })).sort()) { const file = path.join(root, entry); const info = await lstat(file); rows.push(`${entry}:${info.isFile() ? (await readFile(file)).toString("base64") : "dir"}`); }
  return rows.join("\n");
}

test("CI and conformance inspection read actual sources with no Jev execution configuration, model call, workspace effect or credential", async () => {
  const f = await fixture(); const { saveShellConfig } = await import("../../lib/shell-config");
  saveShellConfig({ apiKeys: { OPENROUTER_API_KEY: "fixture-saved-analysis-secret" } }, f.context.configDir);
  await writeFile(path.join(f.context.cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { ci_triage: true, conform: true } } }));
  await mkdir(path.join(f.context.cwd, ".metaproject/flows/flow-1/reviews/review-1"), { recursive: true }); await writeFile(path.join(f.context.cwd, ".metaproject/flows/flow-1/reviews/review-1/report.md"), "# Report\n");
  const argvs: string[] = [];
  const ciSpawn = async (argv: string[], cwd: string, signal?: AbortSignal) => { argvs.push(argv.slice(1, 3).join(" ")); expect(cwd).toBe(f.context.cwd); expect(signal?.aborted).toBe(false);
    const [, area, verb] = argv; const stdout = area === "pr" ? JSON.stringify({ number: 7, headRefName: "feature", title: "Fixture PR" })
      : verb === "list" ? JSON.stringify([{ databaseId: 11, conclusion: "failure", workflowName: "CI", headBranch: "feature", createdAt: "2026-10-27T00:00:00Z" }])
      : JSON.stringify({ jobs: [{ name: "unit", conclusion: "failure" }, { name: "lint", conclusion: "success" }], workflowName: "CI", headBranch: "feature", headSha: "a".repeat(40), conclusion: "failure" });
    return { exitCode: 0, stderr: "", stdout }; };
  const before = await tree(f.context.cwd); const realFetch = globalThis.fetch; let network = 0;
  globalThis.fetch = Object.assign(async () => { network++; throw new Error("inspection-must-not-call-a-model"); }, { preconnect() {} });
  try {
    const context = { cwd: f.context.cwd, configDir: f.context.configDir!, signal: new AbortController().signal };
    const ci = await executeAnalysisInspection(context, { ciSpawn }, "ci");
    expect(ci).toEqual({ ok: true, source: "native-analysis", data: { items: [{ runId: "11", jobName: "unit", workflowName: "CI", headBranch: "feature", conclusion: "failure", createdAt: "2026-10-27T00:00:00Z" }] } });
    const conform = await executeAnalysisInspection(context, { ciSpawn }, "conform");
    expect(conform).toMatchObject({ ok: true, data: { recents: [], targets: [{ id: "pr:7", kind: "pr" }, { id: "report:./.metaproject/flows/flow-1/reviews/review-1", kind: "report" }, { id: "diff:working", kind: "diff" }] } });
    expect(argvs).toEqual(["pr view", "run list", "run view", "pr view"]);
    for (const result of [ci, conform]) { const text = JSON.stringify(result); expect(text).not.toContain("fixture-saved-analysis-secret"); expect(text).not.toContain(f.context.configDir!); expect(text).not.toContain(f.context.cwd); expect(text).not.toContain("runId\":\"run"); expect("turnId" in (result as object)).toBe(false); }
    expect(network).toBe(0); expect(f.calls()).toBe(0); expect(await tree(f.context.cwd)).toBe(before);
  } finally { globalThis.fetch = realFetch; }
});

test("inspection without an attached owned read port is an implementation gap; cancellation is never a success", async () => {
  const f = await fixture();
  await writeFile(path.join(f.context.cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { ci_triage: true } } }));
  expect(await executeAnalysisInspection({ cwd: f.context.cwd }, undefined, "ci")).toMatchObject({ ok: false, error: { code: "implementation-gap" } });
  let reads = 0; const aborted = new AbortController(); aborted.abort();
  const port = { ciSpawn: async () => { reads++; return { exitCode: 0, stderr: "", stdout: "{}" }; } };
  for (const command of ["ci", "conform"] as const) expect(await executeAnalysisInspection({ cwd: f.context.cwd, configDir: f.context.configDir!, signal: aborted.signal }, port, command)).toMatchObject({ ok: false, error: { code: "cancelled" } });
  expect(reads).toBe(0);
  const denied = { ciSpawn: async () => { throw new Error("inspection-authority-denied"); } };
  expect(await executeAnalysisInspection({ cwd: f.context.cwd, configDir: f.context.configDir! }, denied, "ci")).toMatchObject({ ok: false, error: { code: "analysis-failed" } });
});

test("CI read surface uses the actual existing source without a fabricated Flow or provider call", async () => {
  const f = await fixture(); f.port.enabledCommands = ["ci"];
  await writeFile(path.join(f.context.cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { ci_triage: true } } }));
  let reads = 0;
  const ciSpawn = async (argv: string[]) => { reads++; return { exitCode: 0, stderr: "", stdout: argv[1] === "pr" ? JSON.stringify({ number: 1, headRefName: "fixture" }) : "[]" }; };
  const result = await executeAnalysisInspection({ cwd: f.context.cwd, ...(f.context.configDir === undefined ? {} : { configDir: f.context.configDir }) }, { ciSpawn }, "ci");
  expect(result).toMatchObject({ ok: true, data: { items: [], note: "No failed CI runs on fixture." } });
  expect(reads).toBe(2); expect(f.calls()).toBe(0);
});

test("conformance uses the existing clause engine over an explicitly contained reference and actual diff", async () => {
  const f = await fixture(); f.port.enabledCommands = ["conform"];
  await writeFile(path.join(f.context.cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { conform: true } } }));
  f.port.readReference = async (relativePath, signal) => { signal.throwIfAborted(); expect(relativePath).toBe("rules.md"); return "# Rules\n\n- Input validation must be explicit. [state:hunk]\n"; };
  const result = await executeAnalysisCommand(f.context, "conform", { referencePath: "rules.md", targetKind: "diff" });
  expect(result).toMatchObject({ ok: true, data: { ok: true, clauses: [{ state_kind: "hunk" }] } });
  expect(f.calls()).toBeGreaterThan(0);
});

test("all existing Jev analysis engines return their actual empty or computed outcomes, with explicit model provenance", async () => {
  const f = await fixture(); f.port.enabledCommands = ["scenarios", "jevrules", "staledocs", "contract", "triage", "opencomments"];
  await writeFile(path.join(f.context.cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { scenarios: true, rules: true, docs: true, contract: true, triage: true, comments: true } } }));
  f.port.readLatestFindings = async () => [];
  f.port.github = { repo: "fixture/repository", number: 1,
    prPort: { pr: async () => ({ number: 1, title: "Fixture", body: "", diff: await f.port.readDiff(f.controller.signal) }) },
    factsPort: { commitsTouching: async () => [], resolvedThreadIds: async () => new Set<string>() } };
  for (const command of f.port.enabledCommands) {
    const result = await executeAnalysisCommand(f.context, command, {});
    expect(result).toMatchObject({ ok: true, source: "native-analysis", runId: "run-fixture", analysisModel: "jev-1.13" });
  }
});

test("actual in-flight Jev service cancellation is reported as cancelled, never success", async () => {
  const f = await fixture(); let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  f.port.fetchFn = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
    entered(); return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal; if (signal?.aborted) reject(new DOMException("Fixture aborted", "AbortError"));
      else signal?.addEventListener("abort", () => reject(new DOMException("Fixture aborted", "AbortError")), { once: true });
    });
  }, { preconnect() {} });
  const pending = executeAnalysisCommand(f.context, "risk", {}); await ready; f.controller.abort();
  expect(await pending).toMatchObject({ ok: false, error: { code: "cancelled" } });
});

test("analysis metadata writes cannot bypass the native owned mutation gate", async () => {
  const f = await fixture(); f.port.enabledCommands = ["conform"];
  await writeFile(path.join(f.context.cwd, ".metaproject/tasks.config.json"), JSON.stringify({ external: "on", review: { jev: { conform: true } } }));
  f.port.readReference = async () => "# Rules\n\n- Input validation must be explicit. [state:hunk]\n";
  let guarded = false;
  f.context.effect!.mutate = async (_kind, paths) => { guarded = paths.includes(".metaproject/data/review-conform/recent-docs.json"); throw new Error("fixture-owned-write-refused"); };
  expect(await executeAnalysisCommand(f.context, "conform", { referencePath: "rules.md", targetKind: "diff" })).toMatchObject({ ok: false });
  expect(guarded).toBe(true);
  expect(await access(path.join(f.context.cwd, ".metaproject/data/review-conform/recent-docs.json")).then(() => true, () => false)).toBe(false);
});
