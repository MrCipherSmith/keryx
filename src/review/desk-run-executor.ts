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
import { isNotFound, writeFileAtomic } from "../lib/fs";
import { placePathWithinSync, realOrResolved } from "../lib/contained-path";
import { runAutonomousReview, defaultSpawn, privateGitEnv, type ChildHandle, type SpawnChild, type RunProgress } from "./autonomous-run";
import type { ReviewRunUsage } from "./run-usage";
import { countFindings, knownFindingList, renderReport, type AutonomousSummary, type FindingCounts } from "./autonomous-summary";
import { computeVerdict, premiseRecords, renderVerdict } from "./verdict";
import { boardGh, boardGraphql, projectGithubConnection, reviewTool, verifyGithubBindingUnchanged, type GithubConnection } from "./board-github";
import { withoutGithubCredentials } from "./github-cli";
import type { ManagedReviewManifest } from "./types";
import { DESK_OPTIONS_ENV, deskOptionsKey, type DeskReviewOptions } from "./desk-run-options";
import { DESK_RUN_SCOPE } from "./desk-run-types";
import { checkoutIsDisposable, checkedDeskSummary, saveDeskSummary, deskVerdictHeadline, completeDeskCoverage, recordedSha, recoverDeskExecution } from "./desk-run-executor-recovery";
import { DESK_REPORT_OVERLAY_FILE, DESK_REVIEW_HEAD, DESK_REVIEW_PROJECT_ROOT, DESK_REVIEW_RESUME_PACKAGE, DESK_REVIEW_SHELL, exitCodeFor } from "./autonomous-profile";
import { isReviewPackageDir } from "./package-location";
import { DESK_RELATED_PRS, linkedReviewPulls, relatedPullGitDir, type RelatedReviewPull } from "./desk-related-prs";
import { finishAutoDesktopReview } from "./desk-auto-finalize";
import { applyReviewOverlay, DESK_TEMPLATE_SELECTION, deskReportEvidence, deskReportFinding, deskReportRecommendation, projectReportSlots, projectReviewOverlay,
  renderDeskReviewReport, reportFindingMetadata, reportTemplateFingerprint, reviewReportDisclosure, scopedFile } from "./desk-review-report";
import { readRoundNumber } from "./round-record";
import { recordPartialRound } from "./round-registry";
import type { PreviousRunInput } from "./update-round";
import { mainReviewRoot } from "./report-overlay";
import { askDesktopOperator } from "./desk-questions";
import { estimatePlan, planConfirmed, recordPlanConfirmation } from "./plan-confirmation";
import { DEFAULT_MAX_PASSES } from "./chunks-estimate";
import { REVIEW_WAVE_MAX_CHILDREN } from "./wave-limits";
export { recoverDeskExecution } from "./desk-run-executor-recovery";

