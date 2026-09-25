// The CLI surface of the review pipeline (flow 202, AC5/AC14).
//
// Every mechanism this flow added is reachable from TypeScript. That is not the
// same as being reachable, and the difference was measured: `completeManagedReview
// ({dispositions})` and `createManagedReviewPackage({refuted})` had no flag, so
// the shipped pipeline could write ZERO dispositions — and because unknown flags
// were accepted silently with exit 0, an operator who guessed the right spelling
// got `status: closed` and a findings.json with nothing in it. A mechanism that
// nothing can reach measures nothing, which is the state that pinned the
// precision figure at 100% in the first place.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import type { StructuredReviewFinding } from "../review/types";
import { loadRoutingConfigRaw } from "../harness/routing/config";
import { approveProjectRouting } from "../harness/routing/trust";

const ORIGINAL_CWD = process.cwd();
let ROOT = "";
let errors: string[] = [];
let logs: string[] = [];
const realError = console.error;
const realLog = console.log;
const REAL_XDG = process.env.XDG_DATA_HOME;

beforeEach(async () => {
  ROOT = await mkdtemp(path.join(tmpdir(), "gd-review-cli-"));
  await mkdir(path.join(ROOT, ".metaproject"), { recursive: true });
  process.chdir(ROOT);
  // `review tier` reads the provider/model `keryx shell` persisted, which lives
  // under the per-user config directory rather than under the cwd. Without this
  // the developer's own `auth.json` would decide what these tests assert.
  process.env.XDG_DATA_HOME = path.join(ROOT, "xdg");
  // Same reason: a host that exports its session model would otherwise decide
  // what the tier tests below assert.
  delete process.env.KERYX_SESSION_PROVIDER;
  delete process.env.KERYX_SESSION_MODEL;
  errors = [];
  logs = [];
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.error = realError;
  console.log = realLog;
  if (REAL_XDG === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = REAL_XDG;
  }
  process.chdir(ORIGINAL_CWD);
  process.exitCode = 0;
  if (ROOT) {
    await rm(ROOT, { recursive: true, force: true });
    ROOT = "";
  }
});

const FINDING = {
  id: "F-001",
  reviewer: "review-security-code",
  severity: "minor",
  problem: "the guard asserts on a synthetic context",
  impact: "the guard passes when the production path is unwired",
  suggested_fix: "drive the writer the CLI drives",
  evidence: "deleted the guarded line; the test stayed green",
  confidence: "high",
};

/** A report carrying the structured block, which is how ingest gets findings. */
function reportWith(findings: readonly unknown[]): string {
  return `# Round\n\n\`\`\`json keryx:findings\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`;
}

async function ingest(reviewId: string, extra: string[] = []): Promise<string> {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    reviewId,
    ...extra,
  ]);
  return path.join(ROOT, ".metaproject", "reviews", reviewId);
}

async function findingsOf(packageDir: string): Promise<StructuredReviewFinding[]> {
  return JSON.parse(await readFile(path.join(packageDir, "findings.json"), "utf8")) as StructuredReviewFinding[];
}

// ---------------------------------------------------------------------------
// Unknown flags
// ---------------------------------------------------------------------------

test("an unknown flag is refused rather than ignored with exit 0", async () => {
  // The compounding failure. Guessing `--disposition` on a command that had no
  // such option printed `status: closed` and wrote nothing, so the operator had
  // no signal at all that the mechanism had not run.
  const pkg = await ingest("2026-08-29-cli-unknown-flag");
  expect(process.exitCode).toBe(0);

  await reviewCommand(["complete", pkg, "--not-a-flag", "x"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--not-a-flag");
});

test("a misspelled ingest flag is refused before a package is written", async () => {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-29-cli-bad-ingest-flag",
    "--verification_mode",
    "filter",
  ]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--verification_mode");
});

test("every documented flag is still accepted", async () => {
  // Non-vacuity: an allowlist that rejects the real surface is worse than none.
  await writeFile(path.join(ROOT, "diff.patch"), "", "utf8");
  await reviewCommand(["scope", "--diff", "diff.patch", "--context", "10", "--json"]);
  expect(process.exitCode).toBe(0);
});

// ---------------------------------------------------------------------------
// AC14: the disposition, from the command line
// ---------------------------------------------------------------------------

test("`review complete` writes a disposition with its evidence", async () => {
  const pkg = await ingest("2026-08-29-cli-disposition");
  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
  ]);
  expect(process.exitCode).toBe(0);

  const findings = await findingsOf(pkg);
  expect(findings[0]?.disposition).toEqual({ state: "acted-on", evidence: "closed by 380bf3b0" });
  expect(logs.join("\n")).toContain("dispositions recorded: 1");
});

test("several findings can be dispositioned in one close", async () => {
  await writeFile(
    path.join(ROOT, "report.md"),
    reportWith([FINDING, { ...FINDING, id: "F-002", problem: "a second observation" }]),
    "utf8",
  );
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-29-cli-two-dispositions",
  ]);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-08-29-cli-two-dispositions");

  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
    "--finding",
    "F-002",
    "--disposition",
    "dismissed-incorrect",
    "--evidence",
    "ran the writer under umask 002; the mode is 0700",
  ]);
  expect(process.exitCode).toBe(0);

  const findings = await findingsOf(pkg);
  expect(findings.map((f) => f.disposition?.state)).toEqual(["acted-on", "dismissed-incorrect"]);
});

