// Flow 209, AC8 — loop detection, driven through the command an operator runs.
//
// # What shipped broken, and why it could never fire
//
// `9f425d9f` introduced the detector with eighteen passing tests. It could not
// fire on anything the pipeline writes, for two independent reasons:
//
//   1. **Identity was a RANKING, `global_id` first.** `assignGlobalIds` mints
//      `<reviewId>#<id>` on every finding before it is persisted, so the
//      top-ranked key differed between any two rounds BY CONSTRUCTION and the
//      content key that would have matched was never reached.
//   2. **Two rounds shared one directory.** `defaultReviewId` is date-keyed and
//      the documented invocation passes no `--review-id`, so a second round of
//      the same branch on the same day overwrote the first: one package,
//      `rounds_seen: 1`, nothing to compare.
//
// Both were fixed in `860535e3` — identity became a SET matched by intersection,
// and `allocatePackage` gave the second same-day round its own directory.
//
// # Why this file exists on top of that fix
//
// Eighteen tests agreed with a detector that was inert, because every one of
// them built its rounds by hand: no fixture carried a `global_id`, and no
// fixture could express two rounds colliding on one directory. `loop.test.ts`
// now has two end-to-end cases against `createManagedReviewPackage`. Neither
// goes through `keryx review loop`, which is the thing that actually runs — the
// CLI reads the packages off disk, renders the record, and sets the exit code an
// orchestrator branches on.
//
// So: one test that drives the real command and asserts it FIRES, and one that
// drives the same command over rounds that genuinely differ and asserts it does
// NOT. A detector that always fires is as useless as one that never does — it
// gets turned off, and then nothing is watching either way.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "../commands/review";
import type { StructuredReviewFinding } from "./types";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let logs: string[] = [];
let errors: string[] = [];
const realLog = console.log;
const realError = console.error;

const FLOW_DIR = "209-2026-08-31-loop-real-path";

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-loop-cli-"));
  const flowRoot = path.join(ROOT, ".metaproject", "flows", FLOW_DIR);
  await mkdir(flowRoot, { recursive: true });
  await writeFile(
    path.join(flowRoot, "flow.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "209",
      slug: "loop-real-path",
      title: "loop real path",
      status: "in-progress",
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
      source: { type: "description", ref: null },
      acChecksum: null,
      acConfirmed: {},
      pr: { url: null },
      tasks: [
        { id: "T1", title: "fix it", kind: "implement", status: "todo", attempts: { count: 3, log: [] } },
      ],
      history: [],
    }),
    "utf8",
  );
  // The committed manifest schema, so ingest validates against the real
  // contract rather than skipping validation in a bare temp directory.
  await mkdir(path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas"), {
    recursive: true,
  });
  await writeFile(
    path.join(ROOT, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
    await readFile(
      path.join(ORIGINAL_CWD, "docs", "requirements", "managed-review-feedback-loop", "schemas", "managed-review-package.schema.json"),
      "utf8",
    ),
    "utf8",
  );
  logs = [];
  errors = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

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

const RECURRING: StructuredReviewFinding = {
  id: "F-001",
  reviewer: "review-logic",
  severity: "major",
  problem: "the retry loop never checks the cancellation token",
  impact: "a cancelled run keeps spending budget until the cap",
  suggested_fix: "check the token at the top of the loop body",
  evidence: "src/harness/retry.ts:88",
  confidence: "high",
  class_scope: { sites: ["src/harness/retry.ts:88"], enumeration_method: "read every loop in the file" },
};

/**
 * Ingest one round through the CLI, exactly as the orchestrator's script does:
 * NO `--review-id`. The round-collapsing half of the original defect lived
 * entirely in that default, so passing one here would test a path nobody runs.
 */
async function ingestRound(summary: string, findings: StructuredReviewFinding[]): Promise<void> {
  const report = path.join(ROOT, `round-${Buffer.from(summary).toString("hex").slice(0, 12)}.md`);
  await writeFile(
    report,
    `# Review round\n\nSummary: ${summary}\n\n\`\`\`keryx:findings\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`,
    "utf8",
  );
  await reviewCommand(["ingest", "--flow", "209", "--target", "branch", "--ref", "flow/209-regressions", "--report", report]);
  if (process.exitCode !== 0) {
    throw new Error(`ingest failed: ${errors.join("\n")}`);
  }
}

test("AC8: `keryx review loop` FIRES on a finding that survived a fix round", async () => {
  process.chdir(ROOT);

  // Two rounds, same branch, same day, no explicit review id — and one changed
  // word in the Summary, so `identical-output` cannot carry the result and
  // `repeated-finding` is the only thing that can fire.
  await ingestRound("the fix did not land", [RECURRING]);
  await ingestRound("the fix still did not land", [RECURRING]);
  logs = [];
  errors = [];

  await reviewCommand(["loop", "--flow", "209", "--task", "T1"]);

  const printed = logs.join("\n");
  expect(printed).toContain("rounds_seen: 2");
  expect(printed).toContain("escalate: yes");
  expect(printed).toContain("repeated-finding");
  // The attempt count is CONTEXT, read from flow.json — never a condition on
  // the escalation.
  expect(printed).toContain("attempts_recorded: 3");
  // The exit code is the part an orchestrator branches on. A detector that
  // renders a table and exits 0 is a detector nothing acts upon.
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("ESCALATE");
});

test("AC8: it does NOT fire when the two rounds genuinely differ", async () => {
  // The other half of the guarantee. A detector that always fires is as useless
  // as one that never does, and this is the assertion that would go red if
  // identity ever collapsed to something every finding shares — `id`, the
  // reviewer name, or a placeholder key for findings with no content.
  process.chdir(ROOT);

  await ingestRound("first pass", [RECURRING]);
  await ingestRound("second pass, the first finding is fixed", [
    {
      ...RECURRING,
      // Deliberately the SAME display id. `F-001` denotes a different finding in
      // every round of every review in the corpus, so a detector that treated it
      // as an identity would fire on the second round of every flow whatever
      // happened — and this is the assertion that catches that.
      id: "F-001",
      reviewer: "review-style",
      problem: "the helper is named `doIt`, which says nothing about what it does",
      impact: "the next reader has to open it to find out",
      suggested_fix: "rename it to `retryWithBackoff`",
      evidence: "src/harness/retry.ts:12",
      class_scope: { sites: ["src/harness/retry.ts:12"], enumeration_method: "read every helper in the file" },
    },
  ]);
  logs = [];
  errors = [];

  await reviewCommand(["loop", "--flow", "209"]);

  const printed = logs.join("\n");
  expect(printed).toContain("rounds_seen: 2");
  expect(printed).toContain("escalate: no");
  expect(printed).not.toContain("repeated-finding");
  expect(process.exitCode).toBe(0);
  expect(errors.join("\n")).not.toContain("ESCALATE");
  // And the negative is REPORTED as observed rather than merely silent: both
  // rounds carried a report, so the output half actually ran.
  expect(printed).toContain("output_pairs_compared: 1 of 1");
});

test("AC8: one round says repetition cannot be observed yet, rather than `no loop`", async () => {
  process.chdir(ROOT);
  await ingestRound("only pass", [RECURRING]);
  logs = [];

  await reviewCommand(["loop", "--flow", "209"]);

  expect(logs.join("\n")).toContain("fewer than two rounds");
  expect(process.exitCode).toBe(0);
});
