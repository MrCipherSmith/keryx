// Flow 306: the core CI-triage logic — question building, state bounding and
// redaction, verdict computation, advisory rendering, and the opt-in gate.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFixtureCiPort, CI_SPAWN_OUTPUT_CAP_BYTES, type CiBunSpawnFn, type CiBunSubprocess } from "./ci-port";
import {
  applyDeterministicOverride,
  buildCiTriageQuestions,
  buildCiTriageState,
  CI_TRIAGE_CRITERIA,
  CI_TRIAGE_LOG_CHARS,
  computeCiSignals,
  computeCiTriageVerdict,
  DEFAULT_GIT_SHOW_TIMEOUT_MS,
  extractFailingTestName,
  makeDefaultGitShow,
  normalizeRepoRelativePath,
  readCiTriageEnabled,
  readCiTriageEnabledDetailed,
  renderCiTriageAdvisory,
  type GitShow,
} from "./ci-triage";

describe("flow 307 review item 1: makeDefaultGitShow adds a timeout + output cap, never hangs (injected fake Bun.spawn)", () => {
  function fakeSubprocess(opts: { signalCode: string | null; exitedValue: number; stdoutText?: string }): CiBunSubprocess {
    return {
      stdout: new Response(opts.stdoutText ?? "").body,
      stderr: new Response("").body,
      exited: Promise.resolve(opts.exitedValue),
      signalCode: opts.signalCode,
    };
  }

  test("a process killed by our own timeout/cap degrades to undefined ('not checked'), never throws or hangs", async () => {
    const bunSpawn: CiBunSpawnFn = () => fakeSubprocess({ signalCode: "SIGKILL", exitedValue: 137 });
    const gitShow = makeDefaultGitShow(bunSpawn);
    await expect(gitShow("deadbeef", "src/x.ts")).resolves.toBeUndefined();
  });

  test("git is asked to spawn with the documented timeout, killSignal SIGKILL, and maxBuffer", async () => {
    let seenOpts: unknown;
    const bunSpawn: CiBunSpawnFn = (argv, opts) => {
      seenOpts = opts;
      return fakeSubprocess({ signalCode: null, exitedValue: 0, stdoutText: "content" });
    };
    const gitShow = makeDefaultGitShow(bunSpawn);
    await gitShow("deadbeef", "src/x.ts");
    expect(seenOpts).toEqual({
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: DEFAULT_GIT_SHOW_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: CI_SPAWN_OUTPUT_CAP_BYTES,
    });
  });

  test("a clean exit returns the captured content", async () => {
    const bunSpawn: CiBunSpawnFn = () => fakeSubprocess({ signalCode: null, exitedValue: 0, stdoutText: 'import { x } from "./y";' });
    const gitShow = makeDefaultGitShow(bunSpawn);
    expect(await gitShow("deadbeef", "src/x.ts")).toBe('import { x } from "./y";');
  });

  test("a spawn that throws synchronously (e.g. `git` missing) also degrades to undefined", async () => {
    const bunSpawn: CiBunSpawnFn = () => {
      throw new Error("spawn git ENOENT");
    };
    const gitShow = makeDefaultGitShow(bunSpawn);
    await expect(gitShow("deadbeef", "src/x.ts")).resolves.toBeUndefined();
  });
});

describe("AC7: one noul question per criterion, not one choice question", () => {
  test("buildCiTriageQuestions returns exactly the three criteria, each type noul", () => {
    const questions = buildCiTriageQuestions();
    expect(Object.keys(questions).sort()).toEqual([...CI_TRIAGE_CRITERIA].sort());
    for (const criterion of CI_TRIAGE_CRITERIA) {
      expect(questions[criterion].type).toBe("noul");
      expect(questions[criterion].instructions.length).toBeGreaterThan(0);
    }
  });

  test("computeCiTriageVerdict turns three noul answers into a probability per option and a top pick", () => {
    const verdict = computeCiTriageVerdict({
      flaky: { noul: 0.72 },
      infra: { noul: 0.1 },
      "real-regression": { noul: 0.2 },
    });
    expect(verdict.probabilities).toEqual({ flaky: 0.72, infra: 0.1, "real-regression": 0.2 });
    expect(verdict.top).toBe("flaky");
    expect(verdict.topProbability).toBe(0.72);
  });

  test("a missing or non-finite answer clamps to 0 rather than throwing", () => {
    const verdict = computeCiTriageVerdict({ flaky: { noul: Number.NaN }, "real-regression": { noul: 0.9 } });
    expect(verdict.probabilities.flaky).toBe(0);
    expect(verdict.probabilities.infra).toBe(0);
    expect(verdict.top).toBe("real-regression");
  });

  test("renderCiTriageAdvisory prints all three probabilities and labels the output advisory", () => {
    const verdict = computeCiTriageVerdict({ flaky: { noul: 0.6 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.3 } });
    const text = renderCiTriageAdvisory({ runId: "42", jobName: "typecheck-and-tests", testName: "src/x.test.ts:1", verdict });
    expect(text).toContain("ADVISORY ONLY");
    expect(text).toContain("flaky: 60%");
    expect(text).toContain("infra: 10%");
    expect(text).toContain("real-regression: 30%");
    expect(text).toContain("top: flaky");
    // AC9's advisory-text half: no rerun/merge/status-check language claims an action was taken.
    expect(text).not.toMatch(/\brerun(ning|s)?\b.*\b(triggered|started|queued)\b/i);
  });
});

