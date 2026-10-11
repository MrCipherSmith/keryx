// The autonomous review runner: `keryx review run --autonomous`.
//
// It starts `keryx shell --print` in the review-autonomous profile as a child with no stdin and
// output in files, watches the child's events file, and decides how the run ended. It never talks
// to the child: a floor ask is denied on end-of-input, a question is answered by the safe default
// (`autonomous-answers`), and the runner's whole job is to keep the clock, the budget, the lock and
// the record.

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV_AUTONOMOUS_ANSWERS_FILE, readAutoAnswers } from "./autonomous-answers";
import {
  AUTONOMOUS_PROFILE,
  buildAutonomousPrompt,
  buildAutonomousShellArgv,
  exitCodeFor,
  parseAutonomousTarget,
  type AutonomousStatus,
  type AutonomousTarget,
} from "./autonomous-profile";
import { createEventTail, type Progress } from "./autonomous-progress";
import { countFindings, validateSummary, writeSummary, type AutonomousSummary } from "./autonomous-summary";
import { ENV_REVIEW_SYSTEM } from "./review-system";
import type { ManagedReviewManifest, ReviewPackageStatus } from "./types";

export interface ChildSpec {
  /** Arguments after `keryx`. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly runDir: string;
  readonly eventsFile: string;
  readonly answersFile: string;
  readonly logFile: string;
  /** Always `ignore`: the run has no terminal and nobody to type into one. */
  readonly stdin: "ignore";
}

export interface ChildHandle {
  readonly exited: Promise<number>;
  kill(signal?: "SIGTERM" | "SIGKILL"): void;
}

export type SpawnChild = (spec: ChildSpec) => ChildHandle;

export interface AutonomousRunOptions {
  readonly cwd: string;
  readonly ref: string;
  readonly budgetMinutes?: number | undefined;
  readonly budgetTokens?: number | undefined;
  /** Where the run's own files go. Default: `.metaproject/data/review-autonomous/<owner>-<repo>-pr<N>`. */
  readonly out?: string | undefined;
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly stallMs?: number | undefined;
  readonly pollMs?: number | undefined;
  /** How long a budget stop waits for a tool call in flight before it kills the child. */
  readonly budgetGraceMs?: number | undefined;
  /** How long a SIGTERM gets before SIGKILL. */
  readonly killGraceMs?: number | undefined;
  readonly spawn?: SpawnChild | undefined;
  readonly command?: { readonly execPath: string; readonly script: string } | undefined;
  readonly resolveHead?: ((target: AutonomousTarget, cwd: string) => Promise<string | null>) | undefined;
  readonly onProgress?: ((progress: RunProgress) => void) | undefined;
  /** Aborting it stops the run at the next poll: the child is ended and the package kept. */
  readonly signal?: AbortSignal | undefined;
}

export interface RunProgress {
  readonly state: "running" | AutonomousStatus;
  readonly ref: string;
  readonly phase: string;
  readonly rounds: number;
  readonly tokens: number;
  readonly startedAt: string;
  readonly pid: number;
  readonly packageId?: string;
  readonly lastAnswer?: { readonly question: string; readonly answer: string; readonly basis: string };
  readonly exitCode?: number;
  readonly reason?: string;
}

export interface AutonomousRunResult {
  readonly exitCode: number;
  readonly status: AutonomousStatus;
  readonly summary: AutonomousSummary;
  readonly runDir: string;
  readonly reused: boolean;
}

export class AutonomousRunLockedError extends Error {
  constructor(
    readonly pid: number,
    readonly startedAt: string,
    readonly runDir: string,
  ) {
    super(`an autonomous review of this pull request is already running (pid ${pid}, started ${startedAt}); stop it or wait: ${runDir}`);
    this.name = "AutonomousRunLockedError";
  }
}

interface RunState {
  head: string | null;
  attempts: number;
  packageId: string | null;
  tokens: number;
  rounds: number;
}

