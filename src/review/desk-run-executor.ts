// A Desktop attempt owns its Git objects, trusted control workspace and durable evidence.
import { execFile } from "node:child_process";
import { existsSync, renameSync, writeFileSync } from "node:fs";
import { PR_CONTEXT_FILE, type collectPrContext } from "./pr-context";
import { cp, lstat, mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { invocationArgv, resolveKeryxInvocation } from "../trigger/schedule";
import { isCompiledBinaryEntry } from "../lib/self-invocation";
import { readProcessIdentity } from "../lib/hub-machine/process-identity";
import { revisionOperand } from "../lib/git-revision";
import { shellQuote } from "../lib/shell-quote";
import { writeFileAtomic } from "../lib/fs";
import { runAutonomousReview, defaultSpawn, privateGitEnv, type ChildHandle, type SpawnChild, type RunProgress } from "./autonomous-run";
import type { ReviewRunUsage } from "./run-usage";
import { countFindings, knownFindingList, renderReport, type AutonomousSummary, type FindingCounts } from "./autonomous-summary";
import { computeVerdict, renderVerdict } from "./verdict";
import { boardGraphql, reviewTool } from "./board-github";
import type { ManagedReviewManifest } from "./types";
import { DESK_RUN_SCOPE } from "./desk-run-types";
import { checkoutIsDisposable, checkedDeskSummary, saveDeskSummary, deskVerdictHeadline, completeDeskCoverage, recordedSha, recoverDeskExecution } from "./desk-run-executor-recovery";
import { DESK_REVIEW_PROJECT_ROOT, DESK_REVIEW_SHELL } from "./autonomous-profile";
import { isReviewPackageDir } from "./package-location";
export { recoverDeskExecution } from "./desk-run-executor-recovery";

interface DeskExecutionOptions {
  context?: Awaited<ReturnType<typeof collectPrContext>>;
  cwd: string;
  repo: string;
  number: number;
  baseSha: string;
  headSha: string;
  runDir: string;
  previousRunDir?: string | undefined;
  signal: AbortSignal;
  budgetMinutes?: number;
  budgetTokens?: number | null;
  verifyBeforeExecution?: () => Promise<void>;
  authorizeSpawn?: <T>(commit: () => T) => T;
  onProgress: (progress: Pick<RunProgress, "phase" | "rounds" | "tokens" | "usage" | "reviewerSessions" | "packageId">) => void;
}

export interface DeskExecutionResult {
  outcome: "complete" | "incomplete" | "blocked" | "budget" | "failed" | "cancelled";
  reason: string;
  retryableBeforeSpend?: boolean;
  usage?: ReviewRunUsage;
  checkedBase: string | null;
  checkedHead: string | null;
  coverage: "complete" | "partial" | "unknown";
  verdict: string | null;
  findings: FindingCounts;
  findingsKnown?: boolean;
  report: string | null;
}

interface PullRevision { baseRefName: string; baseRefOid: string; headRefOid: string; state: string }
interface ControlRef { name: string; oid: string }
interface Revision extends PullRevision { defaultBranch?: ControlRef }
export type DeskModelSelector = (cwd: string) => Promise<{ provider: string; model: string }> | { provider: string; model: string };

interface ExecutorPorts {
  selectModel: DeskModelSelector;
  remoteUrl?: string;
  revision?: (options: DeskExecutionOptions) => Promise<Revision>;
  spawn?: SpawnChild;
}

const exec = promisify(execFile);
const fullSha = /^[0-9a-f]{40}$/;
const EMPTY: DeskExecutionResult = {
  outcome: "incomplete", reason: "", checkedBase: null, checkedHead: null,
  coverage: "unknown", verdict: null, findings: countFindings(null), findingsKnown: false, report: null,
};
async function revision({ repo, number, cwd }: DeskExecutionOptions): Promise<Revision> {
  const [owner, name] = repo.split("/");
  const data = await boardGraphql<{ repository?: {
    pullRequest?: PullRevision | null;
    defaultBranchRef?: { name: string; target?: { oid?: string } } | null;
  } | null }>(cwd, `query($owner:String!,$name:String!,$number:Int!) {
    repository(owner:$owner,name:$name) {
      pullRequest(number:$number) { baseRefName baseRefOid headRefOid state }
      defaultBranchRef { name target { oid } }
    }
  }`, { owner: owner!, name: name!, number });
  const pull = data.repository?.pullRequest;
  if (!pull) throw new Error("access: The selected pull request is no longer available.");
  const branch = data.repository?.defaultBranchRef;
  const oid = recordedSha(branch?.target?.oid);
  return { ...pull, ...(branch && oid ? { defaultBranch: { name: branch.name, oid } } : {}) };
}

async function git(cwd: string, args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec(reviewTool("git"), ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd, signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...privateGitEnv(), GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    return stdout.trimEnd();
  } catch {
    signal.throwIfAborted();
    throw new Error(`Private review checkout: git ${args.find(arg => !arg.startsWith("-") && !arg.includes("=")) ?? "operation"} failed. Verify the GitHub account and retry.`);
  }
}

async function prepareCheckout(options: DeskExecutionOptions, checkout: string, ports: ExecutorPorts,
  readRevision: () => Promise<Revision>) {
  const { cwd, repo, number, signal, baseSha, headSha } = options;
  if (!recordedSha(baseSha) || !recordedSha(headSha)) throw new Error("Invalid commit ID for the private review checkout.");
  const matchesRequest = (pr: Revision) => pr.state === "OPEN" && pr.baseRefOid === baseSha && pr.headRefOid === headSha;
  const pull = await readRevision();
  if (!matchesRequest(pull)) return false;
  await git(cwd, ["clone", "--no-checkout", "--no-tags", "--", cwd, checkout], signal);
  const run = (args: string[]) => git(checkout, args, signal);
  const baseRef = `refs/remotes/origin/${pull.baseRefName}`;
  await run(["check-ref-format", baseRef]);
  await run(["remote", "set-url", "origin", ports.remoteUrl ?? `https://github.com/${repo}.git`]);
  await run(["remote", "set-url", "--push", "origin", "file:///dev/null"]);
  const fetch = (...refs: string[]) => run(["-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential",
    "fetch", "--no-tags", "origin", ...refs]);
  await fetch(`+refs/heads/${pull.baseRefName}:${baseRef}`, `+refs/pull/${number}/head:refs/keryx/review-head`);
  if (await run(["rev-parse", "refs/keryx/review-head"]) !== headSha) return false;
  if (await run(["rev-parse", "--verify", ...revisionOperand(baseRef)]) !== baseSha) {
    // GitHub can retain this PR's base OID after its target branch advances. Accept only a commit
    // reachable from the fetched base branch, and recheck GitHub before keeping the older range.
    const containing = await run(["for-each-ref", "--contains", baseSha, "--format=%(refname)", baseRef]);
    if (!containing.split("\n").includes(baseRef)) return false;
    const confirmed = await readRevision();
    if (!matchesRequest(confirmed) || confirmed.baseRefName !== pull.baseRefName) return false;
  }
  // Project controls come from GitHub's default branch. A locally checked-out PR
  // and a PR-selected comparison branch remain inputs to the diff only.
  const verifyPolicy = async (policy: ControlRef, reuseBase: boolean) => {
    const policyRef = reuseBase && policy.name === pull.baseRefName ? baseRef : "refs/keryx/review-controls";
    if (policyRef !== baseRef) {
      const source = `refs/heads/${policy.name}`;
      await run(["check-ref-format", source]);
      await fetch(`+${source}:${policyRef}`);
    }
    return await run(["rev-parse", "--verify", ...revisionOperand(policyRef)]) === policy.oid ? policy.oid : null;
  };
  let controlsHead: string | null = null;
  if (pull.defaultBranch) {
    controlsHead = await verifyPolicy(pull.defaultBranch, true).catch(() => {
      signal.throwIfAborted();
      return null;
    });
    if (!controlsHead) {
      const refreshed = await readRevision();
      if (!matchesRequest(refreshed) || refreshed.baseRefName !== pull.baseRefName) return false;
      if (refreshed.defaultBranch) {
        controlsHead = await verifyPolicy(refreshed.defaultBranch, false).catch(() => {
          signal.throwIfAborted();
          return null;
        });
      }
      if (!controlsHead) throw new Error("unavailable: The default branch changed or could not be verified. Retry the review.");
    }
  }
  // No PR file ever becomes an active policy, preload, smudge filter, or runnable project hook.
  // Source reads use the pinned Git objects. The index stays at head for existing range tools.
  await run(["config", "core.hooksPath", "/dev/null"]);
  await run(["sparse-checkout", "set", "--no-cone", "!/*"]);
  if (controlsHead) {
    await run(["checkout", "--detach", controlsHead]);
    const controls = [".metaproject/rules", ".metaproject/skills", ".metaproject/project-skills",
      ".metaproject/index.md", ".metaproject/metaproject.json", "AGENTS.md", "CLAUDE.md", "routing.config.json",
      ".metaproject/routing.md", ".metaproject/modules", ".metaproject/wiki/index.md", ".metaproject/data/testing/context.md"];
    const configFiles = (await run(["ls-tree", "--name-only", "-z", controlsHead + ":.metaproject"]).catch(() => ""))
      .split("\0").filter(file => /^[\w.-]+\.config\.json$/.test(file)).map(file => ".metaproject/" + file);
    const paths = (await run(["ls-tree", "--name-only", "-z", controlsHead, "--", ...controls, ...configFiles])).split("\0").filter(Boolean);
    if (paths.length) await run(["restore", "--source", controlsHead, "--ignore-skip-worktree-bits", "--worktree", "--", ...paths]);
  }
  const root = path.join(checkout, ".metaproject");
  const skill = path.join(root, "skills/gdskills/review/review-orchestrator/SKILL.md");
  if (!existsSync(skill)) {
    const { installGdskills } = await import("../gdskills/install");
    await mkdir(root, { recursive: true });
    if (isCompiledBinaryEntry(process.argv[1] ?? "")) {
      const resources = path.resolve(path.dirname(process.execPath), "../Resources");
      if (!existsSync(path.join(resources, "review-skills", "review", "review-orchestrator", "SKILL.md"))) {
        throw new Error("This Keryx installation has no bundled review-orchestrator skills. Use a matching Desktop or CLI installation.");
      }
      await cp(path.join(resources, "review-skills"), path.join(root, "skills/gdskills"), { recursive: true, force: false });
      await cp(path.join(resources, "review-rules"), path.join(root, "rules"), { recursive: true, force: false });
    } else {
      await installGdskills(root, "full");
    }
    if (!existsSync(skill)) throw new Error("The trusted review-orchestrator skill is unavailable in this Keryx installation.");
  }
  // Only now point at the submitted commit. read-tree without -u touches the
  // index only, so a submitted .gitattributes cannot select a checkout filter.
  await run(["update-ref", "--no-deref", "HEAD", headSha]);
  await run(["read-tree", headSha]);
  return true;
}

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
}

