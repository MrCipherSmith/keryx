// Flow 306 — `keryx review ci-triage`, driven through the real CLI (AC8, AC9,
// AC10). Fixtures under `fixtures/ci-triage/` are built from a real failed run
// on this repository (run id, workflow, branch, head sha and failing-test path
// all read live via `gh run view`/`gh run list` on 2026-09-25); the log
// EXCERPT text is authored to be representative rather than a byte copy — this
// sandbox could not download the raw `--log-failed` blob (log downloads were
// unreachable), so only the metadata is a verbatim capture. No secret appears
// anywhere in these fixtures.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures", "ci-triage");
const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-triage-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(dir, ".metaproject", "tasks.config.json"),
    JSON.stringify({ review: { jev: { ci_triage: enabled } } }),
    "utf8",
  );
  return dir;
}

beforeEach(() => {
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
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

describe("AC8: keryx review ci-triage --run <id> prints the triage for a failed run", () => {
  test("--json prints the verdict, top pick, job and test name, from fixtures alone", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["ci-triage", "--run", "36095133327", "--fixtures", FIXTURES_DIR, "--json"]);

    const parsed = JSON.parse(output()) as {
      runId: string;
      job: string;
      testName: string;
      verdict: { top: string; topProbability: number; probabilities: Record<string, number> };
      usage: { input_tokens?: number };
    };
    expect(parsed.runId).toBe("36095133327");
    expect(parsed.job).toBe("typecheck-and-tests");
    expect(parsed.testName).toContain("e2e.test.ts:115");
    expect(parsed.verdict.top).toBe("flaky");
    expect(parsed.verdict.probabilities.flaky).toBe(0.74);
    expect(parsed.usage.input_tokens).toBe(612);
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("without --json, prints human-readable advisory text labelled advisory", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["ci-triage", "--run", "36095133327", "--fixtures", FIXTURES_DIR]);

    expect(output()).toContain("ADVISORY ONLY");
    expect(output()).toContain("top: flaky");
  });

  test("--job selects a specific job by name", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["ci-triage", "--run", "36095133327", "--job", "typecheck-and-tests", "--fixtures", FIXTURES_DIR, "--json"]);
    const parsed = JSON.parse(output()) as { job: string };
    expect(parsed.job).toBe("typecheck-and-tests");
  });

  test("a job name that does not exist on the run is refused, naming the jobs that do", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["ci-triage", "--run", "36095133327", "--job", "no-such-job", "--fixtures", FIXTURES_DIR]);
    expect(output()).toContain("no-such-job");
    expect(output()).toContain("typecheck-and-tests");
    expect(process.exitCode).toBe(1);
  });
});

describe("AC10: opt-in per project, and credential gating — both refuse before any read", () => {
  test("review.jev.ci_triage absent/false: refused, no fixture file is even opened", async () => {
    ROOT = await projectRoot(false);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    // A --fixtures dir that does not exist: if the command tried to read it
    // before checking the opt-in gate, this would throw an ENOENT instead of
    // printing the opt-in refusal.
    await reviewCommand(["ci-triage", "--run", "1", "--fixtures", path.join(ROOT, "does-not-exist")]);

    expect(output()).toContain("ci_triage");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY (and no saved openrouterKey): refused, no fixture file is even opened", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["ci-triage", "--run", "1", "--fixtures", path.join(ROOT, "does-not-exist")]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("AC9: no rerun/status-check/merge call exists in the output path", () => {
  test("the ADVISORY output never claims an action was taken, and unknown flags are refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["ci-triage", "--run", "36095133327", "--fixtures", FIXTURES_DIR]);
    expect(output()).not.toMatch(/rerun (started|triggered|queued)|status check (set|written)|merged/i);

    await reviewCommand(["ci-triage", "--run", "1", "--rerun"]);
    expect(output()).toContain("Unknown option");
  });
});
