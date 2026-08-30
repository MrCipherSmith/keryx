// `keryx job`, driven END TO END through the real CLI.
//
// # Why this suite builds nothing by hand
//
// The audit this module answers found 217 documented mechanisms and six that a
// production code path reaches. The job-documentation layer — `state.json`, the
// per-step status, the resumption promise in §0.0, the "Record:" lines — was the
// largest block of prose with no writer behind it, and `.metaproject/jobs/` has
// been an empty directory created by `src/gdskills/install.ts:42` and touched by
// nothing else.
//
// A suite over hand-built state cannot, in principle, notice a missing writer:
// it exercises the READER. This repository has been bitten by exactly that five
// times (see the header of `review-gate.e2e.test.ts`). So every test below runs
// `jobCommand([...])` with real argv in a real temporary directory, and asserts
// on what it PRINTED and what LANDED ON DISK. Break the writer and a named test
// here goes red.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { jobCommand } from "../commands/job";
import { skillsCommand } from "../commands/skills";
import { loadSchema } from "../gdskills/contracts";
import { writeJob } from "./store";
import type { JobState } from "./types";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

/** ANSI is stripped so an assertion is about the words, not about the colours. */
function output(): string {
  // eslint-disable-next-line no-control-regex
  return logs.join("\n").replace(/\u001b\[[0-9;]*m/g, "");
}

async function freshProject(): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-job-e2e-"));
  await mkdir(path.join(ROOT, ".metaproject", "jobs"), { recursive: true });
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return ROOT;
}

afterEach(async () => {
  console.log = realLog;
  console.error = realError;
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

async function readState(name: string): Promise<JobState> {
  return JSON.parse(
    await readFile(path.join(ROOT, ".metaproject", "jobs", name, "state.json"), "utf8"),
  ) as JobState;
}

/** Drive every step of a plan to a terminal status through the real CLI. */
async function closeAllSteps(name: string): Promise<void> {
  const state = await readState(name);
  for (const step of state.plan.steps) {
    await jobCommand([
      "step",
      name,
      step.id,
      "--status",
      step.conditional ? "skipped" : "completed",
      ...(step.conditional ? ["--reason", "not triggered"] : []),
    ]);
  }
}

describe("keryx job init", () => {
  test("writes a real package under .metaproject/jobs/", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "audit-fix"]);

    const entries = await readdir(path.join(ROOT, ".metaproject", "jobs", "audit-fix"));
    expect(entries.sort()).toEqual(["journal.md", "state.json"]);

    const state = await readState("audit-fix");
    expect(state.job_name).toBe("audit-fix");
    expect(state.intent).toBe("implement");
    expect(state.phase).toBe("PLAN");
    expect(state.plan.steps.length).toBeGreaterThan(0);
    expect(state.plan.steps.every((step) => step.status === "pending")).toBe(true);
    expect(output()).toContain("audit-fix");
  });

  test("the state file validates against the REGISTERED contract schema", async () => {
    // Requirement 2, end to end: `keryx skills contracts validate` could not
    // load this schema at all before it was added to `CONTRACTS`, so the state
    // file's conformance was unassertable.
    await freshProject();
    await jobCommand(["init", "--name", "contract-check", "--intent", "review"]);

    logs = [];
    await skillsCommand([
      "contracts",
      "validate",
      path.join(ROOT, ".metaproject", "jobs", "contract-check", "state.json"),
      "--schema",
      "job-orchestrator-state",
    ]);
    expect(output()).toContain("valid:");
    expect(output()).toContain("schema: job-orchestrator-state");
    expect(process.exitCode ?? 0).toBe(0);
  });

  test("the registered schema is the one the skill ships", async () => {
    const schema = (await loadSchema("job-orchestrator-state")) as unknown as {
      $id?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.$id).toContain("job-orchestrator/state.schema.json");
    expect(Object.keys(schema.properties ?? {})).toContain("metrics");
  });

  test("each intent builds its own plan", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "as-implement", "--intent", "implement"]);
    await jobCommand(["init", "--name", "as-analyze", "--intent", "analyze"]);
    await jobCommand(["init", "--name", "as-review", "--intent", "review"]);

    const implement = (await readState("as-implement")).plan.steps.map((step) => step.id);
    const analyze = (await readState("as-analyze")).plan.steps.map((step) => step.id);
    const review = (await readState("as-review")).plan.steps.map((step) => step.id);

    expect(implement).toContain("tests-creator");
    expect(analyze).toEqual(["analyze", "context", "report", "proposal"]);
    expect(review).toEqual(["context", "review", "report"]);
  });

  test("refuses a --name that fails the schema pattern, and writes nothing", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "Audit_Fix"]);

    expect(output()).toContain('Invalid --name "Audit_Fix"');
    expect(output()).toContain("^[a-z0-9-]+$");
    expect(process.exitCode).toBe(1);
    expect(await readdir(path.join(ROOT, ".metaproject", "jobs"))).toEqual([]);
  });

  test("refuses an unknown --intent and names the valid values", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "ok-name", "--intent", "refactor"]);

    expect(output()).toContain('Invalid --intent "refactor"');
    expect(output()).toContain("implement, analyze, review, custom");
    expect(process.exitCode).toBe(1);
  });

  test("refuses to overwrite an existing package", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "twice"]);
    logs = [];
    await jobCommand(["init", "--name", "twice"]);
    expect(output()).toContain("already exists");
    expect(process.exitCode).toBe(1);
  });
});

