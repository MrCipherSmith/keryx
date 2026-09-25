// Flow 316, T6 — `judge-recordings.ts`. Every test points `recordingsDir` at
// a throwaway temp directory (never `JUDGE_RECORDINGS_DIR`, the real
// committed one) so nothing here writes to the repo tree.

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ContainedWriteError } from "../../lib/contained-write";
import type { JudgeableScenario, JudgeRequest } from "./judge";
import { gradeScenarioAnswer, judgeRequestDigest } from "./judge";
import {
  JudgeRecordingFormatError,
  judgeRecordingPath,
  readJudgeRecording,
  recordedJudge,
  writeJudgeRecording,
  type JudgeRecordingFile,
} from "./judge-recordings";

function tempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "judge-recordings-"));
}

const REQUEST: JudgeRequest = {
  scenarioId: "s1",
  prompt: "Explain how to safely delete a git branch.",
  answer: "Run git branch -d feature-x; it refuses if there is unmerged work.",
  expectation: {
    grader: "judge",
    rubric: "A correct answer uses a safe delete.",
    pass_criteria: ["Uses git branch -d"],
  },
};

describe("judgeRecordingPath", () => {
  test("maps <pack>/<skill> to <dir>/<pack>__<skill>.json", () => {
    expect(judgeRecordingPath("go/go-build-fix", "/recordings")).toBe(path.join("/recordings", "go__go-build-fix.json"));
  });

  test("refuses an id that does not match pack/skill", () => {
    expect(() => judgeRecordingPath("not-an-id", "/recordings")).toThrow(/must match/);
    expect(() => judgeRecordingPath("Pack/Skill", "/recordings")).toThrow(/must match/);
    expect(() => judgeRecordingPath("pack/skill/extra", "/recordings")).toThrow(/must match/);
    expect(() => judgeRecordingPath("../../etc/passwd", "/recordings")).toThrow(/must match/);
  });
});

