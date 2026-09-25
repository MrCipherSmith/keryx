// flow 333 (AC6): render tests for `/opencomments`. Hermetic: the gate
// (opt-in + credential) is checked BEFORE `runOpencommentsForShell` ever
// builds a live `gh`-backed port, so every scenario here either refuses
// before any network call or exercises the pure renderer directly — nothing
// here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOpencommentsCommand, OPENCOMMENTS_COMMAND, renderOpencommentsForShell, runOpencommentsForShell } from "./jev-comments-command";
import type { JevCommentsComputedResult } from "../commands/review-jev-comments";

const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
let ROOT = "";

afterEach(async () => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = ORIGINAL_KEY;
  }
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-opencomments-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { comments: enabled } } }), "utf8");
  return dir;
}

function finding(overrides: Partial<JevCommentsComputedResult["findings"][number]> = {}): JevCommentsComputedResult["findings"][number] {
  return {
    id: "jev-comments-1",
    severity: "minor",
    file: "src/a.ts",
    line: 12,
    quote: "please fix this",
    problem: "comment is still open",
    impact: "an unanswered comment reads as accepted",
    suggested_fix: "address it, then reply",
    evidence: "Jev choice: still-open",
    confidence: "high",
    reviewer: "review-jev-comments",
    dedupe_key: "c1",
    ...overrides,
  };
}

describe("isOpencommentsCommand", () => {
  test("matches only the exact token", () => {
    expect(isOpencommentsCommand(OPENCOMMENTS_COMMAND)).toBe(true);
    expect(isOpencommentsCommand("/opencomments")).toBe(true);
    expect(isOpencommentsCommand("/opencommentsx")).toBe(false);
    expect(isOpencommentsCommand("opencomments")).toBe(false);
  });
});

describe("renderOpencommentsForShell", () => {
  test("English, with severity/location/problem/fix per finding", () => {
    const result: JevCommentsComputedResult = {
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-jev-comments",
      summary: "Checked 1 open comment(s).",
      findings: [finding()],
      stats: { blocker: 0, major: 0, minor: 1, info: 0 },
      tokens: { jevCalls: 1 },
      openComments: 1,
    };
    const text = renderOpencommentsForShell(result);
    expect(text).toContain("review-jev-comments: DONE_WITH_CONCERNS");
    expect(text).toContain("[minor] src/a.ts:12 — comment is still open");
    expect(text).toContain("fix: address it, then reply");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test("no findings: a plain, unambiguous English sentence naming the open-comment count", () => {
    const result: JevCommentsComputedResult = {
      status: "DONE",
      reviewer: "review-jev-comments",
      summary: "Checked 3 open comment(s).",
      findings: [],
      stats: { blocker: 0, major: 0, minor: 0, info: 0 },
      tokens: { jevCalls: 1 },
      openComments: 3,
    };
    expect(renderOpencommentsForShell(result)).toContain("No still-open or escalation-worthy comments among 3 open comment(s).");
  });
});

describe("runOpencommentsForShell — gate refusal (no network)", () => {
  test("review.jev.comments absent: the refusal message, no live port is ever built", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runOpencommentsForShell(ROOT, "o/r", 1);
    expect(text.toLowerCase()).toContain("review.jev.comments");
    expect(text.toLowerCase()).toContain("not enabled");
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    const text = await runOpencommentsForShell(ROOT, "o/r", 1);
    expect(text).toContain("OPENROUTER_API_KEY");
  });
});
