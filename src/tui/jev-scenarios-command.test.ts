// flow 332 (AC6/AC8): render tests for `/scenarios` — English UI, the
// manual-check list plus findings. Hermetic: `runJevScenariosForShell` takes
// an injectable `gitDiff`, and every scenario here either refuses before any
// network call or produces an empty diff (no scenario sources exist in the
// temp project -> zero Jev calls), so nothing here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJevScenariosCommand, JEV_SCENARIOS_COMMAND, renderJevScenariosForShell, runJevScenariosForShell } from "./jev-scenarios-command";
import type { JevScenariosComputedResult } from "../commands/review-jev-scenarios";

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jevscenarios-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { scenarios: enabled } } }), "utf8");
  return dir;
}

describe("isJevScenariosCommand", () => {
  test("matches only the exact token", () => {
    expect(isJevScenariosCommand(JEV_SCENARIOS_COMMAND)).toBe(true);
    expect(isJevScenariosCommand("/scenarios")).toBe(true);
    expect(isJevScenariosCommand("/scenariosx")).toBe(false);
    expect(isJevScenariosCommand("scenarios")).toBe(false);
  });
});

function baseResult(overrides: Partial<JevScenariosComputedResult> = {}): JevScenariosComputedResult {
  return {
    status: "DONE",
    reviewer: "review-jev-scenarios",
    summary: "Checked 0 scenario(s) with a touched link (of 0 discovered, 0 with no touched link) against working diff; 0 scenario(s) likely affected at/above threshold 0.5, 0 finding(s) with no covering test. 0 scenario(s) skipped by --max-calls 150.",
    findings: [],
    stats: { blocker: 0, major: 0, minor: 0, info: 0 },
    checklist: [],
    tokens: { jevCalls: 0 },
    selection: { maxCalls: 150, scenariosChecked: 0, scenariosSkipped: 0, notApplicable: 0 },
    scenarioSources: [],
    ...overrides,
  };
}

describe("renderJevScenariosForShell", () => {
  test("English, checklist plus findings", () => {
    const result = baseResult({
      status: "DONE_WITH_CONCERNS",
      checklist: [{ id: "a", title: "Connect a model provider", kind: "wiki", probability: 0.9, touchedLinks: ["src/commands/providers.ts"] }],
      findings: [
        {
          id: "jev-scenarios-1",
          severity: "minor",
          file: "src/commands/providers.ts",
          line: null,
          quote: null,
          problem: "likely affected, no covering test",
          impact: "regress silently",
          suggested_fix: "add a test",
          evidence: "p=0.90",
          confidence: "high",
          reviewer: "review-jev-scenarios",
          dedupe_key: "a",
        },
      ],
      stats: { blocker: 0, major: 0, minor: 1, info: 0 },
    });
    const text = renderJevScenariosForShell(result);
    expect(text).toContain("review-jev-scenarios: DONE_WITH_CONCERNS");
    expect(text).toContain("[wiki] Connect a model provider (p=0.90)");
    expect(text).toContain("[minor] src/commands/providers.ts — likely affected, no covering test");
    // English only.
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test("no scenario at or above threshold: a plain, unambiguous English sentence", () => {
    expect(renderJevScenariosForShell(baseResult())).toContain("No scenario at or above threshold.");
  });
});

describe("runJevScenariosForShell — gate refusal (no network, no git diff)", () => {
  test("review.jev.scenarios absent: the refusal message, and git diff is never called", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gitDiffCalled = false;
    const text = await runJevScenariosForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text.toLowerCase()).toContain("review.jev.scenarios");
    expect(text.toLowerCase()).toContain("not enabled");
    expect(gitDiffCalled).toBe(false);
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY, git diff never called", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    let gitDiffCalled = false;
    const text = await runJevScenariosForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(gitDiffCalled).toBe(false);
  });
});

describe("runJevScenariosForShell — no scenario sources in the project makes zero Jev calls", () => {
  test("opted in, credentialed, nothing to discover: DONE, no findings, no network call needed", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runJevScenariosForShell(ROOT, async () => "");
    expect(text).toContain("review-jev-scenarios: DONE");
    expect(text).toContain("No scenario at or above threshold.");
  });
});