describe("AC11: bounded, redacted state", () => {
  test("a planted secret token never reaches the built state", () => {
    const planted = "sk-ant-api03-PLANTED-SECRET-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";
    const rawLog = `some log line\nAuthorization: Bearer ${planted}\nfailure at src/x.test.ts:1\n`;
    const state = buildCiTriageState({ testName: "src/x.test.ts:1", jobName: "job", rawLog });
    expect(state).not.toContain(planted);
  });

  test("the state is bounded to CI_TRIAGE_LOG_CHARS even for a very long log", () => {
    const rawLog = "x".repeat(CI_TRIAGE_LOG_CHARS * 5);
    const state = buildCiTriageState({ testName: "t", jobName: "job", rawLog });
    // Header lines plus the bounded tail.
    expect(state.length).toBeLessThan(CI_TRIAGE_LOG_CHARS + 200);
  });

  test("bounding keeps the TAIL of the log (the failure is usually at the end)", () => {
    const rawLog = `${"padding\n".repeat(CI_TRIAGE_LOG_CHARS)}THE ACTUAL FAILURE`;
    const state = buildCiTriageState({ testName: "t", jobName: "job", rawLog });
    expect(state).toContain("THE ACTUAL FAILURE");
  });

  test("a short log is carried through unmodified apart from redaction", () => {
    const state = buildCiTriageState({ testName: "src/x.test.ts:1", jobName: "typecheck-and-tests", rawLog: "boom" });
    expect(state).toContain("job: typecheck-and-tests");
    expect(state).toContain("failing test: src/x.test.ts:1");
    expect(state).toContain("boom");
  });

  test("flow 306 review item 2: a planted secret in testName or jobName never reaches the built state either", () => {
    const planted = "sk-ant-api03-PLANTED-SECRET-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";
    const inTestName = buildCiTriageState({ testName: `src/x.test.ts:1 ${planted}`, jobName: "job", rawLog: "boom" });
    expect(inTestName).not.toContain(planted);
    const inJobName = buildCiTriageState({ testName: "src/x.test.ts:1", jobName: `job ${planted}`, rawLog: "boom" });
    expect(inJobName).not.toContain(planted);
  });
});

describe("extractFailingTestName", () => {
  test("finds a test-path:line pattern on this job's own log line", () => {
    const rawLog = "typecheck-and-tests\tRun tests\tat async (/work/src/learning/e2e.test.ts:115:37)\n";
    expect(extractFailingTestName(rawLog, "typecheck-and-tests")).toBe("/work/src/learning/e2e.test.ts:115");
  });

  test("returns undefined when nothing matches", () => {
    expect(extractFailingTestName("no test path here\n", "job")).toBeUndefined();
  });

  test("ignores a matching line that belongs to a different job", () => {
    const rawLog = "other-job\tstep\tat (src/x.test.ts:5:1)\n";
    expect(extractFailingTestName(rawLog, "typecheck-and-tests")).toBeUndefined();
  });
});

