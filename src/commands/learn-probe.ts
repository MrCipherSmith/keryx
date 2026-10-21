import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { parseLearnArgs } from "../learning/cli-args";
import { loadLearningConfig } from "../learning/config";
import { buildProbePlan, hashProbeBytes, runProbeSession, findPublishedProbePlan } from "../learning/probe";
import { validateProbeTaskSet, type ProbeTaskSet } from "../learning/probe-schema";
import { readPattern } from "../learning/store";
import { loadShellConfig } from "../lib/shell-config";

export const PROBE_BASELINE = "Investigate this repository with read-only tools. Return only FILE: <relative-path> SYMBOL: <symbol>.";
export interface LearnProbeDeps {
  root: string;
  isTerminal?: boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  readLine?: (prompt: string) => Promise<string>;
  provider?: string;
  model?: string;
  commit?: string;
  now?: () => Date;
}
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const PROBE_HELP = "keryx learn probe <id> --task <task-id> [--task-set <path>] [--runs <n>] [--model <id>] [--provider <name>] [--max-usd <n>] [--dry-run] [--json]";

export async function runLearnProbe(args: readonly string[], deps: LearnProbeDeps): Promise<number> {
  const out = deps.stdout ?? console.log;
  const err = deps.stderr ?? console.error;
  if (args.includes("--help") || args.includes("-h")) { out(PROBE_HELP); return 0; }
  const parsed = parseLearnArgs(args, { boolean: ["--dry-run", "--json"],
    value: ["--task", "--task-set", "--runs", "--model", "--provider", "--max-usd"] });
  const json = parsed.flags.has("--json");
  const refuse = (reason: string): number => {
    if (json) out(JSON.stringify({ schemaVersion: 1, refusal: reason }));
    else err(`keryx learn probe: ${reason}`);
    return 2;
  };
  const id = parsed.positionals[0];
  const taskId = parsed.values.get("--task");
  const runs = Number(parsed.values.get("--runs") ?? 3);
  if (parsed.bad.length || parsed.positionals.length !== 1 || !id || !idPattern.test(id)
    || !taskId || !idPattern.test(taskId) || !Number.isSafeInteger(runs) || runs < 1
    || [...parsed.values].some(([key, value]) => key !== "--max-usd" && (!value.trim() || value.includes("\0"))))
    return refuse("probe-invalid-arguments");
  const dryRun = parsed.flags.has("--dry-run");
  const rawBudget = parsed.values.get("--max-usd");
  const budget = rawBudget === undefined ? null : Number(rawBudget);
  if ((!dryRun && budget === null) || (budget !== null && (!Number.isFinite(budget) || budget <= 0)))
    return refuse("probe-no-budget");
  try {
    const config = await loadLearningConfig(deps.root);
    let bytes: Buffer;
    let taskSet: ProbeTaskSet;
    try {
      bytes = await readFile(path.resolve(deps.root, parsed.values.get("--task-set") ?? config.probe.defaultTaskSet));
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (!validateProbeTaskSet(value).ok) return refuse("probe-bad-task-set");
      taskSet = value as ProbeTaskSet;
    } catch { return refuse("probe-bad-task-set"); }
    const pattern = await readPattern(deps.root, id, "project");
    if (!pattern) {
      if (await readPattern(deps.root, id, "user")) return refuse("probe-user-scope-unsupported");
      return refuse("probe-ineligible-status");
    }
    const saved = loadShellConfig();
    const provider = parsed.values.get("--provider") ?? deps.provider ?? saved.provider;
    const model = parsed.values.get("--model") ?? deps.model ?? saved.model;
    if (!provider || !model) return refuse("probe-invalid-arguments");
    let commit: string;
    try { commit = deps.commit ?? (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: deps.root })).stdout.trim(); }
    catch { return refuse("probe-environment-mismatch"); }
    const environment = { provider, model, commit, baseRef: "HEAD", taskSetDigest: hashProbeBytes(bytes),
      baselineDigest: hashProbeBytes(JSON.stringify([PROBE_BASELINE, ["get_cwd", "list_dir", "read_file"], "probe-score-v1"])) };
    const recovery = await findPublishedProbePlan(deps.root, id, taskId, environment, { runs, maxUsd: budget });
    if (!recovery.ok) return refuse(recovery.reason);
    if (!recovery.value && pattern.status !== "candidate" && pattern.status !== "accepted") return refuse("probe-ineligible-status");
    const eligible = { ...pattern, status: pattern.status === "accepted" ? "accepted" as const : "candidate" as const };
    const plan = recovery.value ?? buildProbePlan({ pattern: eligible, taskId, runs, maxUsd: budget, estimateUsd: null,
      createdAt: (deps.now?.() ?? new Date()).toISOString(),
      environment: { provider, model, commit, baseRef: "HEAD", taskSetDigest: hashProbeBytes(bytes),
        baselineDigest: hashProbeBytes(JSON.stringify([PROBE_BASELINE, ["get_cwd", "list_dir", "read_file"], "probe-score-v1"])) } });
    if (dryRun) {
      out(json ? JSON.stringify({ schemaVersion: 1, dryRun: true, plan }) : JSON.stringify(plan, null, 2));
      return 0;
    }
    if (!(deps.isTerminal ?? (process.stdin.isTTY === true && process.stdout.isTTY === true))) return refuse("probe-no-tty");
    err(JSON.stringify(plan, null, 2));
    const prompt = `Type pattern id "${id}" to run both arms (${runs} seeds each), ceiling $${budget}: `;
    let answer: string;
    if (deps.readLine) answer = await deps.readLine(prompt);
    else {
      const terminal = createInterface({ input: process.stdin, output: process.stderr });
      try { answer = await terminal.question(prompt); } finally { terminal.close(); }
    }
    if (answer.trim() !== id) return refuse("probe-invalid-arguments");
    const { runNativeProbe } = await import("../harness/probe/native-turn");
    const task = taskSet.tasks.find((entry) => entry.id === taskId);
    const result = await runProbeSession(deps.root, plan, (session) => runNativeProbe(session, task));
    if (!result.ok) {
      if (result.reason !== "probe-run-failed") return refuse(result.reason);
      err(result.message); return 1;
    }
    const { comparison, finalization } = result.value;
    out(json ? JSON.stringify({ schemaVersion: 1, comparison, finalization }) : `${comparison.verdict}: ${comparison.reason ?? "measured"}`);
    return comparison.verdict === "unmeasurable" || finalization.evidence === "skipped" ? 3 : 0;
  } catch (error) {
    err(`keryx learn probe: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