describe("keryx job status — resumption", () => {
  test("names the first non-terminal step, so a resuming agent acts on a fact", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "resume-me", "--intent", "review"]);
    await jobCommand(["step", "resume-me", "context", "--status", "completed"]);

    logs = [];
    await jobCommand(["status", "resume-me", "--json"]);
    const report = JSON.parse(output()) as {
      next_step: { id: string; agent: string; status: string } | null;
      open: string[];
      steps_done: number;
      steps_total: number;
    };
    expect(report.next_step).toEqual({ id: "review", agent: "reviewers", status: "pending" });
    expect(report.open).toEqual(["review", "report"]);
    expect(report.steps_done).toBe(1);
    expect(report.steps_total).toBe(3);
  });

  test("a skipped step is terminal and is not offered for resumption", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "skip-me", "--intent", "review"]);
    await jobCommand(["step", "skip-me", "context", "--status", "skipped", "--reason", "cached"]);

    logs = [];
    await jobCommand(["status", "skip-me", "--json"]);
    expect((JSON.parse(output()) as { next_step: { id: string } }).next_step.id).toBe("review");
  });

  test("a FAILED step is not terminal — it is still the next thing to do", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "failed-step", "--intent", "review"]);
    await jobCommand(["step", "failed-step", "context", "--status", "failed", "--reason", "boom"]);

    logs = [];
    await jobCommand(["status", "failed-step", "--json"]);
    const report = JSON.parse(output()) as {
      next_step: { id: string };
      failed: string[];
    };
    expect(report.next_step.id).toBe("context");
    expect(report.failed).toEqual(["context"]);
  });

  test("current_step on disk tracks the next open step", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "cursor", "--intent", "review"]);
    expect((await readState("cursor")).plan.current_step).toBe("context");
    await jobCommand(["step", "cursor", "context", "--status", "completed"]);
    expect((await readState("cursor")).plan.current_step).toBe("review");
  });

  test("refuses an unknown job name and offers the listing", async () => {
    await freshProject();
    await jobCommand(["status", "nope"]);
    expect(output()).toContain("Job not found: nope");
    expect(process.exitCode).toBe(1);
  });
});