export function autonomousRunDir(cwd: string, target: AutonomousTarget): string {
  const slug = `${target.repository.replace("/", "-")}-pr${target.number}`;
  return path.join(cwd, ".metaproject", "data", "review-autonomous", slug);
}

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function writeJson(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function acquireLock(runDir: string): () => void {
  const file = path.join(runDir, "lock.json");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = readJson<{ pid?: number; startedAt?: string }>(file);
      if (held?.pid !== undefined && pidAlive(held.pid)) throw new AutonomousRunLockedError(held.pid, held.startedAt ?? "unknown", runDir);
      rmSync(file, { force: true });
    }
  }
  throw new AutonomousRunLockedError(0, "unknown", runDir);
}

interface FoundPackage {
  readonly id: string;
  readonly status: ReviewPackageStatus;
  readonly dir: string;
}

function sameTarget(manifest: ManagedReviewManifest, target: AutonomousTarget): boolean {
  const ref = manifest.target?.ref;
  if (typeof ref !== "string") return false;
  if (ref === target.ref) return true;
  try {
    const other = parseAutonomousTarget(ref);
    return other.repository === target.repository && other.number === target.number;
  } catch {
    return false;
  }
}

function listPackages(cwd: string, target: AutonomousTarget): FoundPackage[] {
  const root = path.join(cwd, ".metaproject", "reviews");
  if (!existsSync(root)) return [];
  const found: Array<FoundPackage & { at: number }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const manifest = readJson<ManagedReviewManifest>(path.join(dir, "manifest.json"));
    if (manifest === undefined || !sameTarget(manifest, target)) continue;
    const stamp = Date.parse(manifest.updatedAt ?? manifest.createdAt ?? "");
    found.push({ id: manifest.reviewId ?? entry.name, status: manifest.status, dir, at: Number.isNaN(stamp) ? 0 : stamp });
  }
  return found.sort((a, b) => b.at - a.at);
}

export async function resolveHeadWithGh(target: AutonomousTarget, cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("gh", ["pr", "view", target.ref, "--json", "headRefOid", "--jq", ".headRefOid"], { cwd, timeout: 30_000 }, (error, stdout) => {
      const head = error === null ? stdout.trim() : "";
      resolve(/^[0-9a-f]{7,64}$/i.test(head) ? head : null);
    });
  });
}