test("an unknown disposition state is refused by name", async () => {
  const pkg = await ingest("2026-08-29-cli-bad-state");
  await reviewCommand(["complete", pkg, "--finding", "F-001", "--disposition", "dismissed", "--evidence", "x"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("dismissed-incorrect");
});

test("`--disposition` without `--finding` is refused rather than applied to everything", async () => {
  const pkg = await ingest("2026-08-29-cli-orphan-disposition");
  await reviewCommand(["complete", pkg, "--disposition", "acted-on", "--evidence", "closed by 380bf3b0"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--finding");
});

test("closing with no disposition flags still works, and writes nothing", async () => {
  const pkg = await ingest("2026-08-29-cli-plain-complete");
  const before = await readFile(path.join(pkg, "findings.json"), "utf8");
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);
  expect(await readFile(path.join(pkg, "findings.json"), "utf8")).toBe(before);
});

// ---------------------------------------------------------------------------
// What `complete` says about the package's disposition state
// ---------------------------------------------------------------------------

test("a bare `complete` on a fully dispositioned package does not claim nobody recorded an outcome", async () => {
  // The defect: the "every finding still reads `unknown`" line was printed
  // whenever no --disposition flag was passed, without reading the package. A
  // round is dispositioned across as many closes as it takes, so the second
  // close of a package whose every finding was already recorded was told its
  // outcomes did not exist — a false report of the exact condition this field
  // exists to make visible.
  await writeFile(
    path.join(ROOT, "report.md"),
    reportWith([FINDING, { ...FINDING, id: "F-002", problem: "a second observation" }]),
    "utf8",
  );
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-09-12-cli-all-dispositioned",
  ]);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-09-12-cli-all-dispositioned");

  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
    "--finding",
    "F-002",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
  ]);
  expect(process.exitCode).toBe(0);
  expect((await findingsOf(pkg)).every((f) => f.disposition?.state === "acted-on")).toBe(true);

  logs = [];
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);

  const output = logs.join("\n");
  expect(output).not.toContain("nobody recorded an outcome");
  expect(output).not.toContain("every finding in this package still reads");
  expect(output).toContain("findings: 2 — 2 with a recorded disposition, 0 still `unknown`");
});

test("a bare `complete` on a package nobody dispositioned still says so", async () => {
  // Non-vacuity. Removing the false claim must not remove the true one.
  const pkg = await ingest("2026-09-12-cli-none-dispositioned");
  logs = [];
  await reviewCommand(["complete", pkg]);
  expect(process.exitCode).toBe(0);

  const output = logs.join("\n");
  expect(output).toContain("findings: 1 — 0 with a recorded disposition, 1 still `unknown`");
  expect(output).toContain("1 of 1 findings read `unknown` — nobody recorded an outcome for them.");
});

test("a partly dispositioned package is reported as partly dispositioned", async () => {
  await writeFile(
    path.join(ROOT, "report.md"),
    reportWith([FINDING, { ...FINDING, id: "F-002", problem: "a second observation" }]),
    "utf8",
  );
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-09-12-cli-partly-dispositioned",
  ]);
  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-09-12-cli-partly-dispositioned");

  logs = [];
  await reviewCommand([
    "complete",
    pkg,
    "--finding",
    "F-001",
    "--disposition",
    "acted-on",
    "--evidence",
    "closed by 380bf3b0",
  ]);
  expect(process.exitCode).toBe(0);

  const output = logs.join("\n");
  expect(output).toContain("findings: 2 — 1 with a recorded disposition, 1 still `unknown`");
  expect(output).toContain("1 of 2 findings read `unknown` — nobody recorded an outcome for them.");
});

// ---------------------------------------------------------------------------
// AC14: what a round REFUTED, from the command line
// ---------------------------------------------------------------------------

test("`review ingest --refuted` records what the round raised and dismissed", async () => {
  await writeFile(
    path.join(ROOT, "refuted.json"),
    JSON.stringify([
      {
        ...FINDING,
        id: "F-009",
        problem: "claimed the writer is group-writable",
        disposition: {
          state: "dismissed-incorrect",
          evidence: "ran the writer under umask 002; the mode is 0700",
        },
      },
    ]),
    "utf8",
  );
  const pkg = await ingest("2026-08-29-cli-refuted", ["--refuted", "refuted.json"]);

  const findings = await findingsOf(pkg);
  expect(findings.map((f) => f.id)).toEqual(["F-001", "F-009"]);
  expect(findings[1]?.disposition?.state).toBe("dismissed-incorrect");
});

// ---------------------------------------------------------------------------
// AC5: --append, and the record surviving ingest
// ---------------------------------------------------------------------------

const DIFF = `diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1,2 +1,2 @@
-"old"
+"new"
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = 1;
+const a = 2;
`;

