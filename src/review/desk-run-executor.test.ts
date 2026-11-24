import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import { hasDesktopReviewerEvidence } from "./desk-run-executor-recovery";
import { DESK_RUN_SCOPE, LEGACY_DESK_RUN_SCOPE } from "./desk-run-types";
import { finishExecution } from "./desk-run-service";
import { executeDeskReview, recoverDeskExecution } from "./desk-run-executor";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import { privateGitEnv, type ChildSpec } from "./autonomous-run";
import { reviewGitCommonDir } from "./board-github";
import { beginWatcherOperation, changeProjectGithubBinding } from "./watcher";
import { claimProjectGithubAccountIntent } from "./github-account-store";

const fixtureGitEnv = () => ({ ...privateGitEnv(), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args],
  { cwd, env: fixtureGitEnv(), encoding: "utf8" }).trim();
let root: string, cwd: string, runDir: string, baseSha: string, headSha: string;
const skill = ".metaproject/skills/gdskills/review/review-orchestrator/SKILL.md";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "desk-review-"));
  cwd = path.join(root, "repo");
  runDir = path.join(root, "runs", "attempt-1");
  mkdirSync(path.dirname(path.join(cwd, skill)), { recursive: true });
  git(cwd, "init", "--quiet", "-b", "base");
  git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(cwd, skill), "trusted skill");
  writeFileSync(path.join(cwd, "routing.config.json"), '{"policyMarker":"local"}');
  writeFileSync(path.join(cwd, "src.ts"), "before"); git(cwd, "add", "."); git(cwd, "commit", "-qm", "base");
  baseSha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "switch", "--quiet", "-c", "pr");
  writeFileSync(path.join(cwd, skill), "PR instruction");
  writeFileSync(path.join(cwd, "src.ts"), "review me"); writeFileSync(path.join(cwd, "bunfig.toml"), "untrusted config");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "PR"); headSha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/pull/12/head", headSha);
  git(cwd, "switch", "--quiet", "base");
  writeFileSync(path.join(cwd, "src.ts"), "uncommitted local edit");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function options(controller = new AbortController()) {
  return { cwd, runDir, scope: DESK_RUN_SCOPE, repo: "example/project", number: 12, headSha, baseSha, signal: controller.signal, onProgress: () => {} };
}

const selectModel = () => ({ provider: "test-provider", model: "test-model" });
const defaultBranch = () => ({ name: "base", oid: git(cwd, "rev-parse", "refs/heads/base") });
const revision = async () => ({ baseRefName: "base", baseRefOid: baseSha, headRefOid: headSha, state: "OPEN", defaultBranch: defaultBranch() });

function packageAt(spec: ChildSpec, target: Record<string, unknown>, coverage: unknown) {
  const dir = path.join(spec.cwd, ".metaproject/reviews/pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: "pkg", status: "closed", coverage, target: { kind: "pr", ref: "https://github.com/example/project/pull/12", ...target } }));
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify([{ id: "test-1", reviewer: "review-logic", severity: "major", problem: "Handle missing repository" }]));
  writeFileSync(path.join(dir, "report.md"), "## Findings\nHandle missing repository");
}

test("fixture commands read the selected temporary repository when the caller points Git at a different one", () => {
  const other = path.join(root, "other-repo");
  mkdirSync(other);
  git(other, "init", "--quiet", "-b", "other");
  const savedDir = process.env.GIT_DIR, savedTree = process.env.GIT_WORK_TREE;
  try {
    process.env.GIT_DIR = path.join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    expect(git(cwd, "branch", "--show-current")).toBe("base");
    expect(git(cwd, "rev-parse", "HEAD")).toBe(baseSha);
    expect(git(other, "branch", "--show-current")).toBe("other");
  } finally {
    if (savedDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = savedDir;
    if (savedTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = savedTree;
  }
});

const coveredFile = { schemaVersion: 1, tracked: true, waived: false, counts: { inScope: 1, covered: 1, omitted: 0, uncovered: 0 },
  files: [{ file: "src.ts", status: "covered", scope: "A", by: "slice-01" }], omissions: [], omissionReasons: {} };

function preparedPackageAt(spec: ChildSpec, base = baseSha) {
  const role = "review-logic", pkg = ".metaproject/reviews/pkg", dir = path.join(spec.cwd, pkg);
  packageAt(spec, { base, head: headSha }, [{ reviewer: role, status: "run" }]);
  mkdirSync(path.join(dir, "slices"));
  mkdirSync(path.join(dir, "raw"));
  const file = `raw/${role}-w1.txt`;
  writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ desktopDispatch: `${pkg}/desktop-dispatch.json`, roster: [role], dispatches: 1 }));
  writeFileSync(path.join(dir, "desktop-dispatch.json"), JSON.stringify({ calls: [{ label: role, save_result_to: `${pkg}/${file}` }], routedOut: [] }));
  writeFileSync(path.join(dir, "slices/manifest.json"), JSON.stringify({ schemaVersion: 1, maxBytes: 100, waveBytes: 100,
    slices: [{ id: "slice-01", bytes: 10, files: ["src.ts"], roles: [role], depth: "light" }] }));
  writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(coveredFile));
  const findings = JSON.parse(readFileSync(path.join(dir, "findings.json"), "utf8"));
  writeFileSync(path.join(dir, file), "STATUS: DONE\nREVIEW_RESULT:\n" + JSON.stringify({ reviewer: role, status: "DONE", slices: ["slice-01"], findings }));
}

function observedPreparedPackage(spec: ChildSpec, base = baseSha) {
  preparedPackageAt(spec, base);
  writeFileSync(spec.eventsFile, JSON.stringify({ type: "request_usage", requestId: "review", participant: "reviewer",
    reviewer: "review-logic", usage: { inputTokens: 1, outputTokens: 1 } }) + "\n", { flag: "a" });
}