export function defaultSpawn(command?: { readonly execPath: string; readonly script: string }): SpawnChild {
  return (spec) => {
    const execPath = command?.execPath ?? process.execPath;
    const script = command?.script ?? process.argv[1] ?? "";
    const log = openSync(spec.logFile, "a");
    const child = nodeSpawn(execPath, [script, ...spec.argv], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      stdio: ["ignore", log, log],
    });
    closeSync(log);
    const exited = new Promise<number>((resolve) => {
      child.on("error", () => resolve(127));
      child.on("close", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
    });
    return { exited, kill: (signal) => void child.kill(signal ?? "SIGTERM") };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const fileSize = (file: string): number => (existsSync(file) ? statSync(file).size : 0);

export async function runAutonomousReview(options: AutonomousRunOptions): Promise<AutonomousRunResult> {
  const target = parseAutonomousTarget(options.ref);
  const runDir = options.out === undefined ? autonomousRunDir(options.cwd, target) : path.resolve(options.cwd, options.out);
  mkdirSync(runDir, { recursive: true });
  const release = acquireLock(runDir);
  try {
    return await runLocked(options, target, runDir);
  } finally {
    release();
  }
}

async function runLocked(options: AutonomousRunOptions, target: AutonomousTarget, runDir: string): Promise<AutonomousRunResult> {
  const { cwd } = options;
  const head = await (options.resolveHead ?? resolveHeadWithGh)(target, cwd);
  const stateFile = path.join(runDir, "run.json");
  const summaryFile = path.join(runDir, "summary.json");
  const prior = readJson<RunState>(stateFile);
  const sameHead = head !== null && prior !== undefined && prior.head === head;

  if (sameHead) {
    const previous = readJson<AutonomousSummary>(summaryFile);
    if (previous !== undefined && validateSummary(previous).length === 0 && previous.status === "complete") {
      return { exitCode: exitCodeFor("complete"), status: "complete", summary: previous, runDir, reused: true };
    }
  } else if (prior !== undefined && existsSync(summaryFile)) {
    renameSync(summaryFile, path.join(runDir, `summary.${(prior.head ?? "previous").slice(0, 8)}.json`));
  }

  const state: RunState = sameHead
    ? { ...prior, head, attempts: prior.attempts + 1 }
    : { head, attempts: 1, packageId: null, tokens: 0, rounds: 0 };

  const before = new Set(listPackages(cwd, target).map((p) => p.id));
  let resumePackage: string | undefined;
  if (sameHead && state.packageId !== null) {
    const known = listPackages(cwd, target).find((p) => p.id === state.packageId);
    if (known !== undefined && known.status !== "closed") resumePackage = known.id;
  }

  const eventsFile = path.join(runDir, "events.ndjson");
  const answersFile = path.join(runDir, "answers.ndjson");
  const logFile = path.join(runDir, "child.log");
  writeFileSync(eventsFile, "");
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const spec: ChildSpec = {
    argv: buildAutonomousShellArgv({
      prompt: buildAutonomousPrompt({ ref: target.ref, resumePackage }),
      eventsFile,
      provider: options.provider,
      model: options.model,
    }),
    env: { [ENV_REVIEW_SYSTEM]: AUTONOMOUS_PROFILE.reviewSystem, [ENV_AUTONOMOUS_ANSWERS_FILE]: answersFile },
    cwd,
    runDir,
    eventsFile,
    answersFile,
    logFile,
    stdin: "ignore",
  };

  const pollMs = options.pollMs ?? 1000;
  const stallMs = options.stallMs ?? AUTONOMOUS_PROFILE.stallMinutes * 60_000;
  const budgetMs = options.budgetMinutes === undefined ? undefined : options.budgetMinutes * 60_000;
  const graceMs = options.budgetGraceMs ?? 30_000;
  const killGraceMs = options.killGraceMs ?? 5000;

  const child = (options.spawn ?? defaultSpawn(options.command))(spec);
  let exitCode: number | undefined;
  void child.exited.then(
    (code) => {
      exitCode = code;
    },
    () => {
      exitCode = 1;
    },
  );

  const tail = createEventTail(eventsFile);
  let progress: Progress = tail.poll();
  let lastGrowth = Date.now();
  let lastSeen = -1;
  let stalled = false;
  let stopped = false;
  let budgetReason: string | undefined;
  let budgetHitAt = 0;
  let lastProgressJson = "";

  const currentPackage = (): FoundPackage | undefined => {
    const all = listPackages(cwd, target);
    return all.find((p) => p.id === resumePackage) ?? all.find((p) => !before.has(p.id));
  };

  const publish = (stateName: RunProgress["state"], extra: { exitCode?: number; reason?: string } = {}): void => {
    const answers = readAutoAnswers(answersFile);
    const last = answers[answers.length - 1];
    const pkg = currentPackage();
    const snapshot: RunProgress = {
      state: stateName,
      ref: target.ref,
      phase: progress.phase,
      rounds: state.rounds + progress.rounds,
      tokens: state.tokens + progress.tokens,
      startedAt,
      pid: process.pid,
      ...(pkg === undefined ? {} : { packageId: pkg.id }),
      ...(last === undefined ? {} : { lastAnswer: { question: last.question, answer: last.answer, basis: last.basis } }),
      ...extra,
    };
    const json = JSON.stringify(snapshot);
    if (json === lastProgressJson) return;
    lastProgressJson = json;
    try {
      writeJson(path.join(runDir, "progress.json"), { ...snapshot, updatedAt: new Date().toISOString() });
    } catch {
      // progress is an observation
    }
    options.onProgress?.(snapshot);
  };

  const terminate = async (): Promise<void> => {
    if (exitCode !== undefined) return;
    child.kill("SIGTERM");
    await Promise.race([child.exited.catch(() => undefined), sleep(killGraceMs)]);
    if (exitCode === undefined) {
      child.kill("SIGKILL");
      await Promise.race([child.exited.catch(() => undefined), sleep(2000)]);
    }
  };

  publish("running");
  while (exitCode === undefined) {
    await Promise.race([child.exited.catch(() => undefined), sleep(pollMs)]);
    progress = tail.poll();
    const seen = tail.bytesSeen() + fileSize(answersFile);
    const now = Date.now();
    if (seen !== lastSeen) {
      lastSeen = seen;
      lastGrowth = now;
    }
    publish("running");
    if (exitCode !== undefined) break;
    if (options.signal?.aborted === true) {
      stopped = true;
      await terminate();
      break;
    }
    if (now - lastGrowth >= stallMs) {
      stalled = true;
      await terminate();
      break;
    }
    if (budgetReason === undefined) {
      if (budgetMs !== undefined && now - startedAtMs >= budgetMs) {
        budgetReason = `wall-clock minute budget ${options.budgetMinutes} exceeded`;
      } else if (options.budgetTokens !== undefined && progress.tokens >= options.budgetTokens) {
        budgetReason = `token budget ${options.budgetTokens} reached (${progress.tokens} used)`;
      }
      if (budgetReason !== undefined) budgetHitAt = now;
    }
    if (budgetReason !== undefined && (progress.openCalls === 0 || now - budgetHitAt >= graceMs)) {
      await terminate();
      break;
    }
  }
  progress = tail.poll();

  const found = currentPackage();
  const answers = readAutoAnswers(answersFile);
  const lastAnswer = answers[answers.length - 1];
  const stallMinutes = Math.round((stallMs / 60_000) * 1000) / 1000;

  let status: AutonomousStatus;
  let reason: string;
  if (found?.status === "closed") {
    status = "complete";
    reason = `package ${found.id} closed`;
  } else if (stopped) {
    status = "incomplete";
    reason = `stopped by the operator; last phase: ${progress.phase}${found === undefined ? "" : `; package ${found.id} kept at ${found.status}`}`;
  } else if (stalled) {
    status = "stalled";
    reason = `no event for ${stallMinutes} minutes; last phase: ${progress.phase}`;
  } else if (budgetReason !== undefined) {
    status = "budget";
    reason = budgetReason;
  } else if (progress.floorRefusals.length > 0) {
    status = "floor";
    const first = progress.floorRefusals[0]!;
    reason = `a floor refused ${progress.floorRefusals.length} call(s) nobody could approve (first at ${first.phase}) and the package was not closed`;
  } else if (found === undefined) {
    status = "incomplete";
    reason = `the shell ended (exit ${exitCode ?? 1}) before a review package was opened`;
  } else {
    status = "incomplete";
    reason = `the shell ended (exit ${exitCode ?? 1}) with package ${found.id} at ${found.status}`;
  }

  const finishedAtMs = Date.now();
  const findings = found === undefined ? undefined : readJson<unknown>(path.join(found.dir, "findings.json"));
  const summary: AutonomousSummary = {
    schemaVersion: 1,
    profile: "review-autonomous",
    target: { kind: "pr", ref: target.ref, repository: target.repository, number: target.number, head },
    status,
    exitCode: exitCodeFor(status),
    reason,
    phase: progress.phase,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationSeconds: Math.round((finishedAtMs - startedAtMs) / 1000),
    attempts: state.attempts,
    rounds: state.rounds + progress.rounds,
    tokens: state.tokens + progress.tokens,
    package: found === undefined ? null : { id: found.id, status: found.status, path: path.relative(cwd, found.dir) },
    findings: countFindings(findings),
    floorRefusals: progress.floorRefusals.length,
    autoAnswers: {
      count: answers.length,
      ...(lastAnswer === undefined ? {} : { last: { question: lastAnswer.question, answer: lastAnswer.answer, basis: lastAnswer.basis } }),
    },
  };

  writeSummary(runDir, summary);
  writeJson(stateFile, {
    head,
    attempts: state.attempts,
    packageId: found?.id ?? state.packageId,
    tokens: summary.tokens,
    rounds: summary.rounds,
  } satisfies RunState);
  publish(status, { exitCode: summary.exitCode, reason });
  return { exitCode: summary.exitCode, status, summary, runDir, reused: false };
}
