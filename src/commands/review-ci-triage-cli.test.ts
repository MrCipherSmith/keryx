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

describe("AC8/AC3: keryx review ci-triage --run <id> prints the triage for a failed run", () => {
  test("--json prints an array (one verdict per failed job — here, one), with job/test/verdict/usage", async () => {
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
    }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.runId).toBe("36095133327");
    expect(parsed[0]?.job).toBe("typecheck-and-tests");
    expect(parsed[0]?.testName).toContain("e2e.test.ts:115");
    expect(parsed[0]?.verdict.top).toBe("flaky");
    expect(parsed[0]?.verdict.probabilities.flaky).toBe(0.74);
    expect(parsed[0]?.usage.input_tokens).toBe(612);
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
    const parsed = JSON.parse(output()) as { job: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.job).toBe("typecheck-and-tests");
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

describe("flow 307 AC5/AC6: keryx review ci-triage --eval <file> — the labelled evaluation set", () => {
  const EVAL_MANIFEST = path.join(import.meta.dir, "fixtures", "ci-triage-eval", "manifest.json");

  test("offline (no --live) needs no opt-in gate — every case replays from its own fixtures", async () => {
    // callJevSystemOne itself still requires SOME credential string to be
    // present before it will build a request at all (flow 306's own AC2),
    // even though nothing here is ever sent anywhere — the canned
    // `jev-response.json` answers every call. Same precedent `--run
    // --fixtures` already sets in the describe block above.
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["ci-triage", "--eval", EVAL_MANIFEST, "--json"]);
    expect(process.exitCode ?? 0).toBe(0);
    const parsed = JSON.parse(output()) as {
      live: boolean;
      cases: number;
      before: { accuracy: number; costUsd: number };
      after: { accuracy: number; costUsd: number };
      results: readonly { id: string; truth: string; predictedBefore: string; predictedAfter: string }[];
    };
    expect(parsed.live).toBe(false);
    expect(parsed.cases).toBe(8);
    expect(parsed.results).toHaveLength(8);
    for (const key of ["before", "after"] as const) {
      expect(parsed[key].accuracy).toBeGreaterThanOrEqual(0);
      expect(parsed[key].accuracy).toBeLessThanOrEqual(1);
    }
    for (const r of parsed.results) {
      expect(["flaky", "infra", "real-regression"]).toContain(r.truth);
      expect(["flaky", "infra", "real-regression"]).toContain(r.predictedBefore);
      expect(["flaky", "infra", "real-regression"]).toContain(r.predictedAfter);
    }
    // AC5: at least the five 2026-09-25 cases the operator named are present, by id.
    const ids = parsed.results.map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "c1-35867790817-deepseek",
        "c2a-35841246003-schedules-flaky",
        "c2b-35841246003-sandbox-net-forward",
        "c3-35861001135-core-gate",
        "c4-35856434575-schedules-flaky",
        "c5-35885829526-provider-retry-timeout",
      ]),
    );
  });

  test("the non-JSON report prints before/after accuracy and a per-case line naming truth and both predictions", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["ci-triage", "--eval", EVAL_MANIFEST]);
    expect(output()).toContain("before (flow 306, log only):");
    expect(output()).toContain("after  (flow 307, log + signals):");
    expect(output()).toContain("c7-35897000167-macos-infra: truth=infra");
  });

  test("a manifest with no fixturesDir on any case, replayed offline, is refused rather than guessing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ci-eval-bad-"));
    const manifestPath = path.join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ cases: [{ id: "x", runId: "1", job: "j", truth: "flaky" }] }), "utf8");
    await reviewCommand(["ci-triage", "--eval", manifestPath]);
    expect(output()).toContain("fixturesDir");
    expect(process.exitCode).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  test("--run and --eval are both accepted flags, but --eval takes priority", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    // --run is simply not consulted once --eval is present — this only proves
    // the command does not crash trying to treat --run as a case id.
    await reviewCommand(["ci-triage", "--run", "not-a-real-run", "--eval", EVAL_MANIFEST, "--json"]);
    const parsed = JSON.parse(output()) as { cases: number };
    expect(parsed.cases).toBe(8);
  });
});

describe("flow 307 AC7: a rejected credential names its source, at the CLI's own pre-flight message", () => {
  test("no credential at all: the pre-flight message names both possible sources", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["ci-triage", "--run", "1", "--fixtures", path.join(ROOT, "does-not-exist")]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(output()).toContain("openrouterKey");
    expect(process.exitCode).toBe(1);
  });
});