test("runs a linked worktree's review with the main checkout's installed controls and pinned PR objects", async () => {
  const installed = ".metaproject/project-skills/review/review-local/SKILL.md";
  const fromPr = ".metaproject/project-skills/review/review-pr-injection/SKILL.md";
  writeFileSync(path.join(cwd, "src.ts"), "before");
  git(cwd, "switch", "pr");
  mkdirSync(path.dirname(path.join(cwd, fromPr)), { recursive: true });
  writeFileSync(path.join(cwd, fromPr), "PR instructions");
  git(cwd, "add", "--", fromPr);
  git(cwd, "commit", "-qm", "Add an untrusted reviewer on the PR head");
  headSha = git(cwd, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/pull/12/head", headSha);
  git(cwd, "switch", "base");
  writeFileSync(path.join(cwd, "src.ts"), "uncommitted local edit");
  const linked = path.join(root, "linked");
  git(cwd, "worktree", "add", "--detach", "--", linked, baseSha);
  const index = ".metaproject/index.md";
  for (const [file, body] of [[index, "Local review index"], [installed, "Workspace reviewer"], [fromPr, "PR instructions"]] as const) {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), body);
  }
  const phases: string[] = [];
  const context = { version: 1 as const, pr: { url: "https://github.com/example/project/pull/12", title: "linked PR", state: "OPEN", baseSha, headSha }, flows: [], totalFlows: 0, history: [], totalRuns: 0 };
  let inspected = false;
  const launch = { mode: "auto" as const, adaptive: false, maxWaves: 3, maxParallel: 2, maxTokens: 100000, modelPools: { strong: [], middle: [], light: [] } };
  const result = await executeDeskReview({ ...options(), cwd: linked, options: launch, context, onProgress: p => { phases.push(p.phase); } }, {
    selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      expect(JSON.parse(spec.env.KERYX_DESK_REVIEW_OPTIONS!)).toEqual(launch);
      expect(spec.argv.at(-1)).toContain("waves of at most 2");
      expect(spec.argv.at(-1)).toContain("Tiers are fixed for this run");
      expect(spec.argv).toContain("--agent");
      expect(spec.argv).toContain("--print");
      expect(spec.argv[spec.argv.indexOf("--provider") + 1]).toBe("test-provider");
      expect(spec.argv[spec.argv.indexOf("--model") + 1]).toBe("test-model");
      expect(JSON.parse(readFileSync(path.join(spec.cwd, ".keryx-review-context.json"), "utf8"))).toEqual(context);
      expect(spec.argv.join(" ")).toContain("read_file tool in a separate tool call for .keryx-review-context.json");
      expect(git(spec.cwd, "rev-parse", "HEAD")).toBe(headSha);
      expect(git(spec.cwd, "show", headSha + ":src.ts")).toBe("review me");
      const scope = execFileSync(process.execPath, [...SAFE_BUN_SPAWN_ARGS, path.resolve(import.meta.dir, "../cli.ts"), "review", "scope", "--ref", baseSha, "--json"],
        { cwd: spec.cwd, env: fixtureGitEnv(), encoding: "utf8", timeout: 30_000 });
      expect(JSON.stringify(JSON.parse(scope))).toContain("src.ts");
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toBe("trusted skill");
      expect(readFileSync(path.join(spec.cwd, index), "utf8")).toBe("Local review index");
      expect(readFileSync(path.join(spec.cwd, installed), "utf8")).toBe("Workspace reviewer");
      expect(existsSync(path.join(spec.cwd, fromPr))).toBe(false);
      expect(readFileSync(path.join(spec.cwd, "routing.config.json"), "utf8")).toBe('{"policyMarker":"local"}');
      expect(existsSync(path.join(spec.cwd, "bunfig.toml"))).toBe(false);
      expect(spec.argv.join(" ")).toContain(`keryx review plan --target https://github.com/example/project/pull/12 --ref ${baseSha} --head ${headSha} --host keryx-shell`);
      expect(spec.argv.join(" ")).not.toContain(" --unattended");
      expect(spec.argv.join(" ")).not.toContain("Open one more round");
      preparedPackageAt(spec);
      writeFileSync(spec.eventsFile, [
        { type: "tool_call", name: "bash", input: JSON.stringify({ command: "keryx review ingest" }) },
        { type: "request_usage", requestId: "co", participant: "coordinator", usage: { inputTokens: 70, outputTokens: 10 } },
        { type: "request_usage", requestId: "review", participant: "reviewer", reviewer: "review-logic", usage: { inputTokens: 28, outputTokens: 7 } },
        { type: "turn_end", usage: { inputTokens: 70, outputTokens: 10, totalTokens: 80 } },
      ].map(event => JSON.stringify(event)).join("\n") + "\n");
      inspected = true;
      return { exited: Promise.resolve(0), kill() {} };
    },
  });
  expect(result.usage?.total).toEqual({ inputTokens: 98, outputTokens: 17, totalTokens: 115 });
  expect(finishExecution(result).usage).toEqual(result.usage);
  expect(result.report).toContain("review-logic: input 28, output 7");
  expect(JSON.parse(readFileSync(path.join(runDir, "run/summary.json"), "utf8")).usage).toEqual(result.usage);
  expect(inspected).toBe(true);
  expect(result).toMatchObject({ outcome: "complete", checkedBase: baseSha, checkedHead: headSha, coverage: "complete", findings: { major: 1 } });
  expect(finishExecution(result).result?.findingsKnown).toBe(true);
  expect(result.report).toContain("Handle missing repository");
  expect(phases).toContain("review ingest");
  expect(git(cwd, "branch", "--show-current")).toBe("base");
  expect(readFileSync(path.join(cwd, "src.ts"), "utf8")).toBe("uncommitted local edit");
  expect(existsSync(path.join(linked, installed))).toBe(false);
  expect(existsSync(path.join(runDir, "checkout"))).toBe(false);
  expect(existsSync(path.join(runDir, "package", "report.md"))).toBe(true);
  expect(JSON.parse(readFileSync(path.join(runDir, "execution-result.json"), "utf8"))).toEqual(result);
});