interface DeskExecutionOptions {
  options?: DeskReviewOptions;
  context?: Awaited<ReturnType<typeof collectPrContext>>;
  cwd: string;
  repo: string;
  number: number;
  viewer?: string;
  baseSha: string;
  headSha: string;
  runDir: string;
  /**
   * The earlier-round attempts this round may build on, in the order to try them (update-round.ts `previousRoundAttempts`).
   * The first whose package can be handed on is: a closed package, or, for an attempt that ended partial, a draft package
   * with an ingested findings list, handed on as a partial round (flow 520 AC7, T14 B1). Either only when its manifest
   * names the range the attempt reviewed (T16 B3).
   */
  previousRuns?: readonly PreviousRunInput[] | undefined;
  resumeRunDir?: string;
  guidance?: string;
  operatorRunId?: string;
  isWaitingForOperator?: () => boolean;
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

interface PullRevision { baseRefName: string; baseRefOid: string; headRefOid: string; state: string; body?: string }
interface ControlRef { name: string; oid: string }
interface Revision extends PullRevision { defaultBranch?: ControlRef }
export type DeskModelSelector = (cwd: string) => Promise<{ provider: string; model: string }> | { provider: string; model: string };

interface ExecutorPorts {
  selectModel: DeskModelSelector;
  remoteUrl?: string;
  revision?: (options: DeskExecutionOptions) => Promise<Revision>;
  spawn?: SpawnChild;
  /** Test seam: the keryx config directory the round registry is written to. Default: the user's. */
  registryDir?: string;
  /** Test seam: the partial-round record. Default: round-registry.ts `recordPartialRound`. */
  recordPartialRound?: typeof recordPartialRound;
}

const exec = promisify(execFile);
const fullSha = /^[0-9a-f]{40}$/;
const EMPTY: DeskExecutionResult = {
  outcome: "incomplete", reason: "", checkedBase: null, checkedHead: null,
  coverage: "unknown", verdict: null, findings: countFindings(null), findingsKnown: false, report: null,
};
async function revision({ repo, number, cwd, viewer }: DeskExecutionOptions, auth: GithubConnection): Promise<Revision> {
  const [owner, name] = repo.split("/");
  const data = await boardGraphql<{ viewer?: { login?: string }; repository?: {
    pullRequest?: PullRevision | null;
    defaultBranchRef?: { name: string; target?: { oid?: string } } | null;
  } | null }>(cwd, `query($owner:String!,$name:String!,$number:Int!) {
    viewer { login }
    repository(owner:$owner,name:$name) {
      pullRequest(number:$number) { baseRefName baseRefOid headRefOid state body }
      defaultBranchRef { name target { oid } }
    }
  }`, { owner: owner!, name: name!, number }, auth);
  if (viewer && data.viewer?.login?.toLowerCase() !== viewer.toLowerCase())
    throw new Error("access: The project's GitHub account changed. Refresh Review.");
  const pull = data.repository?.pullRequest;
  if (!pull) throw new Error("access: The selected pull request is no longer available.");
  const branch = data.repository?.defaultBranchRef;
  const oid = recordedSha(branch?.target?.oid);
  return { ...pull, ...(branch && oid ? { defaultBranch: { name: branch.name, oid } } : {}) };
}

async function git(cwd: string, args: string[], signal: AbortSignal, githubToken?: string): Promise<string> {
  let env = privateGitEnv();
  if (githubToken) env = { ...withoutGithubCredentials(env), GH_TOKEN: githubToken, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  try {
    const { stdout } = await exec(reviewTool("git"), ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd, signal, timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GIT_NO_REPLACE_OBJECTS: "1" },
    });
    return stdout.trimEnd();
  } catch {
    signal.throwIfAborted();
    throw new Error(`Private review checkout: git ${args.find(arg => !arg.startsWith("-") && !arg.includes("=")) ?? "operation"} failed. Verify the GitHub account and retry.`);
  }
}

/** Import workspace-installed review documents, without promoting any file tracked by the reviewed PR. */
async function installWorkspaceReviewControls(cwd: string, checkout: string, signal: AbortSignal) {
  const skills = ".metaproject/project-skills";
  const rules = ".metaproject/rules/project";
  const roots = [`${skills}/review`, `${skills}/orchestration`, rules];
  const entrypoints = [".metaproject/index.md", ".metaproject/routing.md", "AGENTS.md", "CLAUDE.md"];
  const paths = [...roots, ...entrypoints];
  const trackedFiles = (root: string) => git(root, ["ls-files", "-z", "--", ...paths], signal);
  const [pinned, main] = await Promise.all([trackedFiles(checkout), mainReviewRoot(cwd)]);
  for (const workspace of main ? [cwd, main] : [cwd]) {
    const [staged, committed] = await Promise.all([
      trackedFiles(workspace),
      git(workspace, ["ls-tree", "-r", "--name-only", "-z", ...revisionOperand("HEAD"), "--", ...paths], signal),
    ]);
    const tracked = new Set([pinned, staged, committed].flatMap(files => files.split("\0")));
    const candidates = [...entrypoints];
    for (const root of roots) {
      const files = await readdir(path.join(workspace, root), { recursive: true, withFileTypes: true })
        .catch(error => {
          if (isNotFound(error)) return [];
          throw error;
        });
      for (const file of files) {
        const relative = path.relative(workspace, path.join(file.parentPath, file.name)).split(path.sep).join("/");
        if (file.isFile() && relative.startsWith(root + "/") && /^[\w./-]+$/.test(relative) &&
            /\.(?:md|mdc|json)$/.test(file.name)) candidates.push(relative);
      }
    }
    for (const relative of candidates) {
      const target = path.join(checkout, relative);
      if (tracked.has(relative) || existsSync(target)) continue;
      const source = await scopedFile(workspace, relative, 128 * 1024);
      const placed = placePathWithinSync(checkout, relative, checkout);
      if (source === undefined || !placed.ok || placed.path !== path.join(realOrResolved(checkout), relative)) continue;
      await mkdir(path.dirname(target), { recursive: true });
      writeFileSync(target, source, { flag: "wx", mode: 0o600 });
    }
  }
}

