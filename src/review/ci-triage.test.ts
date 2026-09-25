// Flow 306: the core CI-triage logic — question building, state bounding and
// redaction, verdict computation, advisory rendering, and the opt-in gate.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCiTriageQuestions,
  buildCiTriageState,
  CI_TRIAGE_CRITERIA,
  CI_TRIAGE_LOG_CHARS,
  computeCiTriageVerdict,
  extractFailingTestName,
  readCiTriageEnabled,
  renderCiTriageAdvisory,
} from "./ci-triage";

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
