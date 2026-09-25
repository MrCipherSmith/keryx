// flow 333 (AC6): render tests for `/staledocs`. Hermetic:
// `runStaledocsForShell` takes an injectable `gitDiff`, and every scenario
// here either refuses before any network call or produces an empty diff
// (zero hunks -> zero Jev calls), so nothing here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isStaledocsCommand, renderStaledocsForShell, runStaledocsForShell, STALEDOCS_COMMAND } from "./jev-docs-command";
import type { JevDocsComputedResult } from "../commands/review-jev-docs";

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-staledocs-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { docs: enabled } } }), "utf8");
  return dir;
}

function finding(overrides: Partial<JevDocsComputedResult["findings"][number]> = {}): JevDocsComputedResult["findings"][number] {
  return {
    id: "jev-docs-1",
    severity: "minor",
    file: "docs/a.md",
    line: 3,
    quote: "See src/a.ts",
    problem: "section is now stale",
    impact: "readers see outdated behaviour",
    suggested_fix: "update the section",
    evidence: "Jev noul probability: 0.90",
    confidence: "high",
    reviewer: "review-jev-docs",
    dedupe_key: "docs/a.md::3",
    ...overrides,
  };
}

describe("isStaledocsCommand", () => {
  test("matches only the exact token", () => {
    expect(isStaledocsCommand(STALEDOCS_COMMAND)).toBe(true);
    expect(isStaledocsCommand("/staledocs")).toBe(true);
    expect(isStaledocsCommand("/staledocsx")).toBe(false);
    expect(isStaledocsCommand("staledocs")).toBe(false);
  });
});

describe("renderStaledocsForShell", () => {
  test("English, with severity/location/problem/fix per finding", () => {
    const result: JevDocsComputedResult = {
      status: "DONE_WITH_CONCERNS",
      reviewer: "review-jev-docs",
      summary: "Checked 1 doc section(s) against working diff; 1 linked to changed code.",
      findings: [finding()],
      stats: { blocker: 0, major: 0, minor: 1, info: 0 },
      tokens: { jevCalls: 1 },
      selection: { maxCalls: 30, linkedSections: 1, selectedSections: 1, droppedSections: 0 },
    };
    const text = renderStaledocsForShell(result);
    expect(text).toContain("review-jev-docs: DONE_WITH_CONCERNS");
    expect(text).toContain("[minor] docs/a.md:3 — section is now stale");
    expect(text).toContain("fix: update the section");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });

  test("no findings: a plain, unambiguous English sentence", () => {
    const result: JevDocsComputedResult = {
      status: "DONE",
      reviewer: "review-jev-docs",
      summary: "Checked 0 doc section(s).",
      findings: [],
      stats: { blocker: 0, major: 0, minor: 0, info: 0 },
      tokens: { jevCalls: 0 },
      selection: { maxCalls: 30, linkedSections: 0, selectedSections: 0, droppedSections: 0 },
    };
    expect(renderStaledocsForShell(result)).toContain("No stale-doc candidates at or above threshold.");
  });
});

describe("runStaledocsForShell — gate refusal (no network, no git diff)", () => {
  test("review.jev.docs absent: the refusal message, and git diff is never called", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    let gitDiffCalled = false;
    const text = await runStaledocsForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text.toLowerCase()).toContain("review.jev.docs");
    expect(text.toLowerCase()).toContain("not enabled");
    expect(gitDiffCalled).toBe(false);
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY, git diff never called", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    let gitDiffCalled = false;
    const text = await runStaledocsForShell(ROOT, async () => {
      gitDiffCalled = true;
      return "";
    });
    expect(text).toContain("OPENROUTER_API_KEY");
    expect(gitDiffCalled).toBe(false);
  });
});

describe("runStaledocsForShell — an empty working diff makes zero Jev calls", () => {
  test("opted in, credentialed, nothing changed: DONE, no findings, no network call needed", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runStaledocsForShell(ROOT, async () => "");
    expect(text).toContain("review-jev-docs: DONE");
    expect(text).toContain("No stale-doc candidates at or above threshold.");
  });
});