describe("keryx job step — the retry counter", () => {
  test("a first attempt records retries 0 and a re-attempt increments it ON DISK", async () => {
    // `metrics.steps[].retries` has been declared in the schema since the skill
    // was written and never written by anything — the identical defect
    // `attempts.count` had in flow before `src/flow/service.ts:315`.
    await freshProject();
    await jobCommand(["init", "--name", "retry-job", "--intent", "review"]);

    await jobCommand(["step", "retry-job", "review", "--status", "in-progress"]);
    let metrics = (await readState("retry-job")).metrics?.steps ?? [];
    expect(metrics.find((entry) => entry.step_id === "review")?.retries).toBe(0);

    await jobCommand(["step", "retry-job", "review", "--status", "failed"]);
    await jobCommand(["step", "retry-job", "review", "--status", "in-progress"]);
    metrics = (await readState("retry-job")).metrics?.steps ?? [];
    expect(metrics.find((entry) => entry.step_id === "review")?.retries).toBe(1);

    await jobCommand(["step", "retry-job", "review", "--status", "completed"]);
    await jobCommand(["step", "retry-job", "review", "--status", "in-progress"]);
    metrics = (await readState("retry-job")).metrics?.steps ?? [];
    expect(metrics.find((entry) => entry.step_id === "review")?.retries).toBe(2);
  });

  test("the retry count is reported by status and printed by step", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "retry-report", "--intent", "review"]);
    await jobCommand(["step", "retry-report", "context", "--status", "in-progress"]);
    await jobCommand(["step", "retry-report", "context", "--status", "in-progress"]);
    expect(output()).toContain("retries 1");

    logs = [];
    await jobCommand(["status", "retry-report", "--json"]);
    expect((JSON.parse(output()) as { retries: Record<string, number> }).retries.context).toBe(1);
  });

  test("a step that was never attempted has no retry count", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "untouched", "--intent", "review"]);
    logs = [];
    await jobCommand(["status", "untouched", "--json"]);
    expect((JSON.parse(output()) as { retries: Record<string, number> }).retries).toEqual({});
  });

  test("refuses an unknown step id and lists the plan's steps", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "unknown-step", "--intent", "review"]);
    logs = [];
    await jobCommand(["step", "unknown-step", "reveiw", "--status", "completed"]);

    expect(output()).toContain('Unknown step "reveiw"');
    expect(output()).toContain("Known steps: context, review, report");
    expect(process.exitCode).toBe(1);
  });

  test("refuses a --status outside the enum and names the valid values", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "bad-status", "--intent", "review"]);
    logs = [];
    await jobCommand(["step", "bad-status", "context", "--status", "in_progress"]);

    expect(output()).toContain('Invalid --status "in_progress"');
    expect(output()).toContain("pending, in-progress, completed, skipped, failed");
    expect(process.exitCode).toBe(1);
    expect((await readState("bad-status")).plan.steps[0]?.status).toBe("pending");
  });

  test("refuses a transition the machine does not allow", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "bad-move", "--intent", "review"]);
    await jobCommand(["step", "bad-move", "context", "--status", "completed"]);
    logs = [];
    await jobCommand(["step", "bad-move", "context", "--status", "pending"]);

    expect(output()).toContain('Invalid --status for step "context": completed -> pending');
    expect(output()).toContain("Allowed from completed: in-progress");
    expect(process.exitCode).toBe(1);
  });

  test("stepping moves the package from PLAN into EXECUTION", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "phase-move", "--intent", "review"]);
    expect((await readState("phase-move")).phase).toBe("PLAN");
    await jobCommand(["step", "phase-move", "context", "--status", "in-progress"]);
    expect((await readState("phase-move")).phase).toBe("EXECUTION");
  });

  test("every step writes an append-only journal line", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "journalled", "--intent", "review"]);
    await jobCommand(["step", "journalled", "context", "--status", "skipped", "--reason", "cached"]);

    const journal = await readFile(
      path.join(ROOT, ".metaproject", "jobs", "journalled", "journal.md"),
      "utf8",
    );
    expect(journal).toContain("step: context skipped");
    expect(journal).toContain("cached");
  });
});

describe("keryx job document", () => {
  test("copies the file into the package and records it in state.json", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "documented", "--intent", "review"]);
    await writeFile(path.join(ROOT, "notes.md"), "# findings\n", "utf8");

    logs = [];
    await jobCommand(["document", "documented", "--type", "review", "--file", "notes.md"]);

    const copied = await readFile(
      path.join(ROOT, ".metaproject", "jobs", "documented", "review.md"),
      "utf8",
    );
    expect(copied).toBe("# findings\n");
    expect((await readState("documented")).documentation?.documents_created).toEqual(["review.md"]);
    expect(output()).toContain("review.md");
  });

  test("preserves the source extension so a JSON report stays JSON", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "json-doc", "--intent", "review"]);
    await writeFile(path.join(ROOT, "verify.json"), '{"ok":true}\n', "utf8");
    await jobCommand([
      "document",
      "json-doc",
      "--type",
      "verification-report",
      "--file",
      "verify.json",
    ]);
    expect((await readState("json-doc")).documentation?.documents_created).toEqual([
      "verification-report.json",
    ]);
  });

  test("re-recording a document replaces it and leaves one entry", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "rerecord", "--intent", "review"]);
    await writeFile(path.join(ROOT, "a.md"), "first\n", "utf8");
    await jobCommand(["document", "rerecord", "--type", "analysis", "--file", "a.md"]);
    await writeFile(path.join(ROOT, "a.md"), "second\n", "utf8");
    await jobCommand(["document", "rerecord", "--type", "analysis", "--file", "a.md"]);

    expect((await readState("rerecord")).documentation?.documents_created).toEqual(["analysis.md"]);
    expect(
      await readFile(path.join(ROOT, ".metaproject", "jobs", "rerecord", "analysis.md"), "utf8"),
    ).toBe("second\n");
  });

  test("refuses a --file that does not exist", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "missing-file", "--intent", "review"]);
    logs = [];
    await jobCommand(["document", "missing-file", "--type", "review", "--file", "nope.md"]);

    expect(output()).toContain("--file not found: nope.md");
    expect(process.exitCode).toBe(1);
    expect((await readState("missing-file")).documentation?.documents_created).toEqual([]);
  });

  test("refuses an unknown --type and names the valid values", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "bad-type", "--intent", "review"]);
    await writeFile(path.join(ROOT, "x.md"), "x\n", "utf8");
    logs = [];
    await jobCommand(["document", "bad-type", "--type", "postmortem", "--file", "x.md"]);

    expect(output()).toContain('Invalid --type "postmortem"');
    expect(output()).toContain("analysis, implementation-report, review, verification-report");
    expect(process.exitCode).toBe(1);
  });
});