test("an explicit single reviewer records findings for the pinned range without claiming full coverage", async () => {
  const result = await executeDeskReview({
    ...options(), options: { mode: "auto", orchestrator: false, adaptive: false, modelPools: { strong: [], middle: [], light: [] } },
  }, {
    selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      const prompt = spec.argv.at(-1)!;
      expect(prompt).toContain("as the only reviewer");
      expect(prompt).toContain(`--base ${baseSha} --head ${headSha}`);
      expect(prompt).not.toContain("spawn_subagent");
      packageAt(spec, { base: baseSha, head: headSha }, []);
      const file = path.join(spec.cwd, ".metaproject/reviews/pkg/manifest.json");
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), status: "draft", mode: "ingest" }));
      return { exited: Promise.resolve(0), kill() {} };
    },
  });
  expect(result).toMatchObject({ coverage: "partial", checkedBase: baseSha, checkedHead: headSha, findings: { major: 1 } });
  expect(result.reason).toContain("The single reviewer finished");
  expect(result.report).toContain("Handle missing repository");
});

test("a named credential is injected only into the private fetch and a concurrent disconnect prevents launch", async () => {
  const pathBefore = process.env.PATH, dataBefore = process.env.KERYX_DATA_DIR;
  try {
    process.env.PATH = root + path.delimiter + pathBefore;
    process.env.KERYX_DATA_DIR = path.join(root, "data");
    writeFileSync(path.join(root, "gh"), '#!/bin/sh\nset -eu\ntest "$*" = "auth token --hostname github.com --user fixture"\nprintf "%s\\n" fixture-selected-credential\n', { mode: 0o700 });
    const probe = path.join(root, "fetch-observed");
    writeFileSync(path.join(root, "git"), `#!/bin/sh
set -eu
case " $* " in
  *" fetch "*) test "${'$'}{GH_TOKEN:-}" = fixture-selected-credential; touch "${probe}" ;;
  *) test "${'$'}{GH_TOKEN:-}" != fixture-selected-credential ;;
esac
exec /usr/bin/git "$@"
`, { mode: 0o700 });
    const project = (await reviewGitCommonDir(cwd))!;
    const bind = (login: string | null) => {
      const order = beginWatcherOperation();
      claimProjectGithubAccountIntent(project, order);
      changeProjectGithubBinding(project, cwd, login, order);
    };
    bind("fixture");
    let launches = 0;
    const result = await executeDeskReview({
      ...options(), viewer: "fixture",
      verifyBeforeExecution: async () => { bind(null); },
    }, {
      selectModel, remoteUrl: cwd, revision,
      spawn() { launches++; return { exited: Promise.resolve(0), kill() {} }; },
    });
    expect(existsSync(probe)).toBe(true);
    expect(launches).toBe(0);
    expect(result).toMatchObject({ outcome: "failed", reason: expect.stringContaining("account changed") });
    expect(JSON.stringify(result)).not.toContain("fixture-selected-credential");
  } finally {
    if (pathBefore === undefined) delete process.env.PATH; else process.env.PATH = pathBefore;
    if (dataBefore === undefined) delete process.env.KERYX_DATA_DIR; else process.env.KERYX_DATA_DIR = dataBefore;
  }
});

test("a closed prepared Desktop package without a reviewer participation receipt retains partial coverage", async () => {
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision, spawn(spec) {
    preparedPackageAt(spec);
    writeFileSync(spec.eventsFile, JSON.stringify({ type: "request_usage", requestId: "co", participant: "coordinator",
      usage: { inputTokens: 70, outputTokens: 10 } }) + "\n");
    return { exited: Promise.resolve(0), kill() {} };
  } });
  expect(result).toMatchObject({ outcome: "incomplete", coverage: "partial", checkedBase: baseSha, checkedHead: headSha });
});

test("an advancing remote base keeps the API-pinned range independent of the local controls", async () => {
  writeFileSync(path.join(cwd, skill), "newer branch instructions");
  git(cwd, "add", skill);
  git(cwd, "commit", "-qm", "advance base branch");
  let reads = 0;
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd,
    revision: async () => { reads++; return revision(); },
    spawn(spec) {
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toBe("newer branch instructions");
      expect(git(spec.cwd, "rev-parse", "HEAD")).toBe(headSha);
      expect(spec.argv.at(-1)).toContain(`--ref ${baseSha} --head ${headSha}`);
      observedPreparedPackage(spec);
      return { exited: Promise.resolve(0), kill() {} };
    },
  });
  expect(reads).toBe(2);
  expect(result).toMatchObject({ outcome: "complete", checkedBase: baseSha, checkedHead: headSha });
});

test("reverifies default branch controls when the advertised commit moves before fetch", async () => {
  const policyCheckout = path.join(root, "policy");
  git(cwd, "worktree", "add", "--quiet", "-b", "policy", policyCheckout, baseSha);
  writeFileSync(path.join(policyCheckout, skill), "new verified controls");
  git(policyCheckout, "add", skill);
  git(policyCheckout, "commit", "-qm", "Advance policy branch");
  const policyHead = git(policyCheckout, "rev-parse", "HEAD");
  let reads = 0;
  const result = await executeDeskReview(options(), {
    selectModel, remoteUrl: cwd,
    revision: async () => ({ ...await revision(), defaultBranch: { name: "policy", oid: ++reads === 1 ? baseSha : policyHead } }),
    spawn(spec) {
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toBe("new verified controls");
      observedPreparedPackage(spec);
      return { exited: Promise.resolve(0), kill() {} };
    },
  });
  expect(reads).toBe(2);
  expect(result).toMatchObject({ outcome: "complete", checkedBase: baseSha, checkedHead: headSha });
});

