// `keryx worktree` — get a linked git worktree ready to work in, and carry its
// findings out before it goes away (spec: worktree readiness, stage 1).
//
// Transport only: the decisions live in `src/worktree/`. None of these commands
// runs `git stash`, `git add`, a commit or a push.

import { createInterface } from "node:readline/promises";
import { optionValue, rejectUnknownFlags } from "../lib/args";
import {
  createWorktree,
  execInWorktree,
  formatExports,
  PREPARE_STEPS,
  prepareWorktree,
  promoteWorktree,
  PROMOTE_STORES,
  readWorktreeEnv,
  removeWorktree,
  resolveWorktreeContext,
  worktreeStatus,
  WorktreeRemoveRefusal,
  type PrepareReport,
  type PrepareStep,
  type PromoteReport,
  type PromoteStore,
  type WorktreeStatus,
} from "../worktree";

const CREATE_FLAGS = ["--base", "--branch", "--path", "--json"] as const;
const PREPARE_FLAGS = ["--only", "--json", "--force"] as const;
const PROMOTE_FLAGS = ["--store", "--dry-run", "--entry", "--json"] as const;
const STATUS_FLAGS = ["--json"] as const;
const REMOVE_FLAGS = ["--keep-branch", "--force"] as const;

/** Arguments that are neither flags nor the value of a value flag. */
function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument.startsWith("--")) {
      if (valueFlags.includes(argument)) index += 1;
      continue;
    }
    found.push(argument);
  }
  return found;
}

function exactlyOne(args: readonly string[], valueFlags: readonly string[], usage: string): string {
  const given = positionals(args, valueFlags);
  if (given.length !== 1) {
    throw new Error(`Usage: ${usage}`);
  }
  return given[0] as string;
}

function noPositionals(args: readonly string[], valueFlags: readonly string[], usage: string): void {
  if (positionals(args, valueFlags).length > 0) {
    throw new Error(`Usage: ${usage}`);
  }
}

function csv(args: readonly string[], flag: string): string[] | undefined {
  const raw = optionValue(args as string[], flag);
  if (raw === undefined) return args.some((a) => a === flag || a.startsWith(`${flag}=`)) ? [] : undefined;
  return raw.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

function printReport(report: PrepareReport): void {
  console.log(`prepared ${report.worktree} (checkout ${report.checkoutId})`);
  if (report.env !== undefined) {
    console.log(`env: copied ${report.env.copied.join(", ") || "none"}`);
    for (const skipped of report.env.skipped) console.log(`env: skipped ${skipped.file} (${skipped.reason})`);
  }
  if (report.deps !== undefined) {
    for (const dep of report.deps) console.log(`deps: ${dep.dir} ${dep.method}`);
  }
  if (report.ports !== undefined && Object.keys(report.ports).length > 0) {
    console.log(`ports: ${Object.entries(report.ports).map(([name, port]) => `${name}=${port}`).join(" ")}`);
  }
  if (report.indexes !== undefined) {
    for (const index of report.indexes) {
      console.log(`index: ${index.name} ${index.status}${index.entries !== undefined ? ` (${index.entries} entries)` : ""}${index.reason !== undefined ? ` (${index.reason})` : ""}`);
    }
  }
  for (const error of report.errors) console.error(`keryx worktree: ${error}`);
}

async function runCreate(args: string[]): Promise<void> {
  rejectUnknownFlags(args, CREATE_FLAGS, "worktree create", { valueFlags: ["--base", "--branch", "--path"] });
  const name = exactlyOne(args, ["--base", "--branch", "--path"], "keryx worktree create <name> [--base <ref>] [--branch <b>] [--path <dir>] [--json]");
  const base = optionValue(args, "--base");
  const branch = optionValue(args, "--branch");
  const target = optionValue(args, "--path");
  const result = await createWorktree({
    cwd: process.cwd(),
    name,
    ...(base !== undefined && { base }),
    ...(branch !== undefined && { branch }),
    ...(target !== undefined && { path: target }),
  });
  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`created ${result.path} on branch ${result.branch} (from ${result.base})`);
    printReport(result.prepare);
  }
  if (!result.prepare.ok) {
    console.error("keryx worktree: the worktree was kept; fix the cause and run `keryx worktree prepare` inside it");
    process.exitCode = 1;
  }
}