// The child and every reviewer tool use the same CLI build, including when a GUI
// has no keryx on PATH. Quote source checkout paths that contain spaces.
async function withKeryxOnPath(runDir: string): Promise<string> {
  const bin = path.join(runDir, "bin");
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const shim = path.join(bin, "keryx");
  const argv = invocationArgv(resolveKeryxInvocation());
  await writeFileAtomic(shim, "#!/bin/sh\nexec " + argv.map(shellQuote).join(" ") + ' "$@"\n', { mode: 0o700 });
  return [bin, process.env.PATH ?? "/usr/bin:/bin"].join(path.delimiter);
}

async function regularPackage(dir: string) {
  if (!(await lstat(dir)).isDirectory()) return false;
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.every(entry => entry.isFile() || entry.isDirectory());
}

// Only expose known artifact names from a package created in this attempt.
async function collectResult(options: DeskExecutionOptions, checkout: string, summary: AutonomousSummary): Promise<DeskExecutionResult> {
  const result = { ...EMPTY, ...(summary.usage ? { usage: summary.usage } : {}), reason: summary.reason, report: "", findings: summary.findings, findingsKnown: summary.findingsKnown ?? Object.values(summary.findings).some(n => n > 0) };
  const pkg = summary.package;
  const source = pkg && path.resolve(checkout, pkg.path);
  const dir = path.join(options.runDir, "package");
  const root = path.join(checkout, ".metaproject", "reviews");
  const ownsPackage = source && path.dirname(source) === root && isReviewPackageDir(source, checkout) && await regularPackage(source);
  if (ownsPackage) await rename(source, dir);
  const manifest = ownsPackage ? await readJson<ManagedReviewManifest>(path.join(dir, "manifest.json")) : null;
  const checkedBase = recordedSha(manifest?.target?.base);
  const checkedHead = recordedSha(manifest?.target?.head);
  const matching = checkedBase === options.baseSha && checkedHead === options.headSha &&
    manifest?.target.ref === `https://github.com/${options.repo}/pull/${options.number}`;
  let outcome: DeskExecutionResult["outcome"] = summary.status === "floor" ? "blocked" : summary.status === "stalled" ? "incomplete" : summary.status;
  let coverage: DeskExecutionResult["coverage"] = "unknown";
  let verdict: string | null = null;
  if (ownsPackage && manifest) {
    const entries = Array.isArray(manifest.coverage) ? manifest.coverage : [];
    const evaluated = await computeVerdict(dir);
    const ingested = knownFindingList(await readJson<unknown>(path.join(dir, "findings.json")));
    const known = evaluated.source === "raw reviewer results" || (evaluated.source === "ingested round" && ingested);
    if (entries.length && known) {
      coverage = matching && manifest.status === "closed" && outcome === "complete" && ingested &&
        completeDeskCoverage(dir, entries, summary.usage, evaluated, true) ? "complete" : "partial";
    }
    if (known) {
      result.findingsKnown = true;
      result.findings = evaluated.counts;
      // The intermediate headline "no findings" alone is not an approval.
      if (matching) verdict = deskVerdictHeadline(evaluated, coverage === "complete");
      result.report += "\n" + renderVerdict(evaluated, manifest.reviewId);
    }
    const file = path.join(dir, "report.md");
    if ((await lstat(file).catch(() => undefined))?.isFile()) {
      result.report += "\n" + (await readFile(file, "utf8"));
    }
  }
  if (outcome === "complete" && (!matching || coverage !== "complete")) {
    outcome = "incomplete";
    result.reason = !matching ? "The package did not confirm the requested base and head." : "The closed package lacks complete reviewer coverage.";
  }
  if (!pkg && summary.status === "incomplete") {
    result.reason += " Check the selected model provider and its sign-in in Keryx Settings, then retry.";
  }
  if (options.signal.aborted && summary.status !== "complete") {
    outcome = "cancelled";
    result.reason = "Stopped by the operator.";
  }
  const saved = checkedDeskSummary(summary, { ...result, outcome }, !!ownsPackage);
  result.report = renderReport(saved) + result.report;
  await saveDeskSummary(options.runDir, saved, result.report);
  return { ...result, outcome, coverage, checkedBase, checkedHead, verdict };
}