describe("keryx job complete", () => {
  test("refuses while any step is non-terminal, and names them", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "still-open", "--intent", "review"]);
    await jobCommand(["step", "still-open", "context", "--status", "completed"]);
    logs = [];
    await jobCommand(["complete", "still-open"]);

    expect(output()).toContain("Cannot complete job still-open");
    expect(output()).toContain("not terminal: review, report");
    expect(process.exitCode).toBe(1);
    expect((await readState("still-open")).phase).toBe("EXECUTION");
  });

  test("refuses while a step is failed", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "has-failure", "--intent", "review"]);
    await jobCommand(["step", "has-failure", "context", "--status", "completed"]);
    await jobCommand(["step", "has-failure", "review", "--status", "failed"]);
    await jobCommand(["step", "has-failure", "report", "--status", "completed"]);
    logs = [];
    await jobCommand(["complete", "has-failure"]);

    expect(output()).toContain("failed: review");
    expect(process.exitCode).toBe(1);
  });

  test("moves the package to COMPLETION once every step is terminal", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "finished", "--intent", "implement"]);
    await closeAllSteps("finished");
    logs = [];
    await jobCommand(["complete", "finished"]);

    expect(process.exitCode ?? 0).toBe(0);
    const state = await readState("finished");
    expect(state.phase).toBe("COMPLETION");
    expect(state.plan.current_step).toBeUndefined();
  });

  test("a completed package still validates against the contract schema", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "valid-at-end", "--intent", "implement"]);
    await closeAllSteps("valid-at-end");
    await jobCommand(["complete", "valid-at-end"]);

    logs = [];
    await skillsCommand([
      "contracts",
      "validate",
      path.join(ROOT, ".metaproject", "jobs", "valid-at-end", "state.json"),
      "--schema",
      "job-orchestrator-state",
    ]);
    expect(output()).toContain("valid:");
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe("state.json schema guard", () => {
  // Every path above produces a conforming state, so the guard in `writeJob` is
  // invisible to them — remove it and nothing goes red. These two ask it
  // directly, with the shapes the audit found asserted in prose and forbidden by
  // the schema's `additionalProperties: false`. They are the reason those five
  // fields and the `paused` status were NOT added to the schema: the six
  // commands never produce them, and widening a schema for a writer that does
  // not exist is the defect being closed, not the fix.
  test("refuses a state carrying a property the schema forbids", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "guarded", "--intent", "review"]);
    const state = (await readState("guarded")) as JobState & { sanity_check?: unknown };
    state.sanity_check = { commits: 1 };

    await expect(writeJob(ROOT, "guarded", state)).rejects.toThrow(
      /does not validate against job-orchestrator-state[\s\S]*sanity_check/,
    );
  });

  test("refuses a phase outside the schema enum, such as the documented `paused`", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "paused-job", "--intent", "review"]);
    const state = await readState("paused-job");
    state.phase = "paused" as JobState["phase"];

    await expect(writeJob(ROOT, "paused-job", state)).rejects.toThrow(
      /does not validate against job-orchestrator-state[\s\S]*phase/,
    );
  });
});

describe("keryx job list", () => {
  test("reports every package with its phase and next open step", async () => {
    await freshProject();
    await jobCommand(["init", "--name", "one", "--intent", "review"]);
    await jobCommand(["init", "--name", "two", "--intent", "analyze"]);
    await jobCommand(["step", "one", "context", "--status", "completed"]);

    logs = [];
    await jobCommand(["list", "--json"]);
    const jobs = JSON.parse(output()) as Array<{
      name: string;
      phase: string;
      nextStep: string | null;
      stepsDone: number;
    }>;
    expect(jobs.map((job) => job.name)).toEqual(["one", "two"]);
    expect(jobs[0]).toMatchObject({ phase: "EXECUTION", nextStep: "review", stepsDone: 1 });
    expect(jobs[1]).toMatchObject({ phase: "PLAN", nextStep: "analyze", stepsDone: 0 });
  });

  test("says so when there are no packages", async () => {
    await freshProject();
    await jobCommand(["list"]);
    expect(output()).toContain("No jobs yet");
  });
});