async function runPrepare(args: string[]): Promise<void> {
  rejectUnknownFlags(args, PREPARE_FLAGS, "worktree prepare", { valueFlags: ["--only"] });
  noPositionals(args, ["--only"], "keryx worktree prepare [--only env,deps,ports,indexes] [--json] [--force]");
  const only = csv(args, "--only");
  if (only !== undefined) {
    const unknown = only.filter((step) => !(PREPARE_STEPS as readonly string[]).includes(step));
    if (only.length === 0 || unknown.length > 0) {
      throw new Error(`--only takes a comma-separated subset of ${PREPARE_STEPS.join(", ")}${unknown.length > 0 ? ` (got ${unknown.join(", ")})` : ""}`);
    }
  }
  const report = await prepareWorktree({
    cwd: process.cwd(),
    ...(only !== undefined && { only: only as PrepareStep[] }),
    ...(args.includes("--force") && { force: true }),
  });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.ok) process.exitCode = 1;
}

async function confirmTypedId(id: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`Type the pattern id "${id}" to confirm: `)).trim() === id;
  } finally {
    rl.close();
  }
}

function printPromote(report: PromoteReport): void {
  const { candidates } = report;
  if (candidates.memory.length === 0 && candidates.learning.length === 0) {
    console.log("nothing to promote");
    return;
  }
  console.log(report.dryRun ? "would promote:" : "promoted:");
  for (const entry of candidates.memory) console.log(`  memory   ${entry.path} (${entry.state})`);
  for (const entry of candidates.learning) console.log(`  learning ${entry.id} (${entry.domain})`);
  if (!report.dryRun) {
    for (const item of report.promoted.memory) console.log(`memory: ${item.path} -> ${item.destination}`);
    for (const id of report.promoted.learning) console.log(`learning: ${id} -> user candidate`);
    for (const item of report.skipped) console.error(`keryx worktree: skipped ${item.store} ${item.entry}: ${item.reason}`);
  }
}

async function runPromote(args: string[]): Promise<void> {
  rejectUnknownFlags(args, PROMOTE_FLAGS, "worktree promote", { valueFlags: ["--store", "--entry"] });
  noPositionals(args, ["--store", "--entry"], "keryx worktree promote [--store memory,learning] [--dry-run] [--entry <id-or-path>]... [--json]");
  const stores = csv(args, "--store");
  if (stores !== undefined) {
    const unknown = stores.filter((store) => !(PROMOTE_STORES as readonly string[]).includes(store));
    if (stores.length === 0 || unknown.length > 0) {
      throw new Error(`--store takes a comma-separated subset of ${PROMOTE_STORES.join(", ")}${unknown.length > 0 ? ` (got ${unknown.join(", ")})` : ""}`);
    }
  }
  const entries = args.flatMap((argument, index) => (argument === "--entry" ? [args[index + 1] as string] : argument.startsWith("--entry=") ? [argument.slice("--entry=".length)] : []));
  const report = await promoteWorktree({
    cwd: process.cwd(),
    ...(stores !== undefined && { stores: stores as PromoteStore[] }),
    dryRun: args.includes("--dry-run"),
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    ...(entries.length > 0 && { entries }),
    confirm: confirmTypedId,
  });
  if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printPromote(report);
  if (report.skipped.length > 0) process.exitCode = 1;
}

async function runEnv(args: string[]): Promise<void> {
  rejectUnknownFlags(args, [], "worktree env");
  noPositionals(args, [], "keryx worktree env");
  const context = await resolveWorktreeContext(process.cwd());
  process.stdout.write(formatExports(await readWorktreeEnv(context.root)));
}