function retryablePreflight(error: unknown) {
  return error instanceof Error && (error.message.startsWith("unavailable:") || error.message.startsWith("stale:"));
}

export async function executeDeskReview(options: DeskExecutionOptions, ports: ExecutorPorts): Promise<DeskExecutionResult> {
  const { runDir, signal } = options;
  if (!path.isAbsolute(runDir) || !fullSha.test(options.baseSha) || !fullSha.test(options.headSha) ||
      !/^[\w-]+\/[\w.-]+$/.test(options.repo) || !Number.isSafeInteger(options.number) || options.number < 1) {
    throw new Error("Invalid fixed review target.");
  }
  const checkout = path.join(runDir, "checkout");
  const runnerDir = path.join(runDir, "run");
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  let result: DeskExecutionResult;
  let beforeSpawnFailure = false;
  const launch: { child?: ChildHandle } = {};
  let checkoutMayBeRemoved = true;
  const subject = `https://github.com/${options.repo}/pull/${options.number}`;
  try {
    signal.throwIfAborted();
    options.onProgress({ phase: "Preparing isolated checkout", rounds: 0, tokens: 0 });
    const readRevision = async () => {
      try {
        return await (ports.revision ?? revision)(options);
      } catch (error) {
        beforeSpawnFailure = retryablePreflight(error);
        throw error;
      }
    };
    const prepared = await prepareCheckout(options, checkout, ports, readRevision).catch(error => {
      beforeSpawnFailure = retryablePreflight(error);
      throw error;
    });
    if (!prepared) {
      result = { ...EMPTY, outcome: "blocked", reason: "The PR closed or its base/head changed. Refresh the card before starting another review." };
    } else {
      if (options.context) writeFileSync(path.join(checkout, PR_CONTEXT_FILE), JSON.stringify(options.context), { flag: "wx", mode: 0o600 });
      const previous = options.previousRunDir && path.join(options.previousRunDir, "package");
      if (previous) {
        const manifest = await readJson<ManagedReviewManifest>(path.join(previous, "manifest.json"));
        if (manifest?.status === "closed" && await regularPackage(previous) && manifest.target?.ref === subject && /^[\w.-]+$/.test(manifest.reviewId) && ![".", ".."].includes(manifest.reviewId)) {
          await cp(previous, path.join(checkout, ".metaproject", "reviews", manifest.reviewId), { recursive: true });
        }
      }
      signal.throwIfAborted();
      const childFile = path.join(runDir, "child.json");
      const spawn = ports.spawn ?? defaultSpawn(undefined, childFile);
      const searchPath = await withKeryxOnPath(runDir);
      try {
        await options.verifyBeforeExecution?.();
      } catch (error) {
        beforeSpawnFailure = retryablePreflight(error);
        throw error;
      }
      signal.throwIfAborted();
      const selection = await ports.selectModel(options.cwd);
      signal.throwIfAborted();
      const execution = await runAutonomousReview({
        ...selection,
        cwd: checkout, ref: subject, fixedBase: options.baseSha, out: runnerDir, signal,
        resolveHead: async () => options.headSha, budgetMinutes: options.budgetMinutes ?? 30, budgetTokens: options.budgetTokens ?? undefined,
        onProgress: options.onProgress,
        spawn(spec) {
          let attempted = false;
          const start = () => {
            // Commit the PID guard inside the policy fence: this is when the reviewer
            // shell is released to spend budget, even if its parent crashes next.
            attempted = true;
            const child = launch.child = spawn({ ...spec, env: { ...spec.env, PATH: searchPath, KERYX_UNATTENDED: "1", [DESK_REVIEW_SHELL]: "1", [DESK_REVIEW_PROJECT_ROOT]: path.resolve(options.cwd) } });
            if (child.pid) {
              try {
                const identity = readProcessIdentity(child.pid);
                writeFileSync(childFile + ".tmp", JSON.stringify({ pid: child.pid, identity }), { mode: 0o600 });
                renameSync(childFile + ".tmp", childFile);
              } catch (error) { child.kill("SIGKILL"); throw error; }
            }
            return child;
          };
          try {
            return options.authorizeSpawn ? options.authorizeSpawn(start) : start();
          } catch (error) {
            beforeSpawnFailure = !attempted && retryablePreflight(error);
            throw error;
          }
        },
      });
      result = await collectResult(options, checkout, execution.summary);
    }
  } catch (error) {
    result = { ...EMPTY, ...(beforeSpawnFailure && !signal.aborted ? { retryableBeforeSpend: true } : {}), outcome: signal.aborted ? "cancelled" : error instanceof Error && error.message.startsWith("stale:") ? "blocked" : "failed", reason: signal.aborted ? "Stopped by the operator." : error instanceof Error ? error.message : "Review execution failed." };
    const child = launch.child;
    if (child) {
      // The runner normally reaps the child. Keep ownership here too in case
      // the guarded launch failed before handing its handle to the runner.
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
      try {
        const recovered = await recoverDeskExecution(runDir, {
          ...options, scope: DESK_RUN_SCOPE, cancelled: signal.aborted, interruption: result,
        });
        if (recovered) result = recovered;
        checkoutMayBeRemoved = await checkoutIsDisposable(runDir);
      } catch {
        checkoutMayBeRemoved = false; // Leave evidence available if it could not be archived.
      }
    }
  }
  await writeFileAtomic(path.join(runDir, "execution-result.json"), JSON.stringify(result), { mode: 0o600 });
  // The committed outcome remains authoritative even if a filesystem refuses
  // best-effort disposal of this attempt's temporary checkout.
  await Promise.allSettled([
    ...(checkoutMayBeRemoved ? [rm(checkout, { recursive: true, force: true })] : []),
    rm(path.join(runDir, "child.json"), { force: true }),
  ]);
  return result;
}