async function prepareCheckout(options: DeskExecutionOptions, checkout: string, ports: ExecutorPorts,
  readRevision: () => Promise<Revision>, githubToken?: string) {
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
  const fetch = (...refs: string[]) => git(checkout, ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential",
    "fetch", "--no-tags", "origin", ...refs], signal, githubToken);
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
  await installWorkspaceReviewControls(cwd, checkout, signal);
  return pull;
}

async function prepareRelatedPulls(options: DeskExecutionOptions, checkout: string, body: string, auth: GithubConnection): Promise<RelatedReviewPull[]> {
  const links = linkedReviewPulls(body, options);
  if (links.length === 0) return [];
  options.onProgress({ phase: "Collecting linked pull request sources", rounds: 0, tokens: 0 });
  return Promise.all(links.map(async link => {
    const { signal } = options;
    const dir = relatedPullGitDir(checkout, link);
    const unavailable = (reason: "access" | "lookup" | "identity" | "fetch") => ({ ...link, unavailable: true as const, reason });
    signal.throwIfAborted();
    const response = await boardGh(options.cwd, ["api", "--hostname", "github.com", "--method", "GET",
      `repos/${link.repo}/pulls/${link.number}`], auth, 18_000).catch((error: unknown) => error);
    if (typeof response !== "string") {
      signal.throwIfAborted();
      return unavailable(response instanceof Error && response.message.startsWith("access:") ? "access" : "lookup");
    }
    let pull: { number?: number; base?: { repo?: { full_name?: string } }; head?: { sha?: string } };
    try { pull = JSON.parse(response); }
    catch { return unavailable("lookup"); }
    const head = recordedSha(pull?.head?.sha);
    if (pull?.number !== link.number || pull.base?.repo?.full_name?.toLowerCase() !== link.repo || !head)
      return unavailable("identity");
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await git(dir, ["init", "--bare", "--template="], signal);
      const target = `https://github.com/${link.repo}.git`;
      for (const ref of [`refs/pull/${link.number}/head`, head]) {
        try {
          await git(dir, ["-c", "credential.helper=", "-c", "credential.https://github.com.helper=!gh auth git-credential",
            "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--end-of-options", target, ref],
            signal, auth.login ? auth.env.GH_TOKEN : undefined);
          if (await git(dir, ["rev-parse", "FETCH_HEAD"], signal) === head) return { ...link, head };
        } catch { signal.throwIfAborted(); }
      }
    } catch { signal.throwIfAborted(); }
    return unavailable("fetch");
  }));
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

