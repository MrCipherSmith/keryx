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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { flowCommand, flowServiceDeps } from "../commands/flow";
import { reviewCommand } from "../commands/review";
import { durableExternalCommentsGate, runReviewGate } from "./review-gate";
import type { ReviewGateCondition } from "./review-gate";
import { readFlow } from "./store";
import { writePrCommentFixtureState } from "./review-fixtures";
import type { ManagedReviewManifest } from "../review/types";

const ORIGINAL_CWD = process.cwd();
const CLI = path.join(import.meta.dir, "..", "cli.ts");
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

/**
 * Run the CLI in a CHILD process whose `gh` cannot authenticate.
 *
 * Everything else in this file calls `flowCommand` in-process, which is faster
 * and enough. It is not enough here, for a reason worth writing down: the state
 * under test is `githubAdapter.detect()` returning false, `detect()` starts with
 * `Bun.which("gh")`, and **`Bun.which` reads a `PATH` snapshotted at process
 * start** — mutating `process.env.PATH` inside the test changes nothing it will
 * see. `gh` is also commonly wrapped on a developer's machine in a way that
 * re-derives `GH_CONFIG_DIR`, so pointing the environment at an empty config
 * does not disarm it either. A fresh process with a `gh` shim first on `PATH` is
 * the only arrangement in which the real adapter genuinely fails the way it
 * fails on a CI runner.
 *
 * Nothing is injected: the child builds the same `flowServiceDeps()` an operator
 * gets, reaches the same `githubAdapter`, and asks the process table.
 */
