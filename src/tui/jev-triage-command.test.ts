// flow 340: render + gate tests for `/triage`. Hermetic — every scenario
// either refuses before any network call or finds no review package on disk
// (no items to score -> no Jev call), so nothing here opens a socket.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isJevTriageCommand, JEV_TRIAGE_COMMAND, renderJevTriageForShell, resolveLatestReviewPackage, runJevTriageForShell } from "./jev-triage-command";
import type { JevTriageComputedResult } from "../commands/review-jev-triage";

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
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jevtriage-shell-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { triage: enabled } } }), "utf8");
  return dir;
}

describe("isJevTriageCommand", () => {
  test("matches only the exact token", () => {
    expect(isJevTriageCommand(JEV_TRIAGE_COMMAND)).toBe(true);
    expect(isJevTriageCommand("/triage")).toBe(true);
    expect(isJevTriageCommand("/triagex")).toBe(false);
    expect(isJevTriageCommand("triage")).toBe(false);
  });
});

function baseResult(overrides: Partial<JevTriageComputedResult> = {}): JevTriageComputedResult {
  return {
    status: "DONE",
    reviewer: "review-jev-triage",
    summary: "Triaged 0 blocker/major finding(s) (of 0 total, 0 dropped on parse) and 0 candidate duplicate pair(s). 0 severity flag(s) below threshold 0.4. 0 item(s) skipped by --max-calls 30.",
    annotations: { severity_check: [], merge_candidates: [], verify_order: [] },
    budget: { maxItems: 30, itemsScored: 0, itemsSkipped: 0, findingsDropped: 0 },
    tokens: { jevCalls: 0 },
    ...overrides,
  };
}

describe("renderJevTriageForShell", () => {
  test("English, mentions all three tracks", () => {
    const text = renderJevTriageForShell(
      baseResult({
        status: "DONE_WITH_CONCERNS",
        annotations: {
          severity_check: [{ id: "F-1", p: 0.2, flagged: true }],
          merge_candidates: [],
          verify_order: [{ id: "F-1", p: 0.2 }],
        },
      }),
    );
    expect(text).toContain("review-jev-triage");
    expect(text).toContain("DONE_WITH_CONCERNS");
    expect(text).toContain("FLAGGED");
    expect(text).not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe("resolveLatestReviewPackage", () => {
  test("no .metaproject/flows directory: undefined, not a throw", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jevtriage-nopkg-"));
    expect(await resolveLatestReviewPackage(ROOT)).toBeUndefined();
  });

  test("picks the review package with the newest findings.json mtime", async () => {
    ROOT = await mkdtemp(path.join(tmpdir(), "keryx-jevtriage-pkgs-"));
    const older = path.join(ROOT, ".metaproject", "flows", "100-old", "reviews", "100-r01");
    const newer = path.join(ROOT, ".metaproject", "flows", "200-new", "reviews", "200-r01");
    await mkdir(older, { recursive: true });
    await mkdir(newer, { recursive: true });
    await writeFile(path.join(older, "findings.json"), "[]", "utf8");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(path.join(newer, "findings.json"), "[]", "utf8");

    expect(await resolveLatestReviewPackage(ROOT)).toBe(newer);
  });
});

describe("runJevTriageForShell — gate refusal (no network, no filesystem scan beyond the gate)", () => {
  test("review.jev.triage absent: the refusal message", async () => {
    ROOT = await projectRoot(false);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runJevTriageForShell(ROOT);
    expect(text.toLowerCase()).toContain("review.jev.triage");
    expect(text.toLowerCase()).toContain("not enabled");
  });

  test("enabled but no credential: the refusal names OPENROUTER_API_KEY", async () => {
    ROOT = await projectRoot(true);
    delete process.env.OPENROUTER_API_KEY;
    const text = await runJevTriageForShell(ROOT);
    expect(text).toContain("OPENROUTER_API_KEY");
  });
});

describe("runJevTriageForShell — opted in, credentialed, but no review package yet", () => {
  test("an honest 'no review package' message, never a throw", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const text = await runJevTriageForShell(ROOT);
    expect(text).toContain("no review package found");
  });
});

describe("runJevTriageForShell — opted in, credentialed, an empty package: DONE, no network call needed", () => {
  test("zero findings -> zero items -> zero Jev calls", async () => {
    ROOT = await projectRoot(true);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const pkgDir = path.join(ROOT, ".metaproject", "flows", "1-x", "reviews", "1-r01");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, "findings.json"), "[]", "utf8");

    const text = await runJevTriageForShell(ROOT);
    expect(text).toContain("review-jev-triage");
    expect(text).toContain("DONE");
  });
});
