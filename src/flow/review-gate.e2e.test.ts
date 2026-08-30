// Flow 204 — the review gate, driven END TO END through the real CLI.
//
// # Why this file exists as a separate suite
//
// `review-gate.test.ts` has 35 tests and every one of them passed while
// `flow complete` was bricked for every flow the shipping CLI created. The gate
// compares `manifest.target.head` against the pull request's head; nothing on
// the writing side ever set `manifest.target.head`; and the suite did not see it
// because `review-fixtures.ts` wrote the property itself. A test over
// hand-built input exercises the READER. It cannot, in principle, notice that
// the WRITER is missing.
//
// So this suite builds nothing by hand. It creates a real git repository,
// changes into it, and calls the same two entry points the operator calls —
// `flowCommand` and `reviewCommand` — asserting on what they print. If
// `createManagedReviewPackage` stops recording the head, the head-commit
// condition goes back to `unobserved` and these tests fail; no fixture stands
// between the assertion and the producer.
//
// The completion path used here is `--merged <sha>` rather than a pull request,
// for one reason: it needs no network and no `gh`. The head-commit condition is
// exercised identically — it compares the round's recorded head against the
// merged commit — and the external-comment condition is satisfied honestly,
// because a flow with no PR has no comments anybody could have left.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand, flowServiceDeps } from "../commands/flow";
import { reviewCommand } from "../commands/review";
import { durableExternalCommentsGate } from "./review-gate";
import type { ManagedReviewManifest } from "../review/types";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

let ROOT = "";
let logs: string[] = [];

/** ANSI is stripped so an assertion is about the words, not about the colours. */
function output(): string {
  // eslint-disable-next-line no-control-regex
  return logs.join("\n").replace(/\[[0-9;]*m/g, "");
}

async function git(args: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
  return stdout.trim();
}

/** A real repository with one real commit, because the producer reads a real one. */
async function freshRepo(): Promise<string> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-review-gate-e2e-"));
  await git(["init", "--quiet", "--initial-branch", "main"], ROOT);
  await writeFile(path.join(ROOT, "README.md"), "# subject\n", "utf8");
  await git(["add", "README.md"], ROOT);
  await git(["commit", "--quiet", "-m", "initial"], ROOT);
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  return git(["rev-parse", "HEAD"], ROOT);
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

/** `flow init` … up to the point where `flow complete` runs its gates. */
async function initFlow(): Promise<string> {
  await flowCommand(["init", "--title", "gate probe"]);
  const dir = await flowDir();
  await writeFile(
    path.join(ROOT, ".metaproject", "flows", dir, "acceptance-criteria.md"),
    "# Acceptance Criteria\n\n## Criteria\n\n- AC1: The review gate passes through the real CLI.\n",
    "utf8",
  );
  await flowCommand(["freeze", "001"]);
  await flowCommand(["start", "001"]);
  await flowCommand(["ac", "confirm", "001", "AC1"]);
  for (const taskId of ["T1", "T2", "T3", "T4"]) {
    await flowCommand(["task", "done", "001", taskId]);
  }
  return dir;
}

async function flowDir(): Promise<string> {
  const entries = await readdir(path.join(ROOT, ".metaproject", "flows"));
  const dir = entries.filter((entry) => entry.startsWith("001-"))[0];
  if (dir === undefined) {
    throw new Error(`no flow package under .metaproject/flows: ${entries.join(", ")}`);
  }
  return dir;
}

async function ingestRound(reviewId: string, extra: string[] = []): Promise<void> {
  await writeFile(path.join(ROOT, "round.md"), "# Round\n\nNothing outstanding.\n", "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "round.md",
    "--ref",
    "round.md",
    "--flow",
    "001",
    "--review-id",
    reviewId,
    ...extra,
  ]);
}

async function manifestPath(reviewId: string): Promise<string> {
  return path.join(ROOT, ".metaproject", "flows", await flowDir(), "reviews", reviewId, "manifest.json");
}

async function readManifest(reviewId: string): Promise<ManagedReviewManifest> {
  return JSON.parse(await readFile(await manifestPath(reviewId), "utf8")) as ManagedReviewManifest;
}

/** The `review` line `flow complete` printed, with its conditions. */
function reviewLine(): string {
  const lines = output().split("\n");
  const index = lines.findIndex((line) => /^\s*[^\s]\s+review\s/.test(line));
  if (index === -1) {
    throw new Error(`no review gate line in:\n${output()}`);
  }
  // A failing review gate prints one line per condition, indented under it.
  const rest: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!line.startsWith("      ")) {
      break;
    }
    rest.push(line);
  }
  return [lines[index], ...rest].join("\n");
}

// ---------------------------------------------------------------------------

test("B1 — `review ingest` records the commit it ran against, and `flow complete` passes the review gate", async () => {
  const head = await freshRepo();
  await initFlow();

  await ingestRound("round-1");

  // The producer, observed directly: nothing in this test wrote this value.
  const manifest = await readManifest("round-1");
  expect(manifest.target.head).toBe(head);

  logs = [];
  await flowCommand(["complete", "001", "--merged", head]);

  const review = reviewLine();
  expect(review).toContain("review");
  expect(review).toContain("all 5 conditions hold");
  // Specifically the condition that was unsatisfiable: the round's SHA is known
  // and it matches what is being completed.
  expect(review).not.toContain("unobserved");
  expect(review).not.toContain("head-commit");
});

