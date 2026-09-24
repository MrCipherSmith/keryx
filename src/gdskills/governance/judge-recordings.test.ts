// Flow 316, T6 — `judge-recordings.ts`. Every test points `recordingsDir` at
// a throwaway temp directory (never `JUDGE_RECORDINGS_DIR`, the real
// committed one) so nothing here writes to the repo tree.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { JudgeRequest } from "./judge";
import { judgeRequestDigest } from "./judge";
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
          entries: [{ scenarioId: "s1", kind: "known-right", requestDigest: "abc", verdict: "maybe", reason: "" }],
        }),
      );
      expect(() => readJudgeRecording("go/go-build-fix", dir)).toThrow(JudgeRecordingFormatError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeJudgeRecording / readJudgeRecording round-trip", () => {
  test("writes stable, indented, newline-terminated JSON that reads back identically", () => {
    const dir = tempDir();
    try {
      const file: JudgeRecordingFile = {
        judgePromptVersion: "2026-09-24.1",
        judge: "deepseek",
        judgeModel: "deepseek-chat",
        recordedAt: "2026-09-24T00:00:00.000Z",
        entries: [
          { scenarioId: "s1", kind: "known-right", requestDigest: judgeRequestDigest(REQUEST), verdict: "pass", reason: "meets criteria" },
          { scenarioId: "s1", kind: "known-wrong", requestDigest: "deadbeef", verdict: "fail", reason: "force-deletes" },
        ],
      };
      writeJudgeRecording("go/go-build-fix", file, dir);

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

  test("creates the recordings directory if it does not exist yet", () => {
    const dir = path.join(tempDir(), "nested", "deeper");
    try {
      writeJudgeRecording("go/go-build-fix", {
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

describe("recordedJudge", () => {
  test("replays a recorded verdict for a matching digest, with no network call", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [{ scenarioId: "s1", kind: "known-right", requestDigest: digest, verdict: "pass", reason: "meets criteria" }],
    });
    const verdict = await judge(REQUEST);
    expect(verdict).toEqual({ verdict: "pass", reason: "meets criteria" });
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

  test("a stale recording (rubric edited since recording) misses by digest and is refused, not silently reused", async () => {
    const digest = judgeRequestDigest(REQUEST);
    const judge = recordedJudge({
      judgePromptVersion: "v1",
      judge: "deepseek",
      judgeModel: "deepseek-chat",
      recordedAt: "2026-09-24T00:00:00.000Z",
      entries: [{ scenarioId: "s1", kind: "known-right", requestDigest: digest, verdict: "pass", reason: "meets criteria" }],
    });
    const editedRequest: JudgeRequest = {
      ...REQUEST,
      expectation: { ...REQUEST.expectation, rubric: "A DIFFERENT rubric text." },
    };
    await expect(judge(editedRequest)).rejects.toThrow(/no recorded judge verdict/);
  });
});