describe("AC10: opt-in gate", () => {
  let dir = "";
  async function withConfig(config: unknown): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-triage-config-"));
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    if (config !== undefined) {
      await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify(config), "utf8");
    }
    return dir;
  }

  test("no config file at all -> false", async () => {
    const cwd = await withConfig(undefined);
    try {
      expect(await readCiTriageEnabled(cwd)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("review.jev.ci_triage: true -> true", async () => {
    const cwd = await withConfig({ review: { jev: { ci_triage: true } } });
    try {
      expect(await readCiTriageEnabled(cwd)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("review.jev.ci_triage: false, or absent -> false", async () => {
    const cwd = await withConfig({ review: { jev: { ci_triage: false } } });
    try {
      expect(await readCiTriageEnabled(cwd)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const cwd2 = await withConfig({ review: {} });
    try {
      expect(await readCiTriageEnabled(cwd2)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("unparsable config -> false, never throws", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-triage-config-"));
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), "{not json", "utf8");
    try {
      expect(await readCiTriageEnabled(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("Flow 346: ci_triage default-on through the shared resolveJevProfileFlag", () => {
  let dir = "";
  let cfgDir = "";

  afterEach(async () => {
    if (dir.length > 0) await rm(dir, { recursive: true, force: true });
    if (cfgDir.length > 0) await rm(cfgDir, { recursive: true, force: true });
    dir = "";
    cfgDir = "";
  });

  async function freshProjectDir(config?: unknown): Promise<string> {
    dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-triage-default-on-cwd-"));
    await mkdir(path.join(dir, ".metaproject"), { recursive: true });
    if (config !== undefined) {
      await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify(config), "utf8");
    }
    return dir;
  }

  async function freshConfigDir(): Promise<string> {
    cfgDir = await mkdtemp(path.join(tmpdir(), "keryx-ci-triage-default-on-cfg-"));
    return cfgDir;
  }

  test("unset + external on (default) + a Jev credential available -> defaults to true", async () => {
    const cwd = await freshProjectDir(undefined);
    const configDir = await freshConfigDir();
    const result = await readCiTriageEnabledDetailed(cwd, { jevAvailable: true, configDir });
    expect(result).toEqual({ value: true, source: "default-because-jev-available" });
    expect(await readCiTriageEnabled(cwd, { jevAvailable: true, configDir })).toBe(true);
  });

  test("unset + external on + NO credential available -> stays false", async () => {
    const cwd = await freshProjectDir(undefined);
    const configDir = await freshConfigDir();
    const result = await readCiTriageEnabledDetailed(cwd, { jevAvailable: false, configDir });
    expect(result).toEqual({ value: false, source: "off" });
  });

  test("the project's own tasks.config.json external: \"off\" always wins over the default, even with a credential available", async () => {
    const cwd = await freshProjectDir({ external: "off" });
    const configDir = await freshConfigDir();
    const result = await readCiTriageEnabledDetailed(cwd, { jevAvailable: true, configDir });
    expect(result).toEqual({ value: false, source: "off-by-external" });
  });

  test("an explicit review.jev.ci_triage: false always wins, even with a credential available and external on", async () => {
    const cwd = await freshProjectDir({ review: { jev: { ci_triage: false } } });
    const configDir = await freshConfigDir();
    const result = await readCiTriageEnabledDetailed(cwd, { jevAvailable: true, configDir });
    expect(result).toEqual({ value: false, source: "explicit" });
  });
});

describe("flow 307 AC1: deterministic signals, computed before Jev is asked", () => {
  const fakeGitShow = (content?: string): GitShow => async () => content;

  test("(a) rerun: a job that passed on an earlier attempt of the same run is deterministic evidence", async () => {
    const port = createFixtureCiPort({
      attempts: {
        "9": [
          { attempt: 1, jobs: [{ name: "typecheck-and-tests", conclusion: "success" }] },
          { attempt: 2, jobs: [{ name: "typecheck-and-tests", conclusion: "failure" }] },
        ],
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "typecheck-and-tests", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.rerun).toEqual({ attemptsChecked: 2, samePassedOnPriorAttempt: true });
    expect(signals.deterministic).toEqual({ verdict: "flaky", reason: expect.stringContaining("earlier attempt") });
    expect(signals.lines.some((l) => l.startsWith("rerun:") && l.includes("SAME job passed"))).toBe(true);
  });

  test("(a) rerun: never rerun -> zero attempts checked, no deterministic evidence from this signal", async () => {
    const port = createFixtureCiPort({});
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "typecheck-and-tests", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.rerun).toEqual({ attemptsChecked: 0, samePassedOnPriorAttempt: false });
    expect(signals.deterministic).toBeUndefined();
  });

  test("(b) history: another failed run of the same job/test, and whether it later passed on that branch", async () => {
    const port = createFixtureCiPort({
      history: {
        CI: [
          { runId: "9", conclusion: "failure", createdAt: "2026-09-23T12:00:00Z", headBranch: "this-pr" },
          { runId: "5", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "feat/x" },
          { runId: "6", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "feat/x" },
        ],
      },
      runs: {
        "5": {
          runId: "5",
          workflowName: "CI",
          headBranch: "feat/x",
          headSha: "aaa",
          conclusion: "failure",
          jobs: [{ name: "typecheck-and-tests", conclusion: "failure" }],
        },
      },
      logs: { "5": "typecheck-and-tests\tTest\tsrc/x.test.ts:1 boom\n" },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "typecheck-and-tests", testName: "src/x.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.history.runsInspected).toBe(1);
    expect(signals.history.sameTestFailuresOnOtherBranches).toBe(1);
    expect(signals.history.sameTestFailuresThenPassed).toBe(1);
  });

  test("(b) history: a candidate run whose job did NOT fail is inspected but not counted", async () => {
    const port = createFixtureCiPort({
      history: { CI: [{ runId: "5", conclusion: "failure", createdAt: null, headBranch: "feat/x" }] },
      runs: {
        "5": {
          runId: "5",
          workflowName: "CI",
          headBranch: "feat/x",
          headSha: "aaa",
          conclusion: "failure",
          jobs: [{ name: "typecheck-and-tests", conclusion: "success" }, { name: "other-job", conclusion: "failure" }],
        },
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "typecheck-and-tests", testName: "src/x.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.history.runsInspected).toBe(1);
    expect(signals.history.sameTestFailuresOnOtherBranches).toBe(0);
  });

  test("(c) diff: the commit changes the failing test file itself", async () => {
    const port = createFixtureCiPort({ changedFiles: { deadbeef: ["src/x.test.ts", "src/other.ts"] } });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: "src/x.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.diff).toEqual({ changedFileCount: 2, touchesFailingFile: true, touchesFailingDir: false, touchesImportedFile: false });
  });

  test("(c) diff: the commit changes a sibling file in the failing test's own directory", async () => {
    const port = createFixtureCiPort({ changedFiles: { deadbeef: ["src/review/ci-port.ts"] } });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: "src/review/ci-triage.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.diff.touchesFailingDir).toBe(true);
    expect(signals.diff.touchesFailingFile).toBe(false);
  });

  test("(c) diff: a runner-absolute test path is normalized to repo-relative before comparison", async () => {
    const port = createFixtureCiPort({ changedFiles: { deadbeef: ["src/commands/trigger-dispatch.test.ts"] } });
    const signals = await computeCiSignals(
      port,
      {
        runId: "9",
        jobName: "j",
        testName: "/home/runner/work/keryx/keryx/src/commands/trigger-dispatch.test.ts:766",
        rawLog: "",
        headSha: "deadbeef",
        workflowName: "CI",
      },
      fakeGitShow(),
    );
    expect(signals.diff.touchesFailingFile).toBe(true);
  });

  test("(c) diff: no file/dir match, but the test imports a changed file (via git show)", async () => {
    // The changed file lives in a DIFFERENT directory from the failing test, so
    // touchesFailingDir stays false and the import-based check is what fires.
    const port = createFixtureCiPort({ changedFiles: { deadbeef: ["src/review/cost.ts"] } });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: "src/tui/ci-triage-source.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow('import { estimateTokens } from "../review/cost";\n'),
    );
    expect(signals.diff.touchesImportedFile).toBe(true);
    expect(signals.diff.touchesFailingFile).toBe(false);
    expect(signals.diff.touchesFailingDir).toBe(false);
  });

  test("(c) diff: none of file/dir/import touched", async () => {
    const port = createFixtureCiPort({ changedFiles: { deadbeef: ["docs/readme.md"] } });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: "src/review/ci-triage.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow("no imports here"),
    );
    expect(signals.diff.touchesFailingFile).toBe(false);
    expect(signals.diff.touchesFailingDir).toBe(false);
    expect(signals.diff.touchesImportedFile).toBe(false);
  });

  test("(d) log markers: a timeout marker sets both the infra label and the timeout flag", async () => {
    const port = createFixtureCiPort({});
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "this test timed out after 5000ms.", headSha: "x", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.logMarkers.infra).toContain("timeout");
    expect(signals.logMarkers.timeout).toBe(true);
  });

  test("(d) log markers: a network error marker is detected", async () => {
    const port = createFixtureCiPort({});
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "fetch failed: ECONNRESET", headSha: "x", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.logMarkers.infra).toContain("network error");
  });

  test("(d) log markers: a real self-hosted-runner dependency-install corruption is recognised (regression fixture)", async () => {
    const port = createFixtureCiPort({});
    const rawLog = 'error: failed to enqueue lifecycle scripts for protobufjs: ParserError\n... at .../node_modules/protobufjs/package.json:1:1';
    const signals = await computeCiSignals(port, { runId: "9", jobName: "j", testName: undefined, rawLog, headSha: "x", workflowName: "CI" }, fakeGitShow());
    expect(signals.logMarkers.infra).toContain("dependency-install corruption");
  });

  test("(d) log markers: a clean pass-through log detects nothing", async () => {
    const port = createFixtureCiPort({});
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "expect(received).toBe(expected)\nReceived: true\n", headSha: "x", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.logMarkers.infra).toEqual([]);
    expect(signals.logMarkers.timeout).toBe(false);
  });

  test("AC8: a later run of the exact same commit passing is deterministic evidence (same-head), ONLY once this specific job is verified to have passed in it", async () => {
    const port = createFixtureCiPort({
      runsByHeadSha: {
        "CI:deadbeef": [
          { runId: "9", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "b" },
          { runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" },
        ],
      },
      // Flow 307 review, item 3: a run-level "success" alone is not enough —
      // the later run's own job list must show THIS job ("j") itself
      // concluded success, read through the existing read-only `runInfo`.
      runs: {
        "11": { runId: "11", workflowName: "CI", headBranch: "b", headSha: "deadbeef", conclusion: "success", jobs: [{ name: "j", conclusion: "success" }] },
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.sameHeadLaterPassed).toBe(true);
    expect(signals.deterministic).toEqual({ verdict: "flaky", reason: expect.stringContaining("itself conclude success") });
    expect(signals.lines.some((l) => l.startsWith("same head:") && l.includes('job "j" itself concluded success'))).toBe(true);
  });

  test("flow 307 review item 3: a later run green AT RUN LEVEL, but this job is MISSING from it — no override, advisory only", async () => {
    const port = createFixtureCiPort({
      runsByHeadSha: {
        "CI:deadbeef": [
          { runId: "9", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "b" },
          { runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" },
        ],
      },
      // The later run's own job list does not even contain "j" (imagine a
      // matrix job that was dropped, or a workflow edit) — a run-level green
      // that says nothing about THIS job.
      runs: {
        "11": {
          runId: "11",
          workflowName: "CI",
          headBranch: "b",
          headSha: "deadbeef",
          conclusion: "success",
          jobs: [{ name: "some-other-job", conclusion: "success" }],
        },
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.sameHeadLaterPassed).toBe(false);
    expect(signals.deterministic).toBeUndefined();
    expect(signals.lines.some((l) => l.startsWith("same head:") && l.includes("could not be") && l.includes("no override applied"))).toBe(true);
  });

  test("flow 307 review item 3: a later run green AT RUN LEVEL, but this job is SKIPPED in it — no override, advisory only", async () => {
    const port = createFixtureCiPort({
      runsByHeadSha: {
        "CI:deadbeef": [
          { runId: "9", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "b" },
          { runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" },
        ],
      },
      runs: {
        "11": { runId: "11", workflowName: "CI", headBranch: "b", headSha: "deadbeef", conclusion: "success", jobs: [{ name: "j", conclusion: "skipped" }] },
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.sameHeadLaterPassed).toBe(false);
    expect(signals.deterministic).toBeUndefined();
  });

  test("AC8: rerun evidence takes priority over same-head evidence when both are present", async () => {
    const port = createFixtureCiPort({
      attempts: { "9": [{ attempt: 1, jobs: [{ name: "j", conclusion: "success" }] }] },
      runsByHeadSha: { "CI:deadbeef": [{ runId: "11", conclusion: "success", createdAt: null, headBranch: "b" }] },
    });
    const signals = await computeCiSignals(port, { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" }, fakeGitShow());
    expect(signals.deterministic?.reason).toContain("earlier attempt");
  });

  test("post-merge review gap, item 2: a later run with TWO jobs sharing this job's name is ambiguous — no override, advisory only", async () => {
    const port = createFixtureCiPort({
      runsByHeadSha: {
        "CI:deadbeef": [
          { runId: "9", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "b" },
          { runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" },
        ],
      },
      // A matrix leg (or a reused workflow) can leave two jobs sharing the
      // same name in one run — one of them succeeded, but `.find()` used to
      // treat whichever came first as authoritative regardless of the other.
      runs: {
        "11": {
          runId: "11",
          workflowName: "CI",
          headBranch: "b",
          headSha: "deadbeef",
          conclusion: "success",
          jobs: [
            { name: "j", conclusion: "success" },
            { name: "j", conclusion: "failure" },
          ],
        },
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.sameHeadLaterPassed).toBe(false);
    expect(signals.deterministic).toBeUndefined();
    expect(
      signals.lines.some((l) => l.startsWith("same head:") && l.includes("more than one job was named") && l.includes("no override applied")),
    ).toBe(true);
  });

  test("post-merge review gap, item 3: the triaged run's own entry is missing from runsForHeadSha (pagination) — no override, advisory only", async () => {
    const port = createFixtureCiPort({
      runsByHeadSha: {
        // Run "9" (the run under triage) is NOT in this list at all — as if
        // the live `-L 10` cap on `gh run list --commit <sha>` pushed it off
        // the page. The old `current === undefined || isLaterTimestamp(...)`
        // short-circuit treated every success here as "later" regardless —
        // which could credit a run that actually ran BEFORE "9" as same-head
        // rerun evidence, with no baseline to check that against.
        "CI:deadbeef": [{ runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" }],
      },
      runs: {
        "11": { runId: "11", workflowName: "CI", headBranch: "b", headSha: "deadbeef", conclusion: "success", jobs: [{ name: "j", conclusion: "success" }] },
      },
    });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.sameHeadLaterPassed).toBe(false);
    expect(signals.deterministic).toBeUndefined();
    // Skipped outright, not "checked and found unverified" — run 11's own job list is never even read.
    expect(port.calls.some((c) => c.op === "runInfo" && c.runId === "11")).toBe(false);
    expect(
      signals.lines.some(
        (l) => l.startsWith("same head:") && l.includes("this run's own entry was not among them") && l.includes("no override applied"),
      ),
    ).toBe(true);
  });

  test("post-merge review gap, item 3: runsForHeadSha empty entirely -> no same-head line at all (unchanged from before)", async () => {
    const port = createFixtureCiPort({});
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.lines.some((l) => l.startsWith("same head:"))).toBe(false);
  });

  describe("post-merge review gap, item 4: runInfo lookups for OTHER runs are cached per run, not per job", () => {
    function threeJobFixture() {
      return createFixtureCiPort({
        runsByHeadSha: {
          "CI:deadbeef": [
            { runId: "9", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "b" },
            { runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" },
          ],
        },
        runs: {
          "11": {
            runId: "11",
            workflowName: "CI",
            headBranch: "b",
            headSha: "deadbeef",
            conclusion: "success",
            jobs: [
              { name: "job-a", conclusion: "success" },
              { name: "job-b", conclusion: "success" },
              { name: "job-c", conclusion: "success" },
            ],
          },
        },
      });
    }

    test("a shared runInfoCache in precomputed de-duplicates the same-head runInfo(11) read across 3 jobs of the same run", async () => {
      const port = threeJobFixture();
      const runInfoCache = new Map();
      for (const jobName of ["job-a", "job-b", "job-c"]) {
        await computeCiSignals(
          port,
          { runId: "9", jobName, testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
          fakeGitShow(),
          { runInfoCache },
        );
      }
      expect(port.calls.filter((c) => c.op === "runInfo").length).toBe(1);
    });

    test("without a shared runInfoCache, the same read is repeated once per job (the bug this fixes)", async () => {
      const port = threeJobFixture();
      for (const jobName of ["job-a", "job-b", "job-c"]) {
        await computeCiSignals(
          port,
          { runId: "9", jobName, testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" },
          fakeGitShow(),
        );
      }
      expect(port.calls.filter((c) => c.op === "runInfo").length).toBe(3);
    });

    // Flow 326, AC6 (CI-triage leftover from PR #713): `getRunInfo` caches a
    // REJECTED promise exactly the same way it caches a resolved one — a run
    // whose own job list cannot be read stays unreadable for every later job
    // asking about it, in the same shape an uncached read would have given
    // each of them anyway. Without this, a second job hitting the cache could
    // in principle see different (or throw differently from) a fresh read.
    function fixtureWithUnreadableRun11() {
      return createFixtureCiPort({
        runsByHeadSha: {
          "CI:deadbeef": [
            { runId: "9", conclusion: "failure", createdAt: "2026-09-23T09:00:00Z", headBranch: "b" },
            { runId: "11", conclusion: "success", createdAt: "2026-09-23T10:00:00Z", headBranch: "b" },
          ],
        },
        // No `runs["11"]` fixture: `port.runInfo("11")` rejects (see `createFixtureCiPort`).
      });
    }

    test("a rejected runInfo(11) promise stored in runInfoCache degrades a LATER job's lookup exactly like the uncached path", async () => {
      const cachedPort = fixtureWithUnreadableRun11();
      const runInfoCache = new Map();
      const jobInput = (jobName: string) => ({
        runId: "9",
        jobName,
        testName: undefined,
        rawLog: "",
        headSha: "deadbeef",
        workflowName: "CI",
      });

      // job-a's own read populates the cache with a REJECTED promise for run "11".
      await computeCiSignals(cachedPort, jobInput("job-a"), fakeGitShow(), { runInfoCache });
      // job-b hits that cached rejection rather than calling the port again.
      const cachedJobB = await computeCiSignals(cachedPort, jobInput("job-b"), fakeGitShow(), { runInfoCache });

      // The uncached path: a fresh port, no precomputed cache at all — job-b's
      // own `port.runInfo("11")` call rejects independently.
      const uncachedPort = fixtureWithUnreadableRun11();
      const uncachedJobB = await computeCiSignals(uncachedPort, jobInput("job-b"), fakeGitShow());

      expect(cachedJobB).toEqual(uncachedJobB);
      // The degrade shape itself: no deterministic override, an advisory-only
      // "could not be confirmed" line, same as an unreadable run always gets.
      expect(cachedJobB.sameHeadLaterPassed).toBe(false);
      expect(cachedJobB.deterministic).toBeUndefined();
      expect(
        cachedJobB.lines.some(
          (l) => l.startsWith("same head:") && l.includes("could not be") && l.includes("no override applied"),
        ),
      ).toBe(true);

      // Only ONE real `runInfo(11)` call for the whole cached run: job-b's
      // lookup was answered from the cached (rejected) promise, never the port.
      expect(cachedPort.calls.filter((c) => c.op === "runInfo").length).toBe(1);
    });
  });

  test("a port that throws on every read degrades every signal to 'not checked' rather than failing the triage", async () => {
    const throwingPort = createFixtureCiPort({});
    // No fixtures registered for anything: runInfo/failedLog throw for unknown ids, priorAttempts/changedFiles/runsForHeadSha answer empty.
    const signals = await computeCiSignals(
      throwingPort,
      { runId: "missing", jobName: "j", testName: "src/x.test.ts:1", rawLog: "boom", headSha: "missing", workflowName: "CI" },
      fakeGitShow(),
    );
    expect(signals.rerun.attemptsChecked).toBe(0);
    expect(signals.history.runsInspected).toBe(0);
    expect(signals.diff.changedFileCount).toBe(0);
    expect(signals.sameHeadLaterPassed).toBe(false);
    expect(signals.lines.length).toBeGreaterThan(0);
  });

  test("flow 307 review, minor: headSha === '' skips changedFiles/git-show entirely — diff stays at its default", async () => {
    const port = createFixtureCiPort({ changedFiles: { "": ["src/x.test.ts"] } });
    const signals = await computeCiSignals(
      port,
      { runId: "9", jobName: "j", testName: "src/x.test.ts:1", rawLog: "", headSha: "", workflowName: "CI" },
      fakeGitShow("import { x } from \"./y\";"),
    );
    expect(signals.diff).toEqual({ changedFileCount: 0, touchesFailingFile: false, touchesFailingDir: false, touchesImportedFile: false });
    // Neither `changedFiles` nor `gitShow` (via `runsForHeadSha`'s sibling
    // reads) was ever asked about the empty sha — `port.calls` records every
    // request this fixture answered, in order.
    expect(port.calls.some((c) => c.op === "changedFiles")).toBe(false);
  });

  describe("flow 307 review, item 2: `precomputed` lets a caller supply the run-level reads once, for several jobs", () => {
    test("priorAttempts/changedFiles/runsForHeadSha are never read through the port when precomputed is supplied", async () => {
      const port = createFixtureCiPort({});
      const signals = await computeCiSignals(
        port,
        { runId: "9", jobName: "j", testName: "src/x.test.ts:1", rawLog: "", headSha: "deadbeef", workflowName: "CI" },
        fakeGitShow(),
        {
          priorAttempts: [{ attempt: 1, jobs: [{ name: "j", conclusion: "success" }] }],
          changedFiles: ["src/x.test.ts"],
          runsForHeadSha: [],
        },
      );
      // The precomputed data was actually used (not silently ignored)...
      expect(signals.rerun).toEqual({ attemptsChecked: 1, samePassedOnPriorAttempt: true });
      expect(signals.diff.touchesFailingFile).toBe(true);
      // ...and none of the three run-level reads this precomputed data
      // covers were repeated through the port (an empty fixture port would
      // otherwise have thrown or answered empty, producing different
      // numbers above).
      expect(port.calls.filter((c) => c.op === "priorAttempts")).toHaveLength(0);
      expect(port.calls.filter((c) => c.op === "changedFiles")).toHaveLength(0);
      expect(port.calls.filter((c) => c.op === "runsForHeadSha")).toHaveLength(0);
    });

    test("omitting precomputed falls back to reading the port directly, unchanged from before this field existed", async () => {
      const port = createFixtureCiPort({
        attempts: { "9": [{ attempt: 1, jobs: [{ name: "j", conclusion: "success" }] }] },
      });
      const signals = await computeCiSignals(port, { runId: "9", jobName: "j", testName: undefined, rawLog: "", headSha: "deadbeef", workflowName: "CI" }, fakeGitShow());
      expect(signals.rerun.samePassedOnPriorAttempt).toBe(true);
      expect(port.calls.some((c) => c.op === "priorAttempts")).toBe(true);
    });
  });

  test("normalizeRepoRelativePath strips a runner-absolute prefix and leaves a repo-relative path alone", () => {
    expect(normalizeRepoRelativePath("/home/runner/work/keryx/keryx/src/x.test.ts")).toBe("src/x.test.ts");
    expect(normalizeRepoRelativePath("/Users/runner/work/keryx/keryx/src/x.test.ts")).toBe("src/x.test.ts");
    expect(normalizeRepoRelativePath("src/x.test.ts")).toBe("src/x.test.ts");
  });
});

describe("flow 307 AC8: applyDeterministicOverride shows Jev's probabilities beside, not instead of, the forced verdict", () => {
  test("no deterministic signal -> verdict returned unchanged", () => {
    const verdict = computeCiTriageVerdict({ flaky: { noul: 0.2 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.6 } });
    const port = createFixtureCiPort({});
    // A signals object with no deterministic field, built directly rather than through computeCiSignals for a pure-function test.
    const signals = { deterministic: undefined } as unknown as Parameters<typeof applyDeterministicOverride>[1];
    expect(applyDeterministicOverride(verdict, signals)).toEqual(verdict);
    void port;
  });

  test("a deterministic signal overrides top/topProbability but leaves probabilities untouched", () => {
    const verdict = computeCiTriageVerdict({ flaky: { noul: 0.1 }, infra: { noul: 0.05 }, "real-regression": { noul: 0.8 } });
    const signals = { deterministic: { verdict: "flaky" as const, reason: "same run rerun passed" } } as unknown as Parameters<
      typeof applyDeterministicOverride
    >[1];
    const overridden = applyDeterministicOverride(verdict, signals);
    expect(overridden.top).toBe("flaky");
    expect(overridden.topProbability).toBe(0.1);
    expect(overridden.probabilities).toEqual(verdict.probabilities);
    expect(overridden.deterministic).toEqual({ reason: "same run rerun passed" });
  });
});

describe("flow 307 AC2: signal lines placed above the log excerpt, questions rewritten to reference them", () => {
  test("buildCiTriageState places a labelled signals block above the log excerpt, redacted", () => {
    const planted = "sk-ant-api03-PLANTED-SECRET-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";
    const state = buildCiTriageState({
      testName: "src/x.test.ts:1",
      jobName: "typecheck-and-tests",
      rawLog: "boom",
      signalLines: [`rerun: 1 prior attempt(s) checked; contains ${planted}`, "history: 0 other failures"],
    });
    const lines = state.split("\n");
    expect(lines[0]).toBe("job: typecheck-and-tests");
    expect(lines[1]).toBe("failing test: src/x.test.ts:1");
    expect(state).toContain("signals (computed deterministically, before asking you):");
    expect(state.indexOf("signals (computed")).toBeLessThan(state.indexOf("log excerpt (tail"));
    expect(state).not.toContain(planted);
  });

  test("buildCiTriageState with no signalLines is byte-identical to the flow 306 shape", () => {
    const withoutSignals = buildCiTriageState({ testName: "t", jobName: "job", rawLog: "boom" });
    const withEmptySignals = buildCiTriageState({ testName: "t", jobName: "job", rawLog: "boom", signalLines: [] });
    expect(withoutSignals).not.toContain("signals (computed");
    expect(withEmptySignals).toBe(withoutSignals);
  });

  test("buildCiTriageQuestions(true) rewrites instructions to reference the signals block explicitly", () => {
    const withSignals = buildCiTriageQuestions(true);
    const withoutSignals = buildCiTriageQuestions();
    for (const criterion of CI_TRIAGE_CRITERIA) {
      expect(withSignals[criterion].instructions).toContain("signals block");
      expect(withoutSignals[criterion].instructions).not.toContain("signals block");
    }
  });
});

describe("flow 307 AC3/AC4/AC8: renderCiTriageAdvisory prints evidence lines and a deterministic marker", () => {
  test("signalLines are printed as evidence bullets", () => {
    const verdict = computeCiTriageVerdict({ flaky: { noul: 0.6 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.3 } });
    const text = renderCiTriageAdvisory({
      runId: "42",
      jobName: "typecheck-and-tests",
      verdict,
      signalLines: ["rerun: 0 prior attempt(s) checked; no earlier attempt of this job passed.", "log markers: none detected."],
    });
    expect(text).toContain("evidence (computed signals, before Jev):");
    expect(text).toContain("  - rerun: 0 prior attempt(s) checked; no earlier attempt of this job passed.");
    expect(text).toContain("  - log markers: none detected.");
  });

  test("a deterministic verdict prints DETERMINISTIC above the probabilities, which are still shown in full", () => {
    const verdict = applyDeterministicOverride(computeCiTriageVerdict({ flaky: { noul: 0.2 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.7 } }), {
      deterministic: { verdict: "flaky", reason: "same run rerun passed" },
    } as unknown as Parameters<typeof applyDeterministicOverride>[1]);
    const text = renderCiTriageAdvisory({ runId: "1", jobName: "j", verdict });
    expect(text).toContain("DETERMINISTIC: same run rerun passed");
    expect(text).toContain("top: flaky");
    // The un-overridden probabilities are still all printed, beside the forced top.
    expect(text).toContain("real-regression: 70%");
    expect(text.indexOf("DETERMINISTIC")).toBeLessThan(text.indexOf("top: flaky"));
  });

  test("no signalLines/deterministic -> output is byte-identical to the flow 306 shape", () => {
    const verdict = computeCiTriageVerdict({ flaky: { noul: 0.6 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.3 } });
    const before = renderCiTriageAdvisory({ runId: "42", jobName: "typecheck-and-tests", testName: "src/x.test.ts:1", verdict });
    expect(before).not.toContain("evidence (computed signals");
    expect(before).not.toContain("DETERMINISTIC");
  });

  test("flow 307 review, minor: a planted secret in a signal line is redacted before printing", () => {
    const planted = "sk-ant-api03-PLANTED-SECRET-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";
    const verdict = computeCiTriageVerdict({ flaky: { noul: 0.6 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.3 } });
    const text = renderCiTriageAdvisory({
      runId: "42",
      jobName: "typecheck-and-tests",
      verdict,
      signalLines: [`same head: a later run of this exact commit passed, and job "job ${planted}" itself concluded success in it.`],
    });
    expect(text).not.toContain(planted);
    expect(text).toContain("[REDACTED:secret]");
  });

  test("post-merge review gap, item 1: a planted secret in verdict.deterministic.reason is redacted before printing", () => {
    const planted = "sk-ant-api03-PLANTED-SECRET-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789";
    const verdict = applyDeterministicOverride(computeCiTriageVerdict({ flaky: { noul: 0.2 }, infra: { noul: 0.1 }, "real-regression": { noul: 0.7 } }), {
      // `computeCiSignals`'s real `deterministic.reason` embeds `jobName` verbatim
      // (see the same-head/rerun builders) — this plants a secret in the same spot,
      // in the reason only (not the header's own `jobName`, which is a separate,
      // pre-existing surface this item does not touch).
      deterministic: { verdict: "flaky", reason: `job "j" passed on an earlier attempt of this same run — token ${planted}.` },
    } as unknown as Parameters<typeof applyDeterministicOverride>[1]);
    const text = renderCiTriageAdvisory({ runId: "9", jobName: "j", verdict });
    expect(text).not.toContain(planted);
    expect(text).toContain("[REDACTED:secret]");
    expect(text).toContain("DETERMINISTIC:");
  });
});