async function cliWithoutGh(args: string[]): Promise<string> {
  const bin = path.join(ROOT, "fake-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "gh"), "#!/bin/sh\necho 'gh: not logged into any hosts' >&2\nexit 1\n", {
    encoding: "utf8",
    mode: 0o755,
  });
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env["PATH"] ?? ""}` },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  // eslint-disable-next-line no-control-regex
  return `${stdout}\n${stderr}`.replace(/\[[0-9;]*m/g, "");
}

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

/**
 * The `head-commit` condition, read off the gate itself.
 *
 * `flow complete` prints only the gate's summary line when it PASSES, so the
 * words a passing condition uses are invisible from the CLI output — and
 * "accepted by tree equality" versus "accepted by commit containment" is exactly
 * what an operator reading a green tick needs to be told. Everything this reads
 * was still produced by the real CLI against the real repository: the flow, the
 * package, `manifest.target.head`, and the git objects. Only the assertion route
 * is different, and it is the same function `flow complete` calls.
 */
async function headCommitCondition(mergedCommit: string): Promise<ReviewGateCondition> {
  const dir = await flowDir();
  const verdict = await runReviewGate({
    cwd: ROOT,
    flowDir: dir,
    flow: await readFlow(ROOT, dir),
    tracker: null,
    mergedCommit,
  });
  const condition = verdict.conditions.find((item) => item.id === "head-commit");
  if (condition === undefined) {
    throw new Error(`no head-commit condition in: ${verdict.detail}`);
  }
  return condition;
}

/** The `review` line `flow complete` printed, with its conditions. */
function reviewLine(text: string = output()): string {
  const lines = text.split("\n");
  const index = lines.findIndex((line) => /^\s*[^\s]\s+review\s/.test(line));
  if (index === -1) {
    throw new Error(`no review gate line in:\n${text}`);
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

test("B1 — `--head` overrides the checkout, and a SHA this clone does not have is unobserved, not trusted", async () => {
  // The round's head is well-formed and absent from the object database. Neither
  // `merge-base --is-ancestor` nor `rev-parse ^{tree}` can say anything about it,
  // so the honest report is `unobserved`: the check could not run. What it must
  // never be is `pass`.
  const head = await freshRepo();
  await initFlow();
  const stale = "0f1e2d3c4b5a69788796a5b4c3d2e1f098765432";

  await ingestRound("round-1", ["--head", stale]);
  expect((await readManifest("round-1")).target.head).toBe(stale);

  logs = [];
  await flowCommand(["complete", "001", "--merged", head]);

  expect(reviewLine()).toContain("head-commit (unobserved)");
  expect(reviewLine()).toContain(stale);
  expect(reviewLine()).toContain("the trees could not be compared");
  expect(reviewLine()).toContain("not the same as running and failing");
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
// the merge commit. It has now been three tests:
//
//   1. EQUALITY — held only for a merge that preserved the branch commit;
//   2. CONTAINMENT (`merge-base --is-ancestor`) — holds for `--no-ff`, and is
//      false by construction for a squash, which has no ancestry link to the
//      branch at all. It made the refusal legible without making the path
//      completable, and squash is what this project merges with;
//   3. TREE EQUALITY, when containment fails — `<round head>^{tree}` against
//      `<merged commit>^{tree}`. A clean squash of an up-to-date branch produces
//      the branch tip's tree exactly, so this is the positive, checkable answer
//      to the question condition 3 is really asking.
//
// The tests below use a REAL `git merge --squash`, because the shape of defect
// this suite exists for is a fixture that cannot see a producer which never sets
// the field.

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

test("B1 — a merge that KEPT the reviewed commit completes, and says it was containment that proved it", async () => {
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

  // The `--no-ff` path is unchanged and still decided by ancestry — the trees of
  // a merge commit and its second parent happen to be equal here too, so a
  // passing gate alone would not distinguish the two routes.
  const condition = await headCommitCondition(merged);
  expect(condition.status).toBe("pass");
  expect(condition.detail).toContain("COMMIT CONTAINMENT");
  expect(condition.detail).not.toContain("TREE EQUALITY");
  expect(condition.detail).toContain(branchHead);
  expect(condition.detail).toContain(merged);
});

test("B1 — a real SQUASH merge completes, accepted by tree equality rather than by ancestry", async () => {
  await freshRepo();
  await initFlow();
  const branchHead = await reviewedBranch();

  await git(["merge", "--squash", "feature"], ROOT);
  await git(["commit", "--quiet", "-m", "the change (squashed)"], ROOT);
  const squashed = await git(["rev-parse", "HEAD"], ROOT);

  // The premise, asserted rather than assumed: the squash has no ancestry
  // relation to the reviewed commit, so containment cannot be what passes it.
  expect(squashed).not.toBe(branchHead);
  const ancestor = Bun.spawnSync(["git", "merge-base", "--is-ancestor", branchHead, squashed], { cwd: ROOT });
  expect(ancestor.exitCode).toBe(1);

  logs = [];
  await flowCommand(["complete", "001", "--merged", squashed]);

  const review = reviewLine();
  expect(review).toContain("all 5 conditions hold");
  expect(review).not.toContain("head-commit");

  const condition = await headCommitCondition(squashed);
  expect(condition.status).toBe("pass");
  // Which test succeeded, and the two SHAs it succeeded on.
  expect(condition.detail).toContain("TREE EQUALITY");
  expect(condition.detail).toContain(branchHead);
  expect(condition.detail).toContain(squashed);
  // And the tree it proved equal, which is the fact the pass rests on.
  const tree = await git(["rev-parse", `${branchHead}^{tree}`], ROOT);
  expect(condition.detail).toContain(tree);
});

test("B1 — a squash whose tree DIFFERS is violated: a base that moved means the reviewers did not read what merged", async () => {
  await freshRepo();
  await initFlow();
  const branchHead = await reviewedBranch();

  // `main` moves under the branch AFTER the round ran. The squash therefore
  // carries this file as well, and its tree is not the reviewed tree.
  await writeFile(path.join(ROOT, "CHANGELOG.md"), "# landed first\n", "utf8");
  await git(["add", "CHANGELOG.md"], ROOT);
  await git(["commit", "--quiet", "-m", "something else landed first"], ROOT);

  await git(["merge", "--squash", "feature"], ROOT);
  await git(["commit", "--quiet", "-m", "the change (squashed onto a moved base)"], ROOT);
  const squashed = await git(["rev-parse", "HEAD"], ROOT);

  logs = [];
  await flowCommand(["complete", "001", "--merged", squashed]);

  const review = reviewLine();
  expect(review).toContain("head-commit (violated)");
  expect(review).toContain(branchHead);
  expect(review).toContain(squashed);
  // Both trees are named, so "they differ" is checkable rather than asserted.
  expect(review).toContain(await git(["rev-parse", `${branchHead}^{tree}`], ROOT));
  expect(review).toContain(await git(["rev-parse", `${squashed}^{tree}`], ROOT));
  expect(review).toContain("did not read what merged");
  // Advice that can be acted on: re-running the round against the branch would
  // record the same tree again and fail identically.
  expect(review).toContain("will not close this");
  expect(review).toContain(`--head ${squashed}`);
});

test("B1 — a merged SHA that is not in the object database is unobserved, never a pass", async () => {
  await freshRepo();
  await initFlow();
  const branchHead = await reviewedBranch();
  const absent = "1234567890abcdef1234567890abcdef12345678";

  logs = [];
  await flowCommand(["complete", "001", "--merged", absent]);

  const review = reviewLine();
  expect(review).toContain("head-commit (unobserved)");
  expect(review).not.toContain("head-commit (pass)");
  expect(review).toContain(branchHead);
  expect(review).toContain(absent);
  // It names the object that could not be read, and it does not accuse the round
  // of having reviewed the wrong thing — nothing here established that.
  expect(review).toContain("the trees could not be compared");
  expect(review).toContain("the merged commit");
  expect(review).not.toContain("did not read what merged");

  const condition = await headCommitCondition(absent);
  expect(condition.status).toBe("unobserved");
});

// ---------------------------------------------------------------------------
// A flow with a pull request, in an environment that cannot reach the tracker
// ---------------------------------------------------------------------------
//
// The state the gate could not previously name. `githubAdapter.detect()` returns
// false with no `gh` on `PATH` and with a `gh auth status` that exits non-zero,
// so the pull request is never asked for its head — and the first version of the
// freshness check reported that as "the pull request's own head could not be
// resolved, so nothing establishes that the collection is current", which reads
// as *your record is stale*. A CI runner was told to re-collect comments it had
// already collected, and no fixture could catch it: the field is produced by an
// adapter shelling out to a binary, and a hand-built gate input never runs it.
//
// The comment RECORD below is a fixture, deliberately and narrowly: writing it
// for real needs the network these tests exist to avoid. Everything that
// produces the state under test — the flow, the PR on it, the round, the
// adapter, the resolution — is the real CLI.

const PR = "https://github.com/acme/app/pull/7";

test("state 3 — an unauthenticated `gh` is reported as a dead tracker, not as a stale record", async () => {
  const base = await freshRepo();
  await initFlow();
  await ingestRound("round-1");

  // `flow implemented` records the PR WITHOUT verifying it, precisely because
  // the tracker is unavailable — that is how a flow acquires a PR URL in this
  // environment, and it is what makes condition 4 apply at completion.
  const implemented = await cliWithoutGh(["flow", "implemented", "001", "--pr", PR]);
  expect(implemented).toContain("implemented");
  // Proof the shim bit: with a working `gh` this command REFUSES an unreachable
  // pull request ("PR not found or inaccessible"), and `acme/app#7` is not one
  // this machine can see.
  expect(implemented).not.toContain("not found or inaccessible");

  // Collected at the very commit the round ran against: as current as a record
  // can be. If the gate calls this stale, it is guessing.
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR, collectedSha: base });

  const review = reviewLine(await cliWithoutGh(["flow", "complete", "001", "--merged", base]));
  expect(review).toContain("external-comments (unobserved)");
  // It names the tracker, and the remedy is about the tracker.
  expect(review).toContain("could not be reached");
  expect(review).toContain("gh auth login");
  // The operator-level escape, so the only way out is not "inject a dependency".
  expect(review).toContain("require_clean_round");
  // And it does not accuse a current record of being out of date.
  expect(review).toContain("neither shown to be current nor shown to be stale");
  expect(review).not.toContain("was last collected against");

  // The precondition this creates, stated by the test that creates it:
  // condition 3 is SATISFIED here — the merged commit stands in for the PR head
  // and containment is decided locally — and condition 4 still is not, because
  // no commit can answer "has anyone commented since". Documented in
  // `docs/docs/guides/review-with-a-record.md`.
  expect(review).toContain("1 of 5 conditions failed");
  expect(review).not.toContain("head-commit (");
});