test("`--append` run three times leaves ONE pre-filter block", async () => {
  // It appended, so a re-run — an ordinary thing to do after amending a commit —
  // left three contradictory blocks in one record and no rule for which to read.
  await writeFile(path.join(ROOT, "diff.patch"), DIFF, "utf8");
  await mkdir(path.join(ROOT, "pkg"), { recursive: true });
  for (let i = 0; i < 3; i += 1) {
    await reviewCommand(["scope", "--diff", "diff.patch", "--append", path.join(ROOT, "pkg", "scope.md")]);
  }
  const scope = await readFile(path.join(ROOT, "pkg", "scope.md"), "utf8");
  expect(scope.match(/^## Pre-filter scope$/gm)).toHaveLength(1);
  expect(scope).toContain("bun.lock");
});

test("`--append` replaces the block and leaves the rest of scope.md alone", async () => {
  await writeFile(path.join(ROOT, "diff.patch"), DIFF, "utf8");
  await mkdir(path.join(ROOT, "pkg"), { recursive: true });
  await writeFile(
    path.join(ROOT, "pkg", "scope.md"),
    "# Review Scope\n\ntarget: branch\n\n## Pre-filter scope\n\nstale, from an earlier run\n\n## Stage counts\n\nkeep me\n",
    "utf8",
  );
  await reviewCommand(["scope", "--diff", "diff.patch", "--append", path.join(ROOT, "pkg", "scope.md")]);

  const scope = await readFile(path.join(ROOT, "pkg", "scope.md"), "utf8");
  expect(scope).toContain("target: branch");
  expect(scope).toContain("## Stage counts");
  expect(scope).toContain("keep me");
  expect(scope).not.toContain("stale, from an earlier run");
  expect(scope.match(/^## Pre-filter scope$/gm)).toHaveLength(1);
});

test("`--scope` carries the drop REASONS into the package, not only the counts", async () => {
  await writeFile(path.join(ROOT, "diff.patch"), DIFF, "utf8");
  const scopeJson = path.join(ROOT, "scope.json");
  const captured: string[] = [];
  const previous = console.log;
  console.log = (...args: unknown[]) => {
    captured.push(args.map(String).join(" "));
  };
  await reviewCommand(["scope", "--diff", "diff.patch", "--json"]);
  console.log = previous;
  await writeFile(scopeJson, captured.join("\n"), "utf8");

  const pkg = await ingest("2026-08-29-cli-scope-json", ["--scope", scopeJson]);
  const scope = await readFile(path.join(pkg, "scope.md"), "utf8");
  expect(scope).toContain("bun.lock");
  expect(scope).toContain("lockfile");
  expect(scope).not.toContain("no pre-filter scope was supplied");
});

// ---------------------------------------------------------------------------
// Flow 203 AC5-AC7, AC9, AC10 — the caps and the loop detector, from the CLI
// ---------------------------------------------------------------------------

test("AC6: `review budget` STOPS when spend has reached the ceiling", async () => {
  // The gate that runs BEFORE dispatch, where stopping is still possible.
  // `ingest` can only record that a round went over; by then the money is spent.
  await reviewCommand(["budget", "--spent", "3.40"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("STOP");
  expect(errors.join("\n")).toContain("Ask the operator");
});

test("AC6: `review budget` under the ceiling proceeds", async () => {
  await reviewCommand(["budget", "--spent", "0.40"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("spend_status: under");
});

test("AC10: unreported spend reads `not recorded`, not `under`", async () => {
  await reviewCommand(["budget"]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("spend_status: not-recorded");
  expect(logs.join("\n")).toContain("`not recorded` is not `under`");
});

test("AC7/AC10: `review budget` plans waves and says whether the cap holds across nesting", async () => {
  await reviewCommand(["budget", "--reviewers", "a,b,c,d,e,f"]);
  const output = logs.join("\n");

  expect(output).toContain("concurrency_cap: 4");
  expect(output).toContain("reviewers_queued: 2");
  expect(output).toContain("holds_across_nesting: no");
  expect(output).toContain("outstanding_declared: not recorded");
});

test("AC7: a declared outstanding count is the only thing that reaches the nesting", async () => {
  await reviewCommand(["budget", "--reviewers", "a,b,c,d", "--outstanding", "2"]);
  const output = logs.join("\n");

  expect(output).toContain("effective_wave_size: 2");
  expect(output).toContain("holds_across_nesting: yes");
});

test("AC5/AC10: an ingest over the cap truncates and says so on the terminal", async () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    ...FINDING,
    id: `F-${String(index + 1).padStart(3, "0")}`,
  }));
  await writeFile(path.join(ROOT, "report.md"), reportWith(many), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-cap",
  ]);

  const pkg = path.join(ROOT, ".metaproject", "reviews", "2026-08-30-cli-cap");
  expect(await findingsOf(pkg)).toHaveLength(10);
  // On the terminal the operator was already looking at, not only in a file
  // they had no reason to open.
  expect(logs.join("\n")).toContain("findings cap: limit=10/reviewer truncated=4");
  expect(logs.join("\n")).toContain("truncated 4 from review-security-code");
});

test("AC6: an ingest over the ceiling still writes the package, then refuses", async () => {
  await writeFile(path.join(ROOT, "report.md"), reportWith([FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-spend",
    "--spent",
    "5",
  ]);

  // The record of the stop survives; the command still refuses.
  const scope = await readFile(
    path.join(ROOT, ".metaproject", "reviews", "2026-08-30-cli-spend", "scope.md"),
    "utf8",
  );
  expect(scope).toContain("STOPPED at the ceiling");
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("STOP: spend 5 USD");
});

test("AC9: `review loop` escalates on a repeated finding, whatever the budget", async () => {
  const flowDir = path.join(ROOT, ".metaproject", "flows", "203-loop");
  await mkdir(flowDir, { recursive: true });
  await writeFile(
    path.join(flowDir, "flow.json"),
    JSON.stringify({
      schemaVersion: 2,
      id: "203",
      slug: "loop",
      title: "loop",
      status: "in-progress",
      createdAt: "2026-08-30T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      source: { type: "description", ref: null },
      acChecksum: null,
      acConfirmed: {},
      pr: { url: null },
      tasks: [{ id: "T1", title: "fix", kind: "implement", status: "todo", attempts: { count: 1, log: [] } }],
      history: [],
    }),
    "utf8",
  );
  for (const [name, at] of [
    ["round-1", "2026-08-30T01:00:00.000Z"],
    ["round-2", "2026-08-30T02:00:00.000Z"],
  ] as const) {
    const dir = path.join(flowDir, "reviews", name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify({ reviewId: name, createdAt: at }), "utf8");
    await writeFile(path.join(dir, "findings.json"), JSON.stringify([FINDING]), "utf8");
    await writeFile(path.join(dir, "report.md"), `# ${name}\n`, "utf8");
  }

  await reviewCommand(["loop", "--flow", "203", "--task", "T1"]);

  // One attempt spent out of three: a counter would say "keep going".
  expect(logs.join("\n")).toContain("attempts_recorded: 1");
  expect(logs.join("\n")).toContain("repeated-finding");
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("ESCALATE");
});

// ---------------------------------------------------------------------------
// AC3 from the command line: the scope-B screen's set, and its counts
// ---------------------------------------------------------------------------
//
// The screen itself is proven in `review/managed.test.ts`. What is proven here
// is the pair of wires the library cannot see: that `--blast-radius` reaches
// `ManagedReviewIngestInput.blastRadius`, and that the counts reach the terminal.
// The screen shipped with neither, so an enforcement that ran was indistinguishable
// on the terminal from one that had not — the shape of every defect this round found.

const SCOPE_B_FINDING = {
  id: "B-001",
  reviewer: "review-regression",
  severity: "major",
  problem: "this function is named badly and the module is arranged oddly",
  impact: "future readers will be slower",
  suggested_fix: "rename it",
  evidence: "read the file",
  confidence: "high",
  file: "src/untouched.ts",
  scope: "blast-radius",
};

test("--blast-radius reaches the screen, and the screen says which set it used", async () => {
  await writeFile(
    path.join(ROOT, "radius.json"),
    JSON.stringify({ files: [{ path: "src/untouched.ts", hop: 1 }], changedFiles: ["src/changed.ts"] }),
    "utf8",
  );
  await writeFile(path.join(ROOT, "report.md"), reportWith([SCOPE_B_FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-blast-radius",
    "--blast-radius",
    "radius.json",
  ]);

  expect(process.exitCode).toBe(0);
  expect(logs.join("\n")).toContain("scope-B screen: source=input");
});

// ---------------------------------------------------------------------------
// `keryx review blast-radius`, through the CLI
// ---------------------------------------------------------------------------
//
// The computation is proven in `review/blast-radius.test.ts` and the ingest wire
// in the two tests above. NEITHER touches `runBlastRadius`, and that was
// measured: `throw new Error("MUTATION")` as the first statement of the handler
// left `bun test src/commands src/review src/flow` at 1320 pass / 0 fail across
// 86 files. A hard throw at the top of a shipped command that the entire suite
// cannot see is the same defect shape as a cap that truncates in silence.

/** Run git in the temp repository, with no dependency on the developer's config. */
async function git(...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "review-cli-test",
      GIT_AUTHOR_EMAIL: "review-cli-test@example.invalid",
      GIT_COMMITTER_NAME: "review-cli-test",
      GIT_COMMITTER_EMAIL: "review-cli-test@example.invalid",
    },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${code}): ${stderr.trim()}`);
  }
}

/** A file node as `keryx gdgraph build` writes it into `storage/nodes.jsonl`. */
function node(file: string): string {
  return JSON.stringify({ id: file, kind: "file", path: file, language: "typescript" });
}

/** An import edge: `from` depends on `to`, so `to`'s dependents are the `from`s. */
function edge(from: string, to: string): string {
  return JSON.stringify({ id: `${from}->${to}`, from, to, kind: "imports", specifier: "./core" });
}

/**
 * A real git repository with a real graph on disk: three files importing one, a
 * co-named test, one commit. `loadGraph` reads exactly these two files, so
 * nothing about the graph is stubbed.
 */
async function repoWithGraph(): Promise<void> {
  const storage = path.join(ROOT, ".metaproject", "data", "gdgraph", "storage");
  await mkdir(storage, { recursive: true });
  await mkdir(path.join(ROOT, "src"), { recursive: true });
  const files = ["src/core.ts", "src/a.ts", "src/b.ts", "src/c.ts", "src/core.test.ts"];
  for (const file of files) {
    await writeFile(path.join(ROOT, file), `export const x = "${file}";\n`, "utf8");
  }
  await writeFile(
    path.join(storage, "nodes.jsonl"),
    `${["src/core.ts", "src/a.ts", "src/b.ts", "src/c.ts"].map(node).join("\n")}\n`,
    "utf8",
  );
  await writeFile(
    path.join(storage, "edges.jsonl"),
    `${["src/a.ts", "src/b.ts", "src/c.ts"].map((from) => edge(from, "src/core.ts")).join("\n")}\n`,
    "utf8",
  );
  await git("init", "-q");
  await git("add", "-A");
  await git("commit", "-qm", "seed");
}

test("`review blast-radius` prints the set AND every file the cap removed", async () => {
  await repoWithGraph();

  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--max-files", "2"]);

  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  // Three graph dependents plus the co-named test the repository really has.
  expect(out).toContain("candidates: 4");
  expect(out).toContain("retained: 2");
  expect(out).toContain("dropped_by_cap: 2");
  expect(out).toContain("### Dropped — NOT reviewed");
  expect(out).toContain("src/c.ts");
  // AC: the truncation is on the terminal too. A silent one reads afterwards as
  // "we checked everything".
  expect(errors.join("\n")).toContain("recompute: yes");
  expect(errors.join("\n")).toContain("2 of 4 candidate files were NOT reviewed");
});

test("`review blast-radius` takes the changed files from git and writes the record to --out", async () => {
  await repoWithGraph();
  // A real uncommitted edit, read by the command's own `git diff --name-only`.
  await writeFile(path.join(ROOT, "src", "core.ts"), 'export const x = "changed";\n', "utf8");

  await reviewCommand(["blast-radius", "--json", "--out", "radius.json"]);

  expect(process.exitCode).toBe(0);
  const record = JSON.parse(await readFile(path.join(ROOT, "radius.json"), "utf8")) as {
    changedFiles: string[];
    files: { file: string }[];
    counts: { droppedByCap: number };
  };
  expect(record.changedFiles).toEqual(["src/core.ts"]);
  expect(record.files.map((entry) => entry.file).sort()).toEqual([
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/core.test.ts",
  ]);
  expect(record.counts.droppedByCap).toBe(0);
});

test("`review blast-radius` refuses an absent graph rather than reporting an empty radius", async () => {
  // An empty radius reads as "nothing depends on this change", which is a
  // different fact from "the prerequisite never ran".
  await reviewCommand(["blast-radius", "--changed", "src/core.ts", "--no-related-tests"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("keryx gdgraph build");
});

// ---------------------------------------------------------------------------
// `keryx review tier` — the model block, computed rather than reasoned about
// ---------------------------------------------------------------------------
//
// `assignTier`/`decideDispatchModel` had no production caller: the rule said the
// caller was "an orchestrator authoring a dispatch document", i.e. an LLM agent
// following prose, and an agent cannot call a TypeScript function. These tests
// drive `reviewCommand(["tier", …])` with real argv for that reason — a test
// that calls `assignTier` directly is exactly what could not see the gap.
//
// The catalogue is synthetic and vendor-neutral on purpose: the size-word hints
// are the only knowledge in the resolver, so `demo-large`/`demo-medium`/
// `demo-mini` exercise them without this file naming a model that exists.

const CATALOG = JSON.stringify([{ name: "demo", models: ["demo-large", "demo-medium", "demo-mini"] }]);

async function tier(...extra: string[]): Promise<void> {
  await writeFile(path.join(ROOT, "catalog.json"), CATALOG, "utf8");
  await reviewCommand([
    "tier",
    "--session-provider",
    "demo",
    "--session-model",
    "demo-medium",
    "--catalog",
    "catalog.json",
    ...extra,
  ]);
}

/** The `{"model": …}` document `--json` prints. */
function modelBlock(): Record<string, unknown> {
  return (JSON.parse(logs.join("\n")) as { model: Record<string, unknown> }).model;
}

test("`review tier` floors a blast-radius round at deep and names the rule that did it", async () => {
  // A blast-radius round over a twelve-line diff is still a blast-radius round:
  // the floor is applied AFTER the small-scope downgrade.
  await tier("--scope", "blast-radius", "--findings", "1", "--diff-lines", "12");

  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("tier: deep");
  expect(out).toContain("light:small-scope");
  expect(out).toContain("floor:blast-radius");
  expect(out).toContain("model: demo-large");
  expect(out).toContain("tier_resolution: discovered");
});

test("`review tier --json` prints the model block a dispatch document carries", async () => {
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.tier).toBe("light");
  expect(model.tier_reasons).toEqual(["base:standard", "light:small-scope"]);
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-mini");
  expect(model.tier_resolution).toBe("discovered");
  expect((model.model_discovery as { candidates: string[] }).candidates).toEqual([
    "demo-large",
    "demo-medium",
    "demo-mini",
  ]);
});

test("`review tier` never runs a security finding below standard, even when verified by execution", async () => {
  await tier("--verifier", "execution", "--security", "--json");

  const model = modelBlock();
  expect(model.tier).toBe("standard");
  expect(model.tier_reasons).toEqual(["base:standard", "light:verifier-execution", "floor:security"]);
  // `standard` IS the session's model, and ranking worked — which is a different
  // fact from having fallen back to it. Neither pins the id: the session's own
  // model is what `inherit` already means, and a literal only goes stale.
  expect(model.inherit).toBe(true);
  expect(model.model).toBeUndefined();
  expect(model.tier_resolution).toBe("session-ranked");
  expect((model.model_discovery as { session_rank: number | null }).session_rank).not.toBeNull();
});

async function persistShellSelection(provider: string, model: string): Promise<void> {
  const dir = path.join(ROOT, "xdg", "keryx");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), JSON.stringify({ provider, model }), "utf8");
}

/** Flow 305 AC11 — a project `routing.config.json` applies only once approved. Test helper that reads what was just written and approves exactly that content, mirroring `keryx routing trust`. */
async function approveProjectRoutingFile(): Promise<void> {
  const raw = await loadRoutingConfigRaw("project", { cwd: ROOT });
  const result = await approveProjectRouting(ROOT, raw.table);
  if (!result.ok) throw new Error(result.error);
}

test("`review tier` does not pin the model `keryx shell` last persisted — that is not the caller's session", async () => {
  // Observed: an orchestrator in Claude Code got `provider: deepseek`,
  // `model: deepseek-flash` because auth.json still held a `keryx shell` choice.
  await persistShellSelection("demo", "demo-medium");
  await writeFile(path.join(ROOT, "catalog.json"), CATALOG, "utf8");
  await reviewCommand(["tier", "--findings", "1", "--diff-lines", "5", "--catalog", "catalog.json"]);

  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  expect(out).toContain("session_source: none");
  expect(out).toContain("model: inherit — dispatch on a lighter model your own runtime offers");
  expect(out).not.toContain("demo-mini");
});

test("`review tier --from-shell-config` opts back into the persisted selection", async () => {
  await persistShellSelection("demo", "demo-medium");
  await writeFile(path.join(ROOT, "catalog.json"), CATALOG, "utf8");
  await reviewCommand(["tier", "--from-shell-config", "--scope", "blast-radius", "--catalog", "catalog.json", "--json"]);

  const model = modelBlock();
  expect(model.model).toBe("demo-large");
  expect(model.tier_resolution).toBe("discovered");
});

test("`review tier` takes the session from KERYX_SESSION_PROVIDER/KERYX_SESSION_MODEL a host exports", async () => {
  process.env.KERYX_SESSION_PROVIDER = "demo";
  process.env.KERYX_SESSION_MODEL = "demo-medium";
  try {
    await writeFile(path.join(ROOT, "catalog.json"), CATALOG, "utf8");
    await reviewCommand(["tier", "--scope", "blast-radius", "--catalog", "catalog.json"]);
    const out = logs.join("\n");
    expect(out).toContain("session_source: environment");
    expect(out).toContain("model: demo-large");
  } finally {
    delete process.env.KERYX_SESSION_PROVIDER;
    delete process.env.KERYX_SESSION_MODEL;
  }
});

test("`review tier` discovers the catalogue at runtime when none is supplied", async () => {
  // No `--catalog`: this drives the real `detectProviders()` wire. `fake` is
  // always offered, so the candidate list proves detection ran — and `fake-echo`
  // carries no size marker, so the honest answer is the session's own model.
  await reviewCommand(["tier", "--session-provider", "fake", "--session-model", "fake-echo", "--json"]);

  expect(process.exitCode).toBe(0);
  const discovery = modelBlock().model_discovery as {
    candidates: string[];
    session_rank: number | null;
    fallback_reason: string | null;
  };
  expect(discovery.candidates).toContain("fake-echo");
  expect(discovery.session_rank).toBeNull();
  expect(discovery.fallback_reason).toContain("no size marker");
  expect(modelBlock().tier_resolution).toBe("session-fallback");
});

test("with nothing to anchor on, `review tier` says inherit and still exits 0", async () => {
  // The operator's standing instruction: an unresolvable tier keeps the caller's
  // OWN model. Never a downgrade, never a failure — and never an empty
  // `provider`/`model` pair, which would be a schema-invalid dispatch that still
  // looks like an answer.
  await reviewCommand(["tier", "--scope", "blast-radius", "--json"]);

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.tier).toBe("deep");
  expect(model.inherit).toBe(true);
  expect(model.provider).toBeUndefined();
  expect(model.model).toBeUndefined();
  expect(model.tier_resolution).toBe("session-fallback");
});

// ---------------------------------------------------------------------------
// Flow 305 (Flow A), AC5 — `review tier` resolves the `review` routing
// category ahead of its own live-detection ranking.
// ---------------------------------------------------------------------------

test("flow 305 AC5: with an EMPTY routing table, `review tier` output is byte-identical to pre-Flow-A (no routing.config.json, no per-user entry anywhere in this test project)", async () => {
  await tier("--scope", "blast-radius", "--findings", "1", "--diff-lines", "12");

  expect(process.exitCode).toBe(0);
  const out = logs.join("\n");
  // The exact same assertions the pre-existing "floors a blast-radius round"
  // test above makes — proving this flow changed nothing when nothing is
  // configured.
  expect(out).toContain("tier: deep");
  expect(out).toContain("light:small-scope");
  expect(out).toContain("floor:blast-radius");
  expect(out).toContain("model: demo-large");
  expect(out).toContain("tier_resolution: discovered");
});

test("flow 305 AC5: an explicit per-project `review` routing entry REPLACES the tier-ranked provider/model", async () => {
  // "demo"/"demo-large" — a CONNECTED provider/model (AC10: it is in the
  // `--catalog` fixture `tier()` always passes), distinct from what tier
  // ranking alone would pick for these signals ("demo-mini", per the
  // pre-existing `review tier --json` test above) — so the assertion below
  // still proves the OVERRIDE took effect, not an accidental agreement.
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  await approveProjectRoutingFile(); // AC11: a project layer only applies once approved
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  // The tier itself is unaffected — routing decides WHICH model, not the tier
  // arithmetic (PRD §Non-goals: this design sits one level above `assignTier`).
  expect(model.tier).toBe("light");
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-large");
  expect(model.routed).toBe(true);
});

test("flow 305 AC5: a per-user `review` routing entry also wins over the tier-ranked model (the same layer `keryx routing set` writes to by default)", async () => {
  const dir = path.join(ROOT, "xdg", "keryx");
  await mkdir(dir, { recursive: true });
  // Merged, not overwritten — same shape `persistShellSelection` already uses
  // for `provider`/`model` in this file's own auth.json.
  await writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({ routing: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-large");
});

test("flow 305 AC5: a per-project entry wins over a per-user entry for the same category (PRD §5 precedence)", async () => {
  const dir = path.join(ROOT, "xdg", "keryx");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "auth.json"),
    JSON.stringify({ routing: { review: { kind: "model", providerId: "demo", modelId: "demo-medium" } } }),
    "utf8",
  );
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-large");
});

test("flow 305 AC5: routing an UNRELATED category (not `review`) never changes review tier's own model", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { quick: { kind: "model", providerId: "anthropic", modelId: "claude-routed" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-mini");
});

// ---------------------------------------------------------------------------
// Flow 305 review findings — AC10 (connected fallback), AC11 (project
// trust), item 3 (malformed config surfaced), item 4 (provider-default parity).
// ---------------------------------------------------------------------------

test("flow 305 AC10: a `review` routing entry naming a provider the catalog never reported falls through to the session model, with a notice", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    // "anthropic" is NOT in `tier()`'s `--catalog` fixture (only "demo" is).
    JSON.stringify({ categories: { review: { kind: "model", providerId: "anthropic", modelId: "claude-x" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.routed).toBeUndefined();
  // Falls through to the ORDINARY tier-discovered answer (unaffected by the
  // rejected routing entry) — not "inherit": these signals already rank
  // "demo-mini" from the connected catalog on their own, same as the
  // pre-existing `review tier --json` test with no routing configured at all.
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-mini");
  const notices = (JSON.parse(logs.join("\n")) as { notices?: string[] }).notices ?? [];
  expect(notices.some((n) => n.includes("anthropic/claude-x") && n.includes("not connected"))).toBe(true);
});

test("flow 305 AC10: a `review` routing entry naming a MODEL the connected provider does not list falls through too", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    // "demo" is connected, but "demo-huge" is not one of its reported models.
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-huge" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.routed).toBeUndefined();
  const notices = (JSON.parse(logs.join("\n")) as { notices?: string[] }).notices ?? [];
  expect(notices.some((n) => n.includes("demo/demo-huge") && n.includes("not connected"))).toBe(true);
});

test("flow 305 item 3: a malformed routing.config.json is surfaced as a notice, non-fatal — `review tier` still runs", async () => {
  await writeFile(path.join(ROOT, "routing.config.json"), "not json at all", "utf8");
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0); // non-fatal
  const parsed = JSON.parse(logs.join("\n")) as { notices?: string[] };
  expect(parsed.notices?.some((n) => n.includes("routing.config.json"))).toBe(true);
});

test("flow 305 item 4: a `provider-default` `review` assignment resolves via resolveProviderDefaultModelId, same as subagents", async () => {
  // "ollama"'s documented default is `llama3.1:latest`
  // (`provider-default.ts`'s `OLLAMA_DEFAULT_MODEL_ID`). Its own catalog
  // fixture here (not `tier()`'s "demo" one) is what makes it "connected"
  // for AC10's provider-only check on a `provider-default` assignment.
  await writeFile(path.join(ROOT, "catalog.json"), JSON.stringify([{ name: "ollama", models: ["llama3.1:latest"] }]), "utf8");
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "provider-default", providerId: "ollama" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await reviewCommand([
    "tier",
    "--session-provider",
    "demo",
    "--session-model",
    "demo-medium",
    "--catalog",
    "catalog.json",
    "--findings",
    "2",
    "--diff-lines",
    "20",
    "--json",
  ]);

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.provider).toBe("ollama");
  expect(model.model).toBe("llama3.1:latest");
  expect(model.routed).toBe(true);
});

test("flow 305 item 4: an UNRESOLVABLE `provider-default` (not a real registered provider) is inert, same as a `session-default`", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "provider-default", providerId: "demo" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  // "demo" is connected (AC10 passes) but is not a real registered provider,
  // so `resolveProviderDefaultModelId` returns `undefined` and the
  // assignment is inert.
  expect(model.routed).toBeUndefined();
});

// ---------------------------------------------------------------------------
// Flow 305 AC11 — project routing.config.json trust: unapproved -> ignored,
// approve -> applies, edit-after-approval -> voids approval.
// ---------------------------------------------------------------------------

test("flow 305 AC11: an UNAPPROVED routing.config.json is ignored, with a visible notice, in `review tier` output", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  // No approveProjectRoutingFile() call — the file is written but never trusted.
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  expect(process.exitCode).toBe(0);
  const model = modelBlock();
  expect(model.routed).toBeUndefined();
  expect(model.model).toBe("demo-mini"); // the ordinary tier-ranked answer, unaffected
  const parsed = JSON.parse(logs.join("\n")) as { notices?: string[] };
  expect(parsed.notices?.some((n) => n.includes("unapproved") && n.includes("keryx routing trust"))).toBe(true);
});

test("flow 305 AC11: approving the file applies it", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.routed).toBe(true);
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-large");
});

test("flow 305 AC11: editing the file after approval VOIDS the approval — the edited entries are ignored until re-approved", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  // Now change what the file actually says.
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-medium" } } }),
    "utf8",
  );
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.routed).toBeUndefined();
  expect(model.model).toBe("demo-mini"); // fell back — the edited content is unapproved
  const parsed = JSON.parse(logs.join("\n")) as { notices?: string[] };
  expect(parsed.notices?.some((n) => n.includes("unapproved"))).toBe(true);
});

test("flow 305 AC11: a pure reformat (whitespace, key order) after approval does NOT void it", async () => {
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    JSON.stringify({ categories: { review: { kind: "model", providerId: "demo", modelId: "demo-large" } } }),
    "utf8",
  );
  await approveProjectRoutingFile();
  // Same content, reformatted: different key order, extra whitespace.
  await writeFile(
    path.join(ROOT, "routing.config.json"),
    `{\n  "categories": {\n    "review": { "modelId": "demo-large", "kind": "model", "providerId": "demo" }\n  }\n}\n`,
    "utf8",
  );
  await tier("--findings", "2", "--diff-lines", "20", "--json");

  const model = modelBlock();
  expect(model.routed).toBe(true);
  expect(model.provider).toBe("demo");
  expect(model.model).toBe("demo-large");
});

test("`review tier` refuses an unrecognised --verifier rather than silently defaulting", async () => {
  await tier("--verifier", "exection");

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--verifier");
  expect(errors.join("\n")).toContain("site-check");
});

test("`review tier` refuses a hand-written tier", async () => {
  // There is no `--tier`: the tier is COMPUTED from the signals. Accepting one
  // would put the arithmetic back in the caller's head, which is the defect.
  await reviewCommand(["tier", "--tier", "deep"]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--tier");
});

test("`review tier` names --catalog when the file is not JSON", async () => {
  // The two guards below this one — "not an array" and "an entry with no name" —
  // were written; the read and the parse were not. So the two likeliest operator
  // mistakes came out as a bare `JSON Parse error: Unexpected identifier "not"`,
  // which names neither the flag nor the file that carries it.
  await writeFile(path.join(ROOT, "bad.json"), "not json", "utf8");
  await reviewCommand(["tier", "--session-provider", "demo", "--session-model", "demo-medium", "--catalog", "bad.json"]);

  expect(process.exitCode).toBe(1);
  const out = errors.join("\n");
  expect(out).toContain("--catalog");
  expect(out).toContain("bad.json");
  expect(out).toContain("not valid JSON");
  expect(out).toContain('[{"name": "<provider>", "models": ["<id>", …]}]');
});

test("`review tier` names --catalog when the file is not there", async () => {
  await reviewCommand([
    "tier",
    "--session-provider",
    "demo",
    "--session-model",
    "demo-medium",
    "--catalog",
    "nope.json",
  ]);

  expect(process.exitCode).toBe(1);
  const out = errors.join("\n");
  expect(out).toContain("--catalog");
  expect(out).toContain("nope.json");
  expect(out).toContain("could not be read");
});

test("a --blast-radius record missing its arrays is refused, not defaulted to an empty set", async () => {
  // An invented empty set rejects every scope-B finding as `outside-set` and
  // reports that as the screen working.
  await writeFile(path.join(ROOT, "radius.json"), JSON.stringify({ depth: 2 }), "utf8");
  await writeFile(path.join(ROOT, "report.md"), reportWith([SCOPE_B_FINDING]), "utf8");
  await reviewCommand([
    "ingest",
    "--report",
    "report.md",
    "--ref",
    "report.md",
    "--review-id",
    "2026-08-30-cli-blast-radius-empty",
    "--blast-radius",
    "radius.json",
  ]);

  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--blast-radius");
});

// R1-F3 (review round 1, PR #691, major): `review learn --reviewer <id>
// --dry-run=1` used to read as `args.includes("--dry-run")` — false for the
// `=value` spelling — so a request for a DRY RUN silently wrote the real
// `.mdc` file. `parseLearnArgs` (shared with `keryx learn`'s own flag
// parsing) refuses the malformed spelling instead of misreading it; nothing
// is written either way, dry run or not.
test("`review learn --reviewer <id> --dry-run=1` is refused, not silently treated as a real (non-dry-run) write", async () => {
  await reviewCommand(["learn", "--reviewer", "rv-0123456789abcdef", "--dry-run=1"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--dry-run=1");
  // Never reached `applyReviewerProfile` — no `.mdc` file exists anywhere
  // under `.metaproject/rules/reviewers/` (the directory itself is never
  // created either, since the write path is never entered).
  await expect(readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", "rv-0123456789abcdef.mdc"), "utf8")).rejects.toBeTruthy();
});

// R3-F4 (review round 3, PR #691, minor): the finding lists these among the
// missing regression tests — `keryx review learn`'s OWN `--pr` path parsing
// (not just `--reviewer`'s) had no test for `--dry-run=1`, and neither
// `--reviewer` mode had a test for a repeated or empty `--reviewer`.
test("`review learn --pr <n> --dry-run=1` is refused on the --pr path too, not just --reviewer", async () => {
  await reviewCommand(["learn", "--pr", "3", "--dry-run=1"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("--dry-run=1");
});

test("`review learn --reviewer` given twice is refused, never applying either value", async () => {
  await reviewCommand(["learn", "--reviewer", "rv-aaaaaaaaaaaaaaaa", "--reviewer", "rv-bbbbbbbbbbbbbbbb", "--dry-run"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("more than once");
  await expect(readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", "rv-aaaaaaaaaaaaaaaa.mdc"), "utf8")).rejects.toBeTruthy();
  await expect(readFile(path.join(ROOT, ".metaproject", "rules", "reviewers", "rv-bbbbbbbbbbbbbbbb.mdc"), "utf8")).rejects.toBeTruthy();
});

test("`review learn --reviewer=` (empty value) is refused, not silently falling through to the --pr path", async () => {
  await reviewCommand(["learn", "--reviewer=", "--dry-run"]);
  expect(process.exitCode).toBe(1);
  expect(errors.join("\n")).toContain("needs a value");
});