async function requestPlanApproval(
  dir: string, checkout: string, subject: string, options: DeskExecutionOptions, summary: AutonomousSummary,
): Promise<{ approved: boolean; reason: string } | undefined> {
  if (!isReviewPackageDir(dir, checkout) || !(await regularPackage(dir))) return undefined;
  const saved = await readJson<{ overThreshold?: boolean; next?: string; planKey?: string }>(path.join(dir, "plan.json"));
  if (saved?.overThreshold !== true || typeof saved.next !== "string" || !saved.next.startsWith("confirm plan")) return undefined;
  const manifest = await readJson<ManagedReviewManifest>(path.join(dir, "manifest.json"));
  if (manifest?.status !== "draft" || manifest.reviewId !== path.basename(dir) ||
      manifest.target?.ref !== subject || manifest.target.base !== options.baseSha || manifest.target.head !== options.headSha) return undefined;
  const estimate = await estimatePlan(dir);
  if (!estimate.overThreshold || estimate.planKey !== saved.planKey) {
    return { approved: false, reason: "The saved review plan changed. Prepare a new plan before confirming it." };
  }
  if (await planConfirmed(dir, estimate)) return { approved: true, reason: "" };
  const size = `${estimate.dispatches.toLocaleString("en-US")} reviewer assignments, estimated ${estimate.minutes.min}–${estimate.minutes.max} minutes`;
  const ceiling = DEFAULT_MAX_PASSES * REVIEW_WAVE_MAX_CHILDREN;
  if (estimate.dispatches > ceiling) {
    return { approved: false, reason: `Review plan exceeds Desktop capacity (${size}; maximum ${ceiling} assignments). Split the review before continuing.` };
  }
  if (!options.operatorRunId) {
    return { approved: false, reason: `The review plan requires operator approval (${size}). Continue from a review session to decide.` };
  }
  options.onProgress({ phase: "Awaiting your answer", rounds: summary.rounds, tokens: summary.tokens,
    ...(summary.usage ? { usage: summary.usage } : {}), packageId: manifest.reviewId });
  const question = `Run the expanded review plan? It calls for ${size}. ${estimate.overReasons.join(". ")}`;
  const approve = "Approve expanded plan";
  const answer = await askDesktopOperator(options.operatorRunId, { question, options: [
    { id: "keep", label: "Keep review paused", description: "Keep the prepared review for later.", recommended: true },
    { id: "approve", label: approve, description: "Allow the assignments in this exact plan within the review’s existing run limits." },
  ] }, undefined, options.signal);
  if (answer !== "approve") return { approved: false, reason: `The expanded review plan was left paused (${size}).` };
  await options.verifyBeforeExecution?.();
  options.signal.throwIfAborted();
  const at = new Date().toISOString();
  await recordPlanConfirmation(dir, estimate, {
    confirmedVia: "host-question", quote: `${question} — ${approve}`, at,
    hostQuestion: { source: "keryx-shell", ref: options.operatorRunId, questionText: question, answerText: approve, time: at },
  });
  return { approved: true, reason: "" };
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
  let formatted: string | undefined;
  if (ownsPackage && manifest) {
    const entries = Array.isArray(manifest.coverage) ? manifest.coverage : [];
    const evaluated = await computeVerdict(dir);
    const ingested = knownFindingList(await readJson<unknown>(path.join(dir, "findings.json")));
    const known = evaluated.source === "raw reviewer results" || (evaluated.source === "ingested round" && ingested);
    if (entries.length && known) {
      coverage = matching && manifest.status === "closed" && outcome === "complete" && ingested &&
        completeDeskCoverage(dir, entries, summary.usage, evaluated, true) ? "complete" : "partial";
    }
    if (options.options?.orchestrator === false && matching && manifest.mode === "ingest" && ingested && evaluated.source === "ingested round" &&
        summary.status === "incomplete" && summary.floorRefusals === 0 && !options.signal.aborted) {
      coverage = "partial";
      result.reason = "The single reviewer finished. This review has single-reviewer coverage.";
    }
    const report = await scopedFile(dir, "report.md", 2 * 1024 * 1024);
    if (known) {
      result.findingsKnown = true;
      result.findings = evaluated.counts;
      // The intermediate headline "no findings" alone is not an approval.
      if (matching) {
        const complete = coverage === "complete";
        const solo = options.options?.orchestrator === false;
        verdict = deskVerdictHeadline(evaluated, complete);
        const [{ records }, { overlay, overlayWarning }] = await Promise.all([premiseRecords(dir), projectReviewOverlay(options.cwd)]);
        const metadata = reportFindingMetadata(report);
        const findings = [...evaluated.open, ...evaluated.minors, ...(evaluated.info ?? []), ...evaluated.held].map(entry => {
          const row = records.find(record => record.id === entry.id && (!record.reviewer || record.reviewer === entry.reviewer));
          const finding = deskReportFinding(entry, row, metadata.get(entry.id));
          if (!evaluated.held.includes(entry)) return finding;
          const premise = row?.premise as { question?: unknown } | undefined;
          return { ...finding, severity: "info" as const, question: true,
            problem: typeof premise?.question === "string" && premise.question.trim() ? premise.question : finding.problem };
        });
        const reported = evaluated.reportedReviewers.length ? ` Reviewers: ${evaluated.reportedReviewers.join(", ")}.` : "";
        const round = readRoundNumber(dir) ?? 1;
        const recommendation = deskReportRecommendation(complete, findings);
        formatted = applyReviewOverlay(renderDeskReviewReport({
          repo: options.repo, base: options.baseSha, head: options.headSha, round,
          verdict: recommendation, findings, evidenceLevel: deskReportEvidence(report),
          slots: projectReportSlots(overlay, report, round, recommendation, !solo),
          coverageNote: complete ? "" : solo ? "**Single-reviewer coverage.**" : "**Partial review.**",
          howRun: `${solo ? "Single reviewer" : "Review orchestrator"} · ${options.options?.mode === "auto" ? "Auto" : "Manual"}.${reported}`,
        }), overlay);
        if (overlayWarning) formatted += `\n\n${overlayWarning}`;
      }
      result.report += "\n" + renderVerdict(evaluated, manifest.reviewId);
    }
    if (!formatted && report) result.report += "\n" + report;
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
  const diagnostics = renderReport(saved) + result.report;
  result.report = formatted ? formatted + "\n\n" + reviewReportDisclosure("Run diagnostics", diagnostics.trim()) : diagnostics;
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
    // Capture the credential once so revision reads and private fetch cannot use different accounts.
    const auth = await projectGithubConnection(options.cwd, process.env, options.viewer);
    const readRevision = async () => {
      try {
        return await (ports.revision ? ports.revision(options) : revision(options, auth));
      } catch (error) {
        beforeSpawnFailure = retryablePreflight(error);
        throw error;
      }
    };
    const prepared = await prepareCheckout(options, checkout, ports, readRevision, auth.login ? auth.env.GH_TOKEN : undefined).catch(error => {
      beforeSpawnFailure = retryablePreflight(error);
      throw error;
    });
    if (!prepared) {
      result = { ...EMPTY, outcome: "blocked", reason: "The PR closed or its base/head changed. Refresh the card before starting another review." };
    } else {
      if (options.context) {
        const context = { ...options.context, ...(options.guidance && { operatorGuidance: options.guidance }) };
        writeFileSync(path.join(checkout, PR_CONTEXT_FILE), JSON.stringify(context), { flag: "wx", mode: 0o600 });
      }
      const { overlay, overlayWarning } = await projectReviewOverlay(checkout);
      if (options.options?.autoPublish && !overlayWarning) {
        const local = overlay ? {} : await projectReviewOverlay(options.cwd);
        const selected = overlay ?? (local.overlay?.kind === "wrapper" ? local.overlay : undefined);
        await writeFileAtomic(path.join(runDir, DESK_TEMPLATE_SELECTION), JSON.stringify(reportTemplateFingerprint(selected)), { mode: 0o600 });
      }
      if (overlay?.kind === "slots") {
        writeFileSync(path.join(checkout, DESK_REPORT_OVERLAY_FILE), overlay.source, { flag: "wx", mode: 0o600 });
      }
      const relatedText = [options.guidance, prepared.body].filter(Boolean).join("\n");
      const related = options.options?.mode === "auto" && relatedText
        ? await prepareRelatedPulls(options, checkout, relatedText, auth) : [];
      if (related.length) {
        await mkdir(runnerDir, { recursive: true, mode: 0o700 });
        await writeFileAtomic(path.join(runnerDir, "related-pulls.json"), JSON.stringify(related), { mode: 0o600 });
      }
      let resumePackage: string | undefined;
      if (options.resumeRunDir) {
        const dir = path.join(options.resumeRunDir, "package");
        const manifest = await readJson<ManagedReviewManifest>(path.join(dir, "manifest.json"));
        if (manifest?.status === "draft" && manifest.target?.ref === subject &&
            manifest.target.base === options.baseSha && manifest.target.head === options.headSha &&
            /^[\w.-]+$/.test(manifest.reviewId) && ![".", ".."].includes(manifest.reviewId) && await regularPackage(dir)) {
          await cp(dir, path.join(checkout, ".metaproject", "reviews", manifest.reviewId), { recursive: true });
          resumePackage = manifest.reviewId;
        }
      }
      const recordPartial = ports.recordPartialRound ?? recordPartialRound;
      let registryFailed = false;
      for (const prior of resumePackage ? [] : options.previousRuns ?? []) {
        const previous = path.join(prior.runDir, "package");
        const manifest = await readJson<ManagedReviewManifest>(path.join(previous, "manifest.json"));
        // The package must be the one its attempt reviewed: the run store's range, not only the pull request (T16 B3).
        const usable = manifest?.target?.ref === subject && manifest.target.base === prior.baseSha && manifest.target.head === prior.headSha &&
          /^[\w.-]+$/.test(manifest.reviewId) && ![".", ".."].includes(manifest.reviewId) && await regularPackage(previous);
        // A closed package is a finished round. A partial attempt's package never got past its draft: only Desktop's own
        // record, written here from the user's run store, lets the next round cut from it (prior-round.ts, TM-04 §4d).
        // One that cannot be handed on falls back to the next candidate, never to a first review (T14 B1). A registry that
        // failed once (a lock timeout costs its whole wait) is not asked again for later partial candidates (T16 B5).
        let handOn = usable && manifest.status === "closed";
        if (usable && !handOn && prior.partial && !registryFailed) {
          const recorded = recordPartial(previous, { cwd: checkout, dir: ports.registryDir });
          if (recorded.error !== undefined) registryFailed = true;
          handOn = recorded.file !== undefined;
        }
        if (!handOn || !manifest) continue;
        await cp(previous, path.join(checkout, ".metaproject", "reviews", manifest.reviewId), { recursive: true });
        break;
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
      const maxMinutes = options.budgetMinutes ?? 30;
      const maxTokens = options.options?.maxTokens ?? options.budgetTokens ?? undefined;
      const execute = (preservedPackage: string | undefined, budgetMinutes = maxMinutes, budgetTokens = maxTokens) => runAutonomousReview({
        ...selection,
        ...(options.options ? { deskOptions: options.options } : {}),
        ...(options.operatorRunId ? { operatorRunId: options.operatorRunId } : {}),
        ...(preservedPackage && { resumePackage: preservedPackage }),
        ...(options.guidance && { guidance: options.guidance }),
        ...(options.isWaitingForOperator ? { isWaitingForOperator: options.isWaitingForOperator } : {}),
        cwd: checkout, ref: subject, fixedBase: options.baseSha, out: runnerDir, signal,
        resolveHead: async () => options.headSha, budgetMinutes, budgetTokens,
        onProgress: options.onProgress,
        spawn(spec) {
          let attempted = false;
          const start = () => {
            // Commit the PID guard inside the policy fence: this is when the reviewer
            // shell is released to spend budget, even if its parent crashes next.
            attempted = true;
            const child = launch.child = spawn({ ...spec, env: { ...spec.env, PATH: searchPath, KERYX_UNATTENDED: "1", [DESK_REVIEW_SHELL]: "1", [DESK_REVIEW_RESUME_PACKAGE]: preservedPackage ?? "", [DESK_REVIEW_HEAD]: options.headSha, [DESK_RELATED_PRS]: JSON.stringify(related), [DESK_OPTIONS_ENV]: deskOptionsKey(options.options), [DESK_REVIEW_PROJECT_ROOT]: path.resolve(options.cwd) } });
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
            if (options.authorizeSpawn) return options.authorizeSpawn(start);
            verifyGithubBindingUnchanged(auth);
            return start();
          } catch (error) {
            beforeSpawnFailure = !attempted && retryablePreflight(error);
            throw error;
          }
        },
      });
      let { summary } = await execute(resumePackage);
      const packageDir = summary.package && path.resolve(checkout, summary.package.path);
      const pending = !ports.spawn && !signal.aborted && summary.status === "incomplete" && summary.floorRefusals === 0 &&
        summary.package?.status === "draft" && packageDir && path.dirname(packageDir) === path.join(checkout, ".metaproject", "reviews")
        ? await requestPlanApproval(packageDir, checkout, subject, options, summary)
        : undefined;
      if (pending?.approved) {
        const minutesLeft = maxMinutes - summary.durationSeconds / 60;
        const tokensLeft = maxTokens === undefined ? undefined : maxTokens - summary.tokens;
        if (minutesLeft <= 0 || (tokensLeft !== undefined && tokensLeft <= 0)) {
          summary = { ...summary, status: "budget", exitCode: exitCodeFor("budget"),
            reason: "The review budget was used while preparing the expanded plan." };
        } else {
          ({ summary } = await execute(summary.package!.id, minutesLeft, tokensLeft));
        }
      } else if (pending) {
        summary = { ...summary, phase: "Review plan paused", reason: pending.reason };
      }
      if ((!pending || pending.approved) && !ports.spawn && options.options?.mode === "auto" && options.options.orchestrator !== false && !signal.aborted && summary.status === "incomplete" &&
          summary.floorRefusals === 0 && packageDir && path.dirname(packageDir) === path.join(checkout, ".metaproject", "reviews") &&
          isReviewPackageDir(packageDir, checkout) && await regularPackage(packageDir)) {
        const [bin, ...argv] = invocationArgv(resolveKeryxInvocation());
        const finalizationLog: string[] = [];
        const finished = await finishAutoDesktopReview({
          checkout, dir: packageDir, runnerDir, base: options.baseSha, head: options.headSha, ref: subject, summary, signal,
          async run(args) {
            options.onProgress({ phase: args[0] === "ingest" ? "Recording reviewer findings" : "Reconciling reviewer observations",
              rounds: summary.rounds, tokens: summary.tokens, ...(summary.usage ? { usage: summary.usage } : {}) });
            try {
              await exec(bin!, [...argv, "review", ...args], {
                cwd: checkout, timeout: 45_000, maxBuffer: 2 * 1024 * 1024, signal,
                env: { ...privateGitEnv(), PATH: searchPath, KERYX_UNATTENDED: "1", KERYX_TOOL_CALL: "1",
                  ...(auth.login ? { GH_TOKEN: auth.env.GH_TOKEN } : {}) },
              });
              return true;
            } catch (failure) {
              finalizationLog.push(`${args[0]} exited with ${(failure as { code?: unknown }).code ?? "an error"}`);
              signal.throwIfAborted();
              return false;
            }
          },
          prLookup: async () => {
            const latest = await readRevision();
            return { exists: true, state: latest.state, headSha: latest.headRefOid };
          },
          prFiles: async () => {
            const latest = await readRevision();
            if (latest.state !== "OPEN" || latest.headRefOid !== options.headSha || latest.baseRefOid !== options.baseSha)
              throw new Error("The pull request revision changed before automatic completion.");
            const raw = await boardGh(options.cwd, ["pr", "view", subject, "--json", "files"], auth);
            const data = JSON.parse(raw) as { files?: { path: string }[] };
            return Array.isArray(data.files) ? data.files.map(file => file.path) : null;
          },
        }).catch(failure => {
          finalizationLog.push(failure instanceof Error ? failure.message : "Automatic reconciliation failed.");
          return false;
        });
        if (finalizationLog.length) await writeFileAtomic(path.join(runnerDir, "auto-finalize.log"), finalizationLog.join("\n") + "\n", { mode: 0o600 });
        if (finished && summary.package) summary = { ...summary, status: "complete", exitCode: exitCodeFor("complete"),
          phase: "Completed automatically", reason: "The Desktop worker reconciled the review and passed the completion checks.",
          rounds: Math.max(1, summary.rounds), package: { ...summary.package, status: "closed" } };
      }
      result = await collectResult(options, checkout, summary);
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