test("an alternate PR target from a linked checkout cannot select Desktop's review controls", async () => {
  const linked = path.join(root, "linked");
  git(cwd, "worktree", "add", "--quiet", "-b", "alternate", linked, baseSha);
  writeFileSync(path.join(linked, skill), "alternate branch marker");
  writeFileSync(path.join(linked, "routing.config.json"), '{"policyMarker":"alternate"}');
  writeFileSync(path.join(linked, "bunfig.toml"), "alternate config marker");
  git(linked, "add", ".");
  git(linked, "commit", "-qm", "alternate comparison base");
  const targetBase = git(linked, "rev-parse", "HEAD");
  git(linked, "switch", "--quiet", "-c", "alternate-head");
  writeFileSync(path.join(linked, "src.ts"), "alternate comparison head");
  git(linked, "add", "src.ts");
  git(linked, "commit", "-qm", "alternate comparison head");
  const targetHead = git(linked, "rev-parse", "HEAD");
  git(cwd, "update-ref", "refs/pull/12/head", targetHead);
  git(cwd, "restore", "src.ts");
  git(cwd, "switch", "--quiet", "pr");

  let inspected = false;
  const result = await executeDeskReview({ ...options(), cwd: linked, baseSha: targetBase, headSha: targetHead }, {
    selectModel, remoteUrl: cwd,
    revision: async () => ({ baseRefName: "alternate", baseRefOid: targetBase, headRefOid: targetHead, state: "OPEN", defaultBranch: defaultBranch() }),
    spawn(spec) {
      expect(git(spec.cwd, "rev-parse", "HEAD")).toBe(targetHead);
      expect(git(spec.cwd, "show", targetBase + ":" + skill)).toBe("alternate branch marker");
      expect(git(spec.cwd, "show", targetHead + ":src.ts")).toBe("alternate comparison head");
      expect(spec.argv.at(-1)).toContain(`--ref ${targetBase} --head ${targetHead}`);
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toBe("trusted skill");
      expect(readFileSync(path.join(spec.cwd, "routing.config.json"), "utf8")).toBe('{"policyMarker":"local"}');
      expect(existsSync(path.join(spec.cwd, "bunfig.toml"))).toBe(false);
      inspected = true;
      return { exited: Promise.resolve(2), kill() {} };
    },
  });
  expect(inspected).toBe(true);
  expect(result.outcome).toBe("incomplete");
});

test("installed review skills supply the coordinator when the default branch has none", async () => {
  git(cwd, "rm", skill);
  git(cwd, "commit", "-qm", "use installed review skills");
  let inspected = false;
  await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toContain("name: review-orchestrator");
      expect(readFileSync(path.join(spec.cwd, "routing.config.json"), "utf8")).toBe('{"policyMarker":"local"}');
      expect(spec.argv.at(-1)).toContain(`--ref ${baseSha} --head ${headSha}`);
      inspected = true;
      return { exited: Promise.resolve(2), kill() {} };
    },
  });
  expect(inspected).toBe(true);
});

test("an unrelated replacement of the base branch blocks a pinned base still present in the clone", async () => {
  const replacement = git(cwd, "commit-tree", `${baseSha}^{tree}`, "-m", "replacement root");
  git(cwd, "update-ref", "refs/heads/base", replacement);
  let started = false;
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision,
    spawn() { started = true; throw new Error("unexpected reviewer"); },
  });
  expect(started).toBe(false);
  expect(result.outcome).toBe("blocked");
});

test("a changed GitHub base after fetch blocks the old card and accepts the refreshed revision", async () => {
  git(cwd, "commit", "--allow-empty", "-qm", "new base");
  const updated = git(cwd, "rev-parse", "HEAD");
  let reads = 0;
  const readUpdated = async () => ({ ...await revision(), baseRefOid: updated });
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd,
    revision: () => ++reads === 1 ? revision() : readUpdated(),
    spawn() { throw new Error("unexpected reviewer"); },
  });
  expect(result.outcome).toBe("blocked");
  const fresh = await executeDeskReview({ ...options(), baseSha: updated, runDir: path.join(root, "next") }, {
    selectModel, remoteUrl: cwd, revision: readUpdated, spawn(spec) {
      observedPreparedPackage(spec, updated);
      return { exited: Promise.resolve(0), kill() {} };
    },
  });
  expect(fresh).toMatchObject({ outcome: "complete", checkedBase: updated });
});

test("a moved review ref after metadata read blocks the stale launch before a model starts", async () => {
  git(cwd, "update-ref", "refs/pull/12/head", baseSha);
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision, spawn() { throw new Error("must not start"); } });
  expect(result.outcome).toBe("blocked");
  expect(result.checkedHead).toBeNull();
  expect(finishExecution(result).result?.findingsKnown).toBe(false);
});

test("a legacy closed package missing the reviewed base remains incomplete with its report", async () => {
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision, spawn(spec) {
    packageAt(spec, { head: headSha }, undefined);
    return { exited: Promise.resolve(0), kill() {} };
  } });
  expect(result).toMatchObject({ outcome: "incomplete", coverage: "unknown", checkedBase: null });
  expect(result.reason).toContain("did not confirm");
  expect(result.report).toContain("Handle missing repository");
});

test("cancellation stops the active orchestrator and records an explicit outcome", async () => {
  const ctrl = new AbortController();
  let killed = false;
  const result = await executeDeskReview(options(ctrl), { selectModel, remoteUrl: cwd, revision, spawn() {
    let exit!: (value: number) => void;
    const exited = new Promise<number>(resolve => { exit = resolve; });
    ctrl.abort();
    return { exited, kill() { killed = true; exit(128); } };
  } });
  expect(killed).toBe(true);
  expect(result).toMatchObject({ outcome: "cancelled", checkedHead: null, verdict: null });
});

test("a selected reviewer absent from coverage keeps the result partial, even with a closed package", async () => {
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision, spawn(spec) {
    observedPreparedPackage(spec);
    writeFileSync(path.join(spec.cwd, ".metaproject/reviews/pkg/research.json"), JSON.stringify({ dispatch: { selected: ["review-logic", "review-style"] } }));
    return { exited: Promise.resolve(0), kill() {} };
  } });
  expect(result).toMatchObject({ outcome: "incomplete", checkedBase: baseSha, checkedHead: headSha, coverage: "partial" });
  expect(result.report).toContain("Status: **incomplete** (exit 2)");
  expect(result.report).toContain(result.reason);
  expect(readFileSync(path.join(runDir, "run/report.md"), "utf8")).toBe(result.report!);
  expect(JSON.parse(readFileSync(path.join(runDir, "run/summary.json"), "utf8"))).toMatchObject({
    status: "incomplete", exitCode: 2, reason: result.reason, package: { status: "closed", path: "../package" },
  });
});

