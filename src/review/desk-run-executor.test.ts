import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasDesktopReviewerEvidence } from "./desk-run-executor-recovery";
import { finishExecution } from "./desk-run-service";
import { executeDeskReview, recoverDeskExecution } from "./desk-run-executor";
import { SAFE_BUN_SPAWN_ARGS } from "../lib/safe-exec";
import type { ChildSpec } from "./autonomous-run";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, encoding: "utf8" }).trim();
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
  return { cwd, runDir, repo: "example/project", number: 12, headSha, baseSha, signal: controller.signal, onProgress: () => {} };
}

const selectModel = () => ({ provider: "test-provider", model: "test-model" });
const revision = async () => ({ baseRefName: "base", baseRefOid: baseSha, headRefOid: headSha, state: "OPEN" });

function packageAt(spec: ChildSpec, target: Record<string, unknown>, coverage: unknown) {
  const dir = path.join(spec.cwd, ".metaproject/reviews/pkg");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: "pkg", status: "closed", coverage, target: { kind: "pr", ref: "https://github.com/example/project/pull/12", ...target } }));
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify([{ id: "test-1", reviewer: "review-logic", severity: "major", problem: "Handle missing repository" }]));
  writeFileSync(path.join(dir, "report.md"), "## Findings\nHandle missing repository");
}