test("B1 — without a recorded head the gate refuses, which is what every flow used to hit", async () => {
  // The regression this pins: strip `target.head` back out of a package the real
  // CLI wrote, and `flow complete` reports exactly the failure every flow this
  // build created reported before the producer existed.
  const head = await freshRepo();
  await initFlow();
  await ingestRound("round-1");

  const file = await manifestPath("round-1");
  const manifest = JSON.parse(await readFile(file, "utf8")) as ManagedReviewManifest;
  delete manifest.target.head;
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  logs = [];
  await flowCommand(["complete", "001", "--merged", head]);

  expect(reviewLine()).toContain("head-commit (unobserved)");
  expect(reviewLine()).toContain("records no target head commit");
});

test("B1 — `--head` overrides the checkout, and a stale one is caught rather than trusted", async () => {
  const head = await freshRepo();
  await initFlow();
  const stale = "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432";

  await ingestRound("round-1", ["--head", stale]);
  expect((await readManifest("round-1")).target.head).toBe(stale);

  logs = [];
  await flowCommand(["complete", "001", "--merged", head]);

  expect(reviewLine()).toContain("head-commit (violated)");
  expect(reviewLine()).toContain("stale SHA");
});

test("B1 — `--head` refuses a value that is not a commit SHA", async () => {
  await freshRepo();
  await initFlow();

  await ingestRound("round-1", ["--head", "HEAD~1"]);

  expect(process.exitCode).toBe(1);
  expect(output()).toContain("is not a commit SHA");
});

test("B1 — a second round moves the recorded head with the tree", async () => {
  await freshRepo();
  await initFlow();
  await ingestRound("round-1");

  await writeFile(path.join(ROOT, "README.md"), "# subject, revised\n", "utf8");
  await git(["add", "README.md"], ROOT);
  await git(["commit", "--quiet", "-m", "the fix"], ROOT);
  const second = await git(["rev-parse", "HEAD"], ROOT);

  await ingestRound("round-2");

  expect((await readManifest("round-1")).target.head).not.toBe(second);
  expect((await readManifest("round-2")).target.head).toBe(second);

  logs = [];
  await flowCommand(["complete", "001", "--merged", second]);
  expect(reviewLine()).toContain("all 5 conditions hold");
});

// ---------------------------------------------------------------------------
// `flow complete --merged <sha>` — the completion path with no pull request
// ---------------------------------------------------------------------------
//
// On this path `prHead` is null and condition 3 compares the round's head with
// the merge commit. That was an EQUALITY test, and the two are equal only for a
// merge that preserved the branch commit. A squash or a rebase mints a new one
// by construction, so the gate refused every such completion with advice —
// "re-run the round" — that could not be followed: the next round would record
// the branch head again and fail identically. Neither case had a test.
//
// What replaced it: containment. The reviewed commit being IN what merged is the
// fact condition 3 is actually after, and a merge commit has it. A squash still
// fails — the reviewed commit does not exist in the merged history and no round
// against the branch can make it — but it now says so, and names the two things
// that do work.

/** A branch commit, reviewed, with `main` still at the base commit. */
async function reviewedBranch(): Promise<string> {
  await git(["checkout", "--quiet", "-b", "feature"], ROOT);
  await writeFile(path.join(ROOT, "README.md"), "# subject, revised\n", "utf8");
  await git(["add", "README.md"], ROOT);
  await git(["commit", "--quiet", "-m", "the change"], ROOT);
  const head = await git(["rev-parse", "HEAD"], ROOT);
  await ingestRound("round-1");
  expect((await readManifest("round-1")).target.head).toBe(head);
  await git(["checkout", "--quiet", "main"], ROOT);
  return head;
}

test("B1 — a merge that KEPT the reviewed commit completes: the round is contained in it", async () => {
  await freshRepo();
  await initFlow();
  const branchHead = await reviewedBranch();

  await git(["merge", "--quiet", "--no-ff", "-m", "merge feature", "feature"], ROOT);
  const merged = await git(["rev-parse", "HEAD"], ROOT);
  expect(merged).not.toBe(branchHead);

  logs = [];
  await flowCommand(["complete", "001", "--merged", merged]);

  const review = reviewLine();
  expect(review).toContain("all 5 conditions hold");
  expect(review).not.toContain("head-commit");
});

test("B1 — a SQUASH merge cannot be completed against, and the gate says why instead of `re-run the round`", async () => {
  await freshRepo();
  await initFlow();
  const branchHead = await reviewedBranch();

  await git(["merge", "--squash", "feature"], ROOT);
  await git(["commit", "--quiet", "-m", "the change (squashed)"], ROOT);
  const squashed = await git(["rev-parse", "HEAD"], ROOT);

  logs = [];
  await flowCommand(["complete", "001", "--merged", squashed]);

  const review = reviewLine();
  expect(review).toContain("head-commit (violated)");
  expect(review).toContain(branchHead);
  expect(review).toContain(squashed);
  // Advice that can be acted on: the reviewed commit was rewritten, so re-running
  // the round against the branch is exactly the thing that will not help.
  expect(review).toContain("SQUASH");
  expect(review).toContain("not contained in it");
  expect(review).toContain(`--head ${squashed}`);
});

test("MAJOR 3 — the external-comment seam is wired at the composition root", () => {
  // It was declared on `FlowServiceDeps`, read by `service.ts:461`, and provided
  // by exactly two test cases. `getService()` — the only builder the CLI uses —
  // was never touched, so on the path an operator runs the condition had no
  // collector at all and fell through to a coverage name any `--reviewers` value
  // produced.
  expect(flowServiceDeps().externalCommentsGate).toBe(durableExternalCommentsGate);
});