test.each(["missing", "truncated", "invalid", "duplicate", "omitted from scope", "waived", "oversized"])("prepared Desktop coverage fails closed for %s evidence in collection and recovery", async kind => {
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision, spawn(spec) {
    preparedPackageAt(spec);
    const file = path.join(spec.cwd, ".metaproject/reviews/pkg/coverage.json");
    if (kind === "missing") rmSync(file);
    else if (kind === "truncated") writeFileSync(file, "{");
    else if (kind === "invalid") writeFileSync(file, JSON.stringify({ ...coveredFile, files: [{ file: "src.ts", status: "uncovered", scope: "A" }] }));
    else if (kind === "duplicate") {
      writeFileSync(path.join(path.dirname(file), "scope-files.json"), JSON.stringify({ files: ["src.ts"] }));
      writeFileSync(file, JSON.stringify({ ...coveredFile, counts: { ...coveredFile.counts, covered: 2, inScope: 2 },
        files: [...coveredFile.files, coveredFile.files[0]] }));
    } else if (kind === "omitted from scope") {
      writeFileSync(path.join(path.dirname(file), "scope-files.json"), JSON.stringify({ files: ["src.ts", "another.ts"] }));
    } else if (kind === "waived") writeFileSync(file, JSON.stringify({ ...coveredFile, waived: true }));
    else writeFileSync(file, JSON.stringify(coveredFile) + " ".repeat(8 * 1024 * 1024));
    writeFileSync(spec.eventsFile, JSON.stringify({ type: "request_usage", requestId: "review", participant: "reviewer",
      reviewer: "review-logic", usage: { inputTokens: 1, outputTokens: 1 } }) + "\n");
    return { exited: Promise.resolve(0), kill() {} };
  } });
  expect(result).toMatchObject({ outcome: "incomplete", coverage: "partial" });
  // Simulate interruption after the original runner recorded the package closure but before Desktop reconciled it.
  const summaryFile = path.join(runDir, "run/summary.json");
  const summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  writeFileSync(summaryFile, JSON.stringify({ ...summary, status: "complete", exitCode: 0, reason: "The package closed." }));
  const recovered = await recoverDeskExecution(runDir, options());
  expect(recovered).toMatchObject({ outcome: "incomplete", coverage: "partial" });
  expect(recovered?.report).toContain("Status: **incomplete** (exit 2)");
  expect(JSON.parse(readFileSync(summaryFile, "utf8"))).toMatchObject({ status: "incomplete", exitCode: 2, reason: recovered?.reason });
  expect(readFileSync(path.join(runDir, "run/report.md"), "utf8")).toBe(recovered!.report!);
});

test("the host attempt requires prepared evidence even if the planner exited before publishing its queue", async () => {
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd, revision, spawn(spec) {
    packageAt(spec, { base: baseSha, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
    const dir = path.join(spec.cwd, ".metaproject/reviews/pkg");
    writeFileSync(path.join(dir, "coverage.json"), JSON.stringify(coveredFile));
    writeFileSync(path.join(dir, "plan.json"), JSON.stringify({ v: 1, next: "dispatch", roster: ["review-logic"], dispatches: 1 }));
    return { exited: Promise.resolve(0), kill() {} };
  } });
  expect(result).toMatchObject({ outcome: "incomplete", coverage: "partial" });
  const file = path.join(runDir, "run/summary.json");
  const summary = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...summary, status: "complete", exitCode: 0 }));
  expect(await recoverDeskExecution(runDir, { ...options(), scope: LEGACY_DESK_RUN_SCOPE })).toMatchObject({ outcome: "complete" });
  expect(await recoverDeskExecution(runDir, options())).toMatchObject({ outcome: "incomplete", coverage: "partial" });
});

test("recovers durable closed package after a worker dies between finalizing the round and committing the UI result", async () => {
  const { recoverDeskExecution } = await import("./desk-run-executor");
  const target = { base: baseSha, head: headSha };
  const legacy = { ...options(), scope: LEGACY_DESK_RUN_SCOPE };
  const checkout = path.join(runDir, "checkout");
  packageAt({ cwd: checkout } as ChildSpec, target, [{ reviewer: "review-logic", status: "run" }]);
  mkdirSync(path.join(runDir, "run"));
  writeFileSync(path.join(runDir, "run/progress.json"), JSON.stringify({ packageId: "pkg" }));
  expect(await recoverDeskExecution(runDir, legacy)).toMatchObject({ outcome: "complete", checkedBase: baseSha, checkedHead: headSha, findings: { major: 1 } });
  expect(existsSync(path.join(runDir, "package/report.md"))).toBe(true);
  const mismatched = await recoverDeskExecution(runDir, { ...legacy, headSha: baseSha });
  expect(mismatched).toMatchObject({ outcome: "incomplete", verdict: null });
  expect(mismatched?.report).toContain("Status: **incomplete**");
  // An older package may lack coverage.json; a present invalid file still fails closed.
  writeFileSync(path.join(runDir, "package/coverage.json"), "null");
  expect(await recoverDeskExecution(runDir, legacy)).toMatchObject({ outcome: "incomplete", coverage: "partial" });
});