test("runs the orchestrator on pinned Git objects with trusted controls, leaving the working branch untouched and retaining the package", async () => {
  const phases: string[] = [];
  const context = { version: 1 as const, pr: { url: "https://github.com/example/project/pull/12", title: "linked PR", state: "OPEN", baseSha, headSha }, flows: [], totalFlows: 0, history: [], totalRuns: 0 };
  let inspected = false;
  const result = await executeDeskReview({ ...options(), context, onProgress: p => { phases.push(p.phase); } }, {
    selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      expect(spec.argv).toContain("--agent");
      expect(spec.argv).toContain("--print");
      expect(spec.argv[spec.argv.indexOf("--provider") + 1]).toBe("test-provider");
      expect(spec.argv[spec.argv.indexOf("--model") + 1]).toBe("test-model");
      expect(JSON.parse(readFileSync(path.join(spec.cwd, ".keryx-review-context.json"), "utf8"))).toEqual(context);
      expect(spec.argv.join(" ")).toContain("read_file tool in a separate tool call for .keryx-review-context.json");
      expect(git(spec.cwd, "rev-parse", "HEAD")).toBe(headSha);
      expect(git(spec.cwd, "show", headSha + ":src.ts")).toBe("review me");
      const scope = execFileSync(process.execPath, [...SAFE_BUN_SPAWN_ARGS, path.resolve(import.meta.dir, "../cli.ts"), "review", "scope", "--ref", baseSha, "--json"],
        { cwd: spec.cwd, encoding: "utf8", timeout: 30_000 });
      expect(JSON.stringify(JSON.parse(scope))).toContain("src.ts");
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toBe("trusted skill");
      expect(existsSync(path.join(spec.cwd, "bunfig.toml"))).toBe(false);
      expect(spec.argv.join(" ")).toContain(`keryx review plan --target https://github.com/example/project/pull/12 --ref ${baseSha} --head ${headSha} --host keryx-shell`);
      expect(spec.argv.join(" ")).not.toContain(" --unattended");
      expect(spec.argv.join(" ")).not.toContain("Open one more round");
      packageAt(spec, { base: baseSha, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
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
  expect(result.report).toContain("Handle missing repository");
  expect(phases).toContain("review ingest");
  expect(git(cwd, "branch", "--show-current")).toBe("base");
  expect(readFileSync(path.join(cwd, "src.ts"), "utf8")).toBe("uncommitted local edit");
  expect(existsSync(path.join(runDir, "checkout"))).toBe(false);
  expect(existsSync(path.join(runDir, "package", "report.md"))).toBe(true);
  expect(JSON.parse(readFileSync(path.join(runDir, "execution-result.json"), "utf8"))).toEqual(result);
});

test("an advancing remote base keeps the API-pinned range and loads controls from that exact base", async () => {
  writeFileSync(path.join(cwd, skill), "newer branch instructions");
  git(cwd, "add", skill);
  git(cwd, "commit", "-qm", "advance base branch");
  let reads = 0;
  const result = await executeDeskReview(options(), { selectModel, remoteUrl: cwd,
    revision: async () => { reads++; return revision(); },
    spawn(spec) {
      expect(readFileSync(path.join(spec.cwd, skill), "utf8")).toBe("trusted skill");
      expect(git(spec.cwd, "rev-parse", "HEAD")).toBe(headSha);
      expect(spec.argv.at(-1)).toContain(`--ref ${baseSha} --head ${headSha}`);
      packageAt(spec, { base: baseSha, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
      return { exited: Promise.resolve(0), kill() {} };
    },
  });
  expect(reads).toBe(2);
  expect(result).toMatchObject({ outcome: "complete", checkedBase: baseSha, checkedHead: headSha });
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
      packageAt(spec, { base: updated, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
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
    packageAt(spec, { base: baseSha, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
    writeFileSync(path.join(spec.cwd, ".metaproject/reviews/pkg/research.json"), JSON.stringify({ dispatch: { selected: ["review-logic", "review-style"] } }));
    return { exited: Promise.resolve(0), kill() {} };
  } });
  expect(result).toMatchObject({ outcome: "incomplete", checkedBase: baseSha, checkedHead: headSha, coverage: "partial" });
});

test("recovers durable closed package after a worker dies between finalizing the round and committing the UI result", async () => {
  const { recoverDeskExecution } = await import("./desk-run-executor");
  const target = { base: baseSha, head: headSha };
  const checkout = path.join(runDir, "checkout");
  packageAt({ cwd: checkout } as ChildSpec, target, [{ reviewer: "review-logic", status: "run" }]);
  mkdirSync(path.join(runDir, "run"));
  writeFileSync(path.join(runDir, "run/progress.json"), JSON.stringify({ packageId: "pkg" }));
  expect(recoverDeskExecution(runDir, options())).toMatchObject({ outcome: "complete", checkedBase: baseSha, checkedHead: headSha, findings: { major: 1 } });
  expect(existsSync(path.join(runDir, "package/report.md"))).toBe(true);
  expect(recoverDeskExecution(runDir, { ...options(), headSha: baseSha })).toMatchObject({ outcome: "incomplete", verdict: null });
});

test.skipIf(process.platform === "win32")("a real child process starts only after its PID guard is installed", async () => {
  const { defaultSpawn } = await import("./autonomous-run");
  const entry = path.join(root, "controlled-child.js");
  const ready = path.join(root, "started");
  const guard = path.join(root, "child.json");
  writeFileSync(entry, 'require("node:fs").writeFileSync(process.argv[2],"started")');
  const spawned = defaultSpawn({ execPath: process.execPath, script: entry }, guard)({
    cwd: root, argv: [ready], env: {}, logFile: path.join(root, "child.log"), eventsFile: "", answersFile: "", runDir: root, stdin: "ignore",
  });
  try {
    await Bun.sleep(100);
    expect(existsSync(ready)).toBe(false);
    writeFileSync(guard, JSON.stringify({ pid: spawned.pid }));
    expect(await spawned.exited).toBe(0);
    expect(existsSync(ready)).toBe(true);
  } finally { spawned.kill(); }
});

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
  const result = await executeDeskReview(options(), {
    selectModel, remoteUrl: cwd, revision,
    spawn(spec) {
      writeFileSync(spec.eventsFile, JSON.stringify({ type: "usage", usage: { totalTokens: 300000 } }) + "\n");
      let finish!: (code: number) => void;
      const exited = new Promise<number>(resolve => { finish = resolve; });
      // Leave usage visible through a real executor poll before closing the package.
      const timer = setTimeout(() => {
        packageAt(spec, { base: baseSha, head: headSha }, [{ reviewer: "review-logic", status: "run" }]);
        finish(0);
      }, 1800);
      return { exited, kill() { clearTimeout(timer); finish(128); } };
    },
  });
  expect(result.outcome).toBe("complete");
});

test("an interrupted worker recovers measured requests even before it opened a package", () => {
  const run = path.join(runDir, "run");
  mkdirSync(run, { recursive: true });
  writeFileSync(path.join(run, "events.ndjson"), [
    { type: "request_usage", requestId: "co", participant: "coordinator", usage: { inputTokens: 70, outputTokens: 10 } },
    { type: "request_start", requestId: "ch", participant: "reviewer", reviewer: "review-style" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  const recovered = recoverDeskExecution(runDir, { ...options(), cancelled: true });
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