async function runExec(args: string[]): Promise<void> {
  const separator = args.indexOf("--");
  if (separator < 0 || separator === args.length - 1 || separator > 0) {
    throw new Error("Usage: keryx worktree exec -- <command> [args...]");
  }
  const context = await resolveWorktreeContext(process.cwd());
  process.exitCode = await execInWorktree({ cwd: context.root, argv: args.slice(separator + 1) });
}

function printStatus(status: WorktreeStatus): void {
  console.log(`${status.main ? "main checkout" : "worktree"} ${status.root}${status.branch !== undefined ? ` (${status.branch})` : ""}`);
  if (status.main) return;
  console.log(`checkout: ${status.checkout?.checkoutId ?? "unlabelled (run keryx worktree prepare)"}`);
  console.log(`prepared: ${status.prepare === undefined ? "never" : `${status.prepare.at} ${Object.entries(status.prepare.steps).map(([step, outcome]) => `${step}=${outcome}`).join(" ")}`}`);
  console.log(`ports: ${Object.entries(status.ports).map(([name, value]) => `${name}=${value}`).join(" ") || "none"}`);
  console.log(`deps: ${status.deps.map((dep) => `${dep.dir} ${dep.method}`).join(", ") || "none"}`);
  console.log(`env files: ${status.envFiles.join(", ") || "none"}`);
  console.log(`unpromoted: ${status.unpromoted.memory.length} memory, ${status.unpromoted.learning.length} learning`);
  if (status.configError !== undefined) console.log(`config: ${status.configError}`);
}

async function runStatus(args: string[]): Promise<void> {
  rejectUnknownFlags(args, STATUS_FLAGS, "worktree status");
  noPositionals(args, [], "keryx worktree status [--json]");
  const status = await worktreeStatus(process.cwd());
  if (args.includes("--json")) console.log(JSON.stringify(status, null, 2));
  else printStatus(status);
}

async function runRemove(args: string[]): Promise<void> {
  rejectUnknownFlags(args, REMOVE_FLAGS, "worktree remove");
  const name = exactlyOne(args, [], "keryx worktree remove <name> [--keep-branch] [--force]");
  try {
    const result = await removeWorktree({
      cwd: process.cwd(),
      name,
      keepBranch: args.includes("--keep-branch"),
      force: args.includes("--force"),
    });
    console.log(`removed ${result.path}`);
    if (result.portsReleased) console.log("ports released");
    if (result.branchDeleted) console.log(`deleted branch ${result.branch}`);
    else if (result.branch !== undefined) console.log(`kept branch ${result.branch}${result.branchKept !== undefined ? ` (${result.branchKept})` : ""}`);
  } catch (cause) {
    if (cause instanceof WorktreeRemoveRefusal) {
      console.error(`keryx worktree: ${cause.message}`);
      process.exitCode = 1;
      return;
    }
    throw cause;
  }
}

export function printWorktreeHelp(): void {
  console.log(`keryx worktree

Get a linked git worktree ready to work in, and carry its findings out before
it is removed. Never runs git stash, add, commit or push.

Usage:
  keryx worktree create <name> [--base <ref>] [--branch <b>] [--path <dir>] [--json]
  keryx worktree prepare [--only env,deps,ports,indexes] [--json] [--force]
  keryx worktree promote [--store memory,learning] [--dry-run] [--entry <id-or-path>]... [--json]
  keryx worktree env
  keryx worktree exec -- <command> [args...]
  keryx worktree status [--json]
  keryx worktree remove <name> [--keep-branch] [--force]

Settings: .metaproject/worktree.config.json (optional).
`);
}

export async function worktreeCommand(args: string[]): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    printWorktreeHelp();
    return;
  }
  const rest = args.slice(1);
  if (command === "create") return runCreate(rest);
  if (command === "prepare") return runPrepare(rest);
  if (command === "promote") return runPromote(rest);
  if (command === "env") return runEnv(rest);
  if (command === "exec") return runExec(rest);
  if (command === "status") return runStatus(rest);
  if (command === "remove") return runRemove(rest);

  console.error(`Unknown worktree command: ${command}`);
  printWorktreeHelp();
  process.exitCode = 1;
}