test("recovery retains a long report and derives its local verdict from classified findings at the pinned revision", async () => {
  const legacy = { ...options(), scope: LEGACY_DESK_RUN_SCOPE };
  const checkout = path.join(runDir, "checkout");
  const pkg = path.join(checkout, ".metaproject/reviews/pkg");
  const retained = path.join(runDir, "package");
  packageAt({ cwd: checkout } as ChildSpec, { base: baseSha, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
  const long = "long report section\n".repeat(8000) + "Full report ending";
  writeFileSync(path.join(pkg, "report.md"), long);
  writeFileSync(path.join(pkg, "findings.json"), JSON.stringify([{ id: "F-1", reviewer: "review-logic", severity: "major",
    verification: { verdict: "refuted", method: "site-check", evidence: "Guard present" } }]));
  mkdirSync(path.join(runDir, "run"));
  writeFileSync(path.join(runDir, "run/progress.json"), JSON.stringify({ packageId: "pkg" }));
  const recovered = await recoverDeskExecution(runDir, legacy);
  expect(recovered).toMatchObject({ outcome: "complete", findingsKnown: true, findings: { major: 0 }, verdict: "no findings" });
  expect(recovered?.report).toContain("Preview truncated. Full report: " + path.join(retained, "report.md"));
  expect(recovered?.report).not.toContain("Full report ending");
  expect(readFileSync(path.join(retained, "report.md"), "utf8")).toBe(long);
  writeFileSync(path.join(retained, "findings.json"), "[]");
  expect(await recoverDeskExecution(runDir, legacy)).toMatchObject({ findingsKnown: true, verdict: "no findings" });
  writeFileSync(path.join(retained, "findings.json"), "[null]");
  expect(await recoverDeskExecution(runDir, legacy)).toMatchObject({ outcome: "incomplete", findingsKnown: false, verdict: null });
});

test.skipIf(process.platform === "win32")("a real child process starts only after its PID guard is installed", async () => {
  const { defaultSpawn } = await import("./autonomous-run");
  const entry = path.join(root, "controlled-child.js");
  const ready = path.join(root, "started");
  const guard = path.join(root, "child.json");
  writeFileSync(entry, 'require("node:fs").writeFileSync(process.argv[2],"started")');
  // The guard loop invokes sleep only after observing that the PID file is absent.
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const waiting = path.join(root, "guard-waiting");
  writeFileSync(path.join(bin, "sleep"), '#!/bin/sh\n: > "$TEST_GUARD_WAITING"\nexec /bin/sleep "$@"\n', { mode: 0o755 });
  const reached = Promise.withResolvers<void>();
  const observer = watch(root, () => { if (existsSync(waiting)) reached.resolve(); });
  observer.on("error", reached.reject);
  const spawned = defaultSpawn({ execPath: process.execPath, script: entry }, guard)({
    cwd: root, argv: [ready], env: { PATH: bin + path.delimiter + process.env.PATH, TEST_GUARD_WAITING: waiting }, logFile: path.join(root, "child.log"), eventsFile: "", answersFile: "", runDir: root, stdin: "ignore",
  });
  try {
    await Promise.race([reached.promise, spawned.exited.then(() => { throw new Error("child exited before the PID guard was observed"); })]);
    expect(existsSync(ready)).toBe(false);
    writeFileSync(guard, JSON.stringify({ pid: spawned.pid }));
    expect(await spawned.exited).toBe(0);
    expect(existsSync(ready)).toBe(true);
  } finally { observer.close(); spawned.kill(); }
});

test.skipIf(process.platform === "win32").each([false, true])("a guarded coordinator stops when its worker disappears after launch (in grace period: %s)", async inGracePeriod => {
  const entry = path.join(root, "coordinator.js");
  const workerEntry = path.join(root, "worker.ts");
  const ready = path.join(root, "coordinator-started");
  const terminate = path.join(root, "terminate");
  const signalled = path.join(root, "coordinator-signalled");
  const guard = path.join(root, "child.json");
  writeFileSync(entry, `
    const { writeFileSync } = require("node:fs");
    process.on("SIGTERM", () => writeFileSync(process.argv[3], "received"));
    writeFileSync(process.argv[2], String(process.pid));
    setTimeout(() => {}, 8000);
  `);
  writeFileSync(workerEntry, `
    import { defaultSpawn } from ${JSON.stringify(path.resolve(import.meta.dir, "autonomous-run.ts"))};
    import { existsSync, writeFileSync } from "node:fs";
    const [root, entry, ready, guard, signalled, terminate] = process.argv.slice(2);
    const child = defaultSpawn({ execPath: process.execPath, script: entry }, guard)({
      cwd: root, argv: [ready, signalled], env: {}, logFile: root + "/child.log",
      eventsFile: "", answersFile: "", runDir: root, stdin: "ignore",
    });
    const check = setInterval(() => {
      if (!existsSync(terminate)) return;
      clearInterval(check);
      child.kill("SIGTERM");
    }, 20);
    check.unref();
    writeFileSync(guard, JSON.stringify({ pid: child.pid }));
    await child.exited;
  `);
  const worker = Bun.spawn([process.execPath, ...SAFE_BUN_SPAWN_ARGS, workerEntry, root, entry, ready, guard, signalled, terminate],
    { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "inherit" });
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the fixture process state");
      await Bun.sleep(20);
    }
  }
  try {
    await waitFor(() => existsSync(ready) && readFileSync(ready, "utf8").length > 0);
    const pid = readFileSync(ready, "utf8");
    expect(pid).toMatch(/^\d+$/);
    const alive = () => {
      const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", pid], { stderr: "ignore" });
      return result.exitCode === 0 && !result.stdout.toString().trimStart().startsWith("Z");
    };
    expect(alive()).toBe(true);
    if (inGracePeriod) {
      writeFileSync(terminate, "");
      await waitFor(() => existsSync(signalled));
      expect(alive()).toBe(true);
    }
    worker.kill("SIGKILL");
    await worker.exited;
    await waitFor(() => !alive());
  } finally { worker.kill("SIGKILL"); await worker.exited; }
}, 10_000);

test.each(["unavailable: Temporary GitHub failure", "access: GitHub access revoked"])(
  "classifies a checkout revision error before spending: %s",
  async reason => {
    let selected = false;
    const result = await executeDeskReview(options(), {
      remoteUrl: cwd,
      revision: async () => { throw new Error(reason); },
      selectModel() { selected = true; return selectModel(); },
    });
    expect(selected).toBe(false);
    expect(result).toMatchObject({ outcome: "failed", reason });
    expect(result.retryableBeforeSpend).toBe(reason.startsWith("unavailable:") ? true : undefined);
  },
);