test("state 3 — with no `--merged` either, both conditions give the same reason", async () => {
  await freshRepo();
  await initFlow();
  await ingestRound("round-1");
  await cliWithoutGh(["flow", "implemented", "001", "--pr", PR]);
  await writePrCommentFixtureState({ cwd: ROOT, prUrl: PR, collectedSha: "0".repeat(40) });

  const review = reviewLine(await cliWithoutGh(["flow", "complete", "001"]));
  expect(review).toContain("head-commit (unobserved)");
  expect(review).toContain("external-comments (unobserved)");
  // One cause, one sentence, printed once per condition. Condition 3 used to say
  // "the tracker did not report a head SHA" about a tracker it never ran.
  expect(review.match(/the tracker could not be reached/g)?.length).toBe(2);
  expect(review).not.toContain("did not report a head SHA");
  // The record here IS stale, and the gate still does not say so — because with
  // no head resolved it does not know that, and saying it would be the same
  // guess in the opposite direction.
  expect(review).not.toContain("but the PR head is");
});

test("MAJOR 3 — the external-comment seam is wired at the composition root", () => {
  // It was declared on `FlowServiceDeps`, read by `service.ts:461`, and provided
  // by exactly two test cases. `getService()` — the only builder the CLI uses —
  // was never touched, so on the path an operator runs the condition had no
  // collector at all and fell through to a coverage name any `--reviewers` value
  // produced.
  expect(flowServiceDeps().externalCommentsGate).toBe(durableExternalCommentsGate);
});