describe("readJudgeRecording", () => {
  test("returns undefined when no recording file exists yet", () => {
    const dir = tempDir();
    try {
      expect(readJudgeRecording("go/go-build-fix", dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws JudgeRecordingFormatError for malformed JSON", () => {
    const dir = tempDir();
    try {
      const filePath = judgeRecordingPath("go/go-build-fix", dir);
      writeFileSync(filePath, "{ not json");
      expect(() => readJudgeRecording("go/go-build-fix", dir)).toThrow(JudgeRecordingFormatError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws JudgeRecordingFormatError for a well-formed JSON object missing required fields", () => {
    const dir = tempDir();
    try {
      const filePath = judgeRecordingPath("go/go-build-fix", dir);
      writeFileSync(filePath, JSON.stringify({ judge: "deepseek" }));
      expect(() => readJudgeRecording("go/go-build-fix", dir)).toThrow(JudgeRecordingFormatError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws JudgeRecordingFormatError for an entry with a bad verdict", () => {
    const dir = tempDir();
    try {
      const filePath = judgeRecordingPath("go/go-build-fix", dir);
      writeFileSync(
        filePath,
        JSON.stringify({
          judgePromptVersion: "v1",
          judge: "deepseek",
          judgeModel: "deepseek-chat",
          recordedAt: "2026-09-24T00:00:00.000Z",
          entries: [
            { scenarioId: "s1", kind: "known-right", requestDigest: "abc", samples: [{ verdict: "maybe", reason: "" }] },
          ],
        }),
      );
      expect(() => readJudgeRecording("go/go-build-fix", dir)).toThrow(JudgeRecordingFormatError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("throws JudgeRecordingFormatError for an entry with an empty samples array", () => {
    const dir = tempDir();
    try {
      const filePath = judgeRecordingPath("go/go-build-fix", dir);
      writeFileSync(
        filePath,
        JSON.stringify({
          judgePromptVersion: "v1",
          judge: "deepseek",
          judgeModel: "deepseek-chat",
          recordedAt: "2026-09-24T00:00:00.000Z",
          entries: [{ scenarioId: "s1", kind: "known-right", requestDigest: "abc", samples: [] }],
        }),
      );
      expect(() => readJudgeRecording("go/go-build-fix", dir)).toThrow(JudgeRecordingFormatError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeJudgeRecording / readJudgeRecording round-trip", () => {
  test("writes stable, indented, newline-terminated JSON that reads back identically", async () => {
    const dir = tempDir();
    try {
      const file: JudgeRecordingFile = {
        judgePromptVersion: "2026-09-24.1",
        judge: "deepseek",
        judgeModel: "deepseek-chat",
        recordedAt: "2026-09-24T00:00:00.000Z",
        entries: [
          {
            scenarioId: "s1",
            kind: "known-right",
            requestDigest: judgeRequestDigest(REQUEST),
            samples: [
              { verdict: "pass", reason: "meets criteria" },
              { verdict: "pass", reason: "meets criteria, second call" },
            ],
          },
          {
            scenarioId: "s1",
            kind: "known-wrong",
            requestDigest: "deadbeef",
            samples: [{ verdict: "fail", reason: "force-deletes" }],
          },
        ],
      };
      await writeJudgeRecording("go/go-build-fix", file, dir);

      const filePath = judgeRecordingPath("go/go-build-fix", dir);
      const raw = readFileSync(filePath, "utf8");
      expect(raw.endsWith("\n")).toBe(true);
      expect(raw.startsWith("{\n  \"judgePromptVersion\"")).toBe(true);

      const readBack = readJudgeRecording("go/go-build-fix", dir);
      expect(readBack).toEqual(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("creates the recordings directory if it does not exist yet", async () => {
    const dir = path.join(tempDir(), "nested", "deeper");
    try {
      await writeJudgeRecording("go/go-build-fix", {
        judgePromptVersion: "v1",
        judge: "deepseek",
        judgeModel: "deepseek-chat",
        recordedAt: "2026-09-24T00:00:00.000Z",
        entries: [],
      }, dir);
      expect(readJudgeRecording("go/go-build-fix", dir)).not.toBeUndefined();
    } finally {
      rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });
});

describe("writeJudgeRecording refuses a symlinked recordings directory (flow 319 follow-up to R700-04)", () => {
  test("a recordingsDir that is itself a symlink pointing outside its parent is refused, and nothing is written outside", async () => {
    const parent = tempDir();
    const outside = tempDir();
    try {
      const recordingsDir = path.join(parent, "judge-recordings");
      symlinkSync(outside, recordingsDir);

      await expect(
        writeJudgeRecording(
          "go/go-build-fix",
          {
            judgePromptVersion: "v1",
            judge: "deepseek",
            judgeModel: "deepseek-chat",
            recordedAt: "2026-09-24T00:00:00.000Z",
            entries: [],
          },
          recordingsDir,
        ),
      ).rejects.toThrow(ContainedWriteError);

      expect(existsSync(path.join(outside, "go__go-build-fix.json"))).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("recordedJudge", () => {
  test("replays sample 0 by default for a matching digest, with no network call", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [
        {
          scenarioId: "s1",
          kind: "known-right",
          requestDigest: digest,
          samples: [
            { verdict: "pass", reason: "meets criteria" },
            { verdict: "fail", reason: "flipped on the second call" },
          ],
        },
      ],
    });
    const verdict = await judge(REQUEST);
    expect(verdict).toEqual({ verdict: "pass", reason: "meets criteria" });
  });

  test("replays a specific sampleIndex when passed", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge(
      {
        judgePromptVersion: "v1",
        judge: "deepseek",
        judgeModel: "deepseek-chat",
        recordedAt: "2026-09-24T00:00:00.000Z",
        entries: [
          {
            scenarioId: "s1",
            kind: "known-right",
            requestDigest: digest,
            samples: [
              { verdict: "pass", reason: "sample 0" },
              { verdict: "fail", reason: "sample 1" },
            ],
          },
        ],
      },
      1,
    );
    const verdict = await judge(REQUEST);
    expect(verdict).toEqual({ verdict: "fail", reason: "sample 1" });
  });

  test("a sample's error is carried onto the replayed verdict", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [
        {
          scenarioId: "s1",
          kind: "known-right",
          requestDigest: digest,
          samples: [{ verdict: "fail", reason: "judge returned an unparseable verdict", error: "judge reply was not valid JSON" }],
        },
      ],
    });
    const verdict = await judge(REQUEST);
    expect(verdict).toEqual({
      verdict: "fail",
      reason: "judge returned an unparseable verdict",
      error: "judge reply was not valid JSON",
    });
  });

  test("throws a named error for a request digest with no matching entry", async () => {
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [],
    });
    await expect(judge(REQUEST)).rejects.toThrow(/no recorded judge verdict for s1/);
    await expect(judge(REQUEST)).rejects.toThrow(/judge-check/);
  });

  test("throws a named error when sampleIndex is out of range for the matched entry", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge(
      {
        judgePromptVersion: "v1",
        judge: "deepseek",
        judgeModel: "deepseek-chat",
        recordedAt: "2026-09-24T00:00:00.000Z",
        entries: [{ scenarioId: "s1", kind: "known-right", requestDigest: digest, samples: [{ verdict: "pass", reason: "only sample" }] }],
      },
      2,
    );
    await expect(judge(REQUEST)).rejects.toThrow(/no recorded sample 2 for s1/);
  });

  test("an error-carrying sample never replays as a pass, even when recorded with verdict: \"pass\"", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const scenario: JudgeableScenario = {
      id: REQUEST.scenarioId,
      prompt: REQUEST.prompt,
      expected_behavior: [REQUEST.expectation],
    };
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [
        {
          scenarioId: "s1",
          kind: "known-right",
          requestDigest: digest,
          samples: [{ verdict: "pass", reason: "x", error: "unparseable" }],
        },
      ],
    });
    const grade = await gradeScenarioAnswer(REQUEST.answer, scenario, judge);
    expect(grade.passed).toBe(false);
    expect(grade.judge).toEqual({ verdict: "fail", reason: "x", error: "unparseable" });
  });

  test("a stale recording (rubric edited since recording) misses by digest and is refused, not silently reused", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [
        { scenarioId: "s1", kind: "known-right", requestDigest: digest, samples: [{ verdict: "pass", reason: "meets criteria" }] },
      ],
    });
    const editedRequest: JudgeRequest = {
      ...REQUEST,
      expectation: { ...REQUEST.expectation, rubric: "A DIFFERENT rubric text." },
    };
    await expect(judge(editedRequest)).rejects.toThrow(/no recorded judge verdict/);
  });
});