test("a scheduled run rechecks access after fetching objects and before the model process starts", async () => {
  let checked = false;
  let spent = false;
  const result = await executeDeskReview(
    {
      ...options(),
      verifyBeforeExecution: async () => {
        checked = true;
      },
      authorizeSpawn() {
        throw new Error("stale: Rule paused before launch.");
      },
    },
    {
      selectModel, remoteUrl: cwd,
      revision,
      spawn() {
        spent = true;
        throw new Error("unexpected model call");
      },
    },
  );
  expect(checked).toBe(true);
  expect(spent).toBe(false);
  expect(result).toMatchObject({
    outcome: "blocked",
    reason: "stale: Rule paused before launch.",
    retryableBeforeSpend: true,
  });
});

test("preserves recovered package evidence after an exception in the guarded launch", async () => {
  const stop = Promise.withResolvers<number>();
  const killedAt: string[] = [];
  const out = await executeDeskReview({
    ...options(),
    authorizeSpawn(start) {
      start();
      throw new Error("Could not finish the launch transaction");
    },
  }, {
    selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      packageAt(spec, { base: baseSha, head: headSha }, []);
      writeFileSync(path.join(spec.runDir, "progress.json"), JSON.stringify({ packageId: "pkg" }));
      return { exited: stop.promise, kill() {
        killedAt.push(existsSync(spec.cwd) ? "checkout present" : "checkout removed");
        stop.resolve(128);
      } };
    },
  });
  expect(out).toMatchObject({ outcome: "failed", reason: "Could not finish the launch transaction" });
  expect(out.report).toContain("Status: **failed**");
  expect(out.report).toContain("Could not finish the launch transaction");
  expect(killedAt).toEqual(["checkout present"]);
  expect(existsSync(path.join(runDir, "checkout"))).toBe(false);
  expect(readFileSync(path.join(runDir, "package", "report.md"), "utf8")).toContain("Handle missing repository");
});

test("the scheduled token budget reaches the autonomous executor", async () => {
  const result = await executeDeskReview(
    { ...options(), budgetTokens: 9, budgetMinutes: 1 },
    {
      selectModel, remoteUrl: cwd,
      revision,
      spawn(spec) {
        writeFileSync(spec.eventsFile, JSON.stringify({ type: "usage", usage: { totalTokens: 10 } }) + "\n");
        let exit!: (code: number) => void;
        const exited = new Promise<number>((resolve) => {
          exit = resolve;
        });
        return {
          exited,
          kill() {
            exit(128);
          },
        };
      },
    },
  );
  expect(result.outcome).toBe("budget");
  expect(result.reason).toContain("token budget 9");
});

test("CI regressing during checkout is explicitly known not to have spent a scheduled budget", async () => {
  const result = await executeDeskReview(
    {
      ...options(),
      verifyBeforeExecution: async () => {
        throw new Error("stale: Waiting for passing CI on the selected revision.");
      },
    },
    {
      selectModel, remoteUrl: cwd,
      revision,
      spawn() {
        throw new Error("unexpected model call");
      },
    },
  );
  expect(result).toMatchObject({ outcome: "blocked", retryableBeforeSpend: true });
});

test("the default manual review can pass 250k tokens and finish", async () => {
  const initialPoll = Promise.withResolvers<ChildSpec>();
  const usageSeen = Promise.withResolvers<void>();
  const exit = Promise.withResolvers<number>();
  let child: ChildSpec | undefined;
  let killed = false;
  const execution = executeDeskReview({ ...options(), onProgress(progress) {
    if (child && progress.tokens === 0) initialPoll.resolve(child);
    if (progress.tokens === 300000) usageSeen.resolve();
  } }, {
    selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      child = spec;
      return { exited: exit.promise, kill() { killed = true; exit.resolve(128); } };
    },
  });
  const endedEarly = execution.then(result => { throw new Error(`Executor exited before the controlled poll: ${result.reason}`); });
  try {
    const spec = await Promise.race([initialPoll.promise, endedEarly]);
    writeFileSync(spec.eventsFile, JSON.stringify({ type: "usage", usage: { totalTokens: 300000 } }) + "\n");
    await Promise.race([usageSeen.promise, endedEarly]);
    expect(killed).toBe(false);
    observedPreparedPackage(spec);
  } finally {
    exit.resolve(0);
    await execution;
  }
  expect((await execution).outcome).toBe("complete");
});

test("an interrupted worker recovers measured requests even before it opened a package", async () => {
  const run = path.join(runDir, "run");
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, "events.ndjson"), [
    { type: "request_usage", requestId: "co", participant: "coordinator", usage: { inputTokens: 70, outputTokens: 10 } },
    { type: "request_start", requestId: "ch", participant: "reviewer", reviewer: "review-style" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  const recovered = await recoverDeskExecution(runDir, { ...options(), cancelled: true });
  expect(recovered?.findingsKnown).toBe(false);
  expect(recovered?.usage).toMatchObject({ partial: true, total: { totalTokens: 80 }, reviewers: [{ reviewer: "review-style" }] });
  expect(recovered?.outcome).toBe("cancelled");
});

test("a Desktop wave needs both its real result and the host's reviewer receipt", () => {
  const pkg = path.join(root, "package");
  mkdirSync(path.join(pkg, "raw"), { recursive: true });
  const role = "review-testing-practices";
  const file = `${role}-w1.txt`;
  writeFileSync(path.join(pkg, "plan.json"), JSON.stringify({ desktopDispatch: "desktop-dispatch.json", roster: [role], dispatches: 1 }));
  writeFileSync(path.join(pkg, "desktop-dispatch.json"), JSON.stringify({ calls: [{ label: role, save_result_to: `raw/${file}` }] }));
  const participation = { total: {}, coordinator: {}, reviewers: [{ reviewer: role, partial: true as const }], partial: true };
  expect(hasDesktopReviewerEvidence(pkg, participation)).toBe(false);
  const raw = path.join(pkg, "raw", file);
  writeFileSync(raw, 'STATUS: DONE\nREVIEW_RESULT:\n' + JSON.stringify({ reviewer: role, status: "DONE", findings: [] }));
  expect(hasDesktopReviewerEvidence(pkg, undefined)).toBe(false);
  expect(hasDesktopReviewerEvidence(pkg, participation)).toBe(true);
  writeFileSync(raw, 'reviewer was routed out; no result was dispatched');
  expect(hasDesktopReviewerEvidence(pkg, participation)).toBe(false);
});

test("Desktop exempts only the zero-wave roles verified by the original slice routing", () => {
  const pkg = path.join(root, "package"), role = "review-logic", excluded = "review-style";
  mkdirSync(path.join(pkg, "raw"), { recursive: true });
  mkdirSync(path.join(pkg, "slices"));
  const target = "raw/review-logic-w1.txt";
  const queue = { calls: [{ label: role, save_result_to: target }], routedOut: [excluded] };
  writeFileSync(path.join(pkg, "plan.json"), JSON.stringify({ roster: [role, excluded], dispatches: 1, desktopDispatch: "desktop-dispatch.json" }));
  writeFileSync(path.join(pkg, "desktop-dispatch.json"), JSON.stringify(queue));
  const manifest = { schemaVersion: 1, maxBytes: 100, waveBytes: 100, slices: [{ id: "slice-01", bytes: 10, files: ["src.ts"], roles: [role], depth: "light" }] };
  const manifestFile = path.join(pkg, "slices/manifest.json");
  writeFileSync(manifestFile, JSON.stringify(manifest));
  const usage = { total: {}, coordinator: {}, reviewers: [{ reviewer: role, partial: true as const }], partial: true };
  expect(hasDesktopReviewerEvidence(pkg, usage)).toBe(false);
  writeFileSync(path.join(pkg, target), 'STATUS: DONE\nREVIEW_RESULT:\n' + JSON.stringify({ reviewer: role, status: "DONE", findings: [] }));
  expect(hasDesktopReviewerEvidence(pkg, usage)).toBe(true);
  manifest.slices[0]!.roles.push(excluded);
  writeFileSync(manifestFile, JSON.stringify(manifest));
  expect(hasDesktopReviewerEvidence(pkg, usage)).toBe(false);
});

// Flow 520 AC7: a partial previous attempt (draft package, ingested findings) is handed to the next round of the same
// Review with Desktop's own partial-round record, so `review start` in the checkout builds a delta round on it.
function previousAttempt(files: { status?: string; findings?: unknown } = {}) {
  const previousRunDir = path.join(root, "runs", "attempt-0");
  const dir = path.join(previousRunDir, "package");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ schemaVersion: 1, reviewId: "prev", mode: "review-flow", status: files.status ?? "draft",
    target: { kind: "pr", ref: "https://github.com/example/project/pull/12", base: baseSha, head: baseSha }, createdAt: "2026-11-24T00:00:00.000Z" }));
  if (files.findings !== undefined) writeFileSync(path.join(dir, "findings.json"), JSON.stringify(files.findings));
  writeFileSync(path.join(dir, "research.json"), JSON.stringify({ version: 1, scopeReviewed: false, obligations: [], dispatch: { runs: [] } }));
  return previousRunDir;
}

async function runWithPrevious(previousRunDir: string, previousPartial: boolean | undefined, inspect: (checkout: string, registryDir: string) => Promise<void>) {
  const registryDir = path.join(root, "registry");
  let inspected = false;
  let failure: unknown;
  await executeDeskReview({ ...options(), previousRunDir, ...(previousPartial === undefined ? {} : { previousPartial }) }, {
    selectModel, remoteUrl: cwd, revision, registryDir,
    spawn(spec) {
      const exited = inspect(spec.cwd, registryDir).then(() => { inspected = true; return 0; }, (error: unknown) => { failure = error; return 1; });
      return { exited, kill() {} };
    },
  });
  if (failure !== undefined) throw failure;
  expect(inspected).toBe(true);
}

const priorFinding = { id: "F-1", reviewer: "review-logic", severity: "major", problem: "Handle missing repository", file: "src.ts", line: 1 };
const offlineGithub = async () => ({ status: "not-consulted" as const, detail: "offline (test)" });

test("flow 520 AC7: a partial previous attempt reaches the next round as a delta base with its findings", async () => {
  const { findPreviousRound } = await import("./prior-round");
  const { readRoundRegistry, repoIdentity } = await import("./round-registry");
  await runWithPrevious(previousAttempt({ findings: [priorFinding] }), true, async (checkout, registryDir) => {
    expect(existsSync(path.join(checkout, ".metaproject/reviews/prev/findings.json"))).toBe(true);
    const registry = readRoundRegistry(repoIdentity(checkout), registryDir);
    expect(registry).toEqual([expect.objectContaining({ packageId: "prev", reviewedHead: baseSha, event: "desk-partial" })]);
    const { round, priorFindings } = await findPreviousRound({ kind: "pr", ref: "https://github.com/example/project/pull/12", base: baseSha }, headSha,
      { cwd: checkout, github: offlineGithub, registry });
    expect(round).toMatchObject({ mode: "delta", previous: { reviewId: "prev", reviewedHead: baseSha }, range: { base: baseSha, head: headSha } });
    expect(priorFindings.map(finding => finding.id)).toEqual(["F-1"]);
  });
});

test("flow 520 AC7: a draft package is not handed on unless its attempt was partial with ingested findings", async () => {
  const absent = async (checkout: string, registryDir: string) => {
    expect(existsSync(path.join(checkout, ".metaproject/reviews/prev"))).toBe(false);
    expect(existsSync(path.join(registryDir, "review-rounds"))).toBe(false);
  };
  // A completed attempt's package must be closed: a draft from it is not a round.
  await runWithPrevious(previousAttempt({ findings: [priorFinding] }), false, absent);
  rmSync(path.join(root, "runs", "attempt-0"), { recursive: true, force: true });
  // A partial attempt without ingested findings gives no previous round.
  await runWithPrevious(previousAttempt(), true, absent);
});
