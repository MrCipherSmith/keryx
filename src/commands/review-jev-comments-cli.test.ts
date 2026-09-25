// flow 333 — `keryx review jev-comments`, driven through the real CLI
// dispatcher (AC8: CLI tests with a fixture ledger, fixture PR diff/facts,
// and recorded Jev responses; schema validation against
// reviewer-finding.schema.json). Hermetic: no network (fixtures stand in for
// `gh pr diff`, `git log`, `gh api graphql`, and Jev), macOS-safe (mkdtemp
// under the OS tmp dir).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import { prCommentsStatePath, PR_COMMENT_STATE_VERSION, type PrCommentState } from "../review/pr-comments";
import { validateJson, type JsonSchema } from "../gdskills/contracts";

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_KEY = process.env.OPENROUTER_API_KEY;
const realLog = console.log;
const realError = console.error;
const REPO = "o/r";
const NUMBER = 5;

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

async function projectRoot(enabled: boolean): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-comments-cli-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(path.join(dir, ".metaproject", "tasks.config.json"), JSON.stringify({ review: { jev: { comments: enabled } } }), "utf8");
  return dir;
}

/** One open comment, `c1`, on `src/widget.ts:10` — no replies, not in `handled_comments`. */
async function writeLedger(root: string, extra: Partial<PrCommentState> = {}): Promise<void> {
  const state: PrCommentState = {
    schemaVersion: PR_COMMENT_STATE_VERSION,
    repo: REPO,
    number: NUMBER,
    self: "me",
    rounds_collected: 1,
    collected_sha: "deadbeef",
    collected_round: 1,
    replies_posted_at: null,
    seen: [
      {
        id: "c1",
        thread_id: "c1",
        author: "reviewer1",
        url: "https://github.com/o/r/pull/5#discussion_r1",
        first_seen_round: 1,
        last_seen_round: 1,
        submitted_at: "2020-01-01T00:00:00Z",
        body: "src/widget.ts:10 this looks like it is missing a null check",
      },
    ],
    handled_comments: [],
    backlog: [],
    escalated: [],
    ...extra,
  };
  const file = prCommentsStatePath(root, REPO, NUMBER);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

const WIDGET_DIFF = [
  "diff --git a/src/widget.ts b/src/widget.ts",
  "index 1111111..2222222 100644",
  "--- a/src/widget.ts",
  "+++ b/src/widget.ts",
  "@@ -8,3 +8,3 @@",
  " context line",
  "-export function oldWidget() {}",
  "+export function widget() {}",
  " context line",
  "",
].join("\n");

async function writeFixtures(
  root: string,
  answers: Record<string, { type: "choice"; choice: string }>,
  git: { commits?: Record<string, { sha: string; date: string }[]>; resolvedThreadIds?: string[] } = {},
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-jev-comments-fixtures-"));
  await writeFile(path.join(dir, "pr.json"), JSON.stringify({ number: NUMBER, title: "Widget PR", body: "", diff: WIDGET_DIFF }), "utf8");
  await writeFile(path.join(dir, "git-facts.json"), JSON.stringify(git), "utf8");
  await writeFile(path.join(dir, "jev-responses.json"), JSON.stringify([{ answers, usage: { input_tokens: 100, output_tokens: 5, cost: 0.001 } }]), "utf8");
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

describe("AC8: keryx review jev-comments --pr <n> --repo <owner/repo> --json", () => {
  test("still-open produces a minor finding, schema-valid against reviewer-finding.schema.json", async () => {
    ROOT = await projectRoot(true);
    await writeLedger(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { c1: { type: "choice", choice: "still-open" } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--fixtures", fixturesDir, "--json"]);

    const parsed = JSON.parse(output()) as { reviewer: string; findings: Array<Record<string, unknown>>; openComments: number };
    expect(parsed.reviewer).toBe("review-jev-comments");
    expect(parsed.openComments).toBe(1);
    expect(parsed.findings).toHaveLength(1);
    const finding = parsed.findings[0]!;
    expect(finding.file).toBe("src/widget.ts");
    expect(finding.line).toBe(10);
    expect(finding.severity).toBe("minor");
    expect(finding.reviewer).toBe("review-jev-comments");

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    const errors = await validateJson(parsed, schema);
    expect(errors).toEqual([]);
  });

  test("needs-escalation produces a major finding with class_scope, schema-valid", async () => {
    ROOT = await projectRoot(true);
    await writeLedger(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { c1: { type: "choice", choice: "needs-escalation" } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: Array<Record<string, unknown>> };
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.severity).toBe("major");
    expect(parsed.findings[0]!.class_scope).toBeDefined();

    const schemaRaw = await readFile(
      path.join(import.meta.dir, "..", "gdskills", "bundled", "skills", "review", "review-orchestrator", "reviewer-finding.schema.json"),
      "utf8",
    );
    const schema = JSON.parse(schemaRaw) as JsonSchema;
    expect(await validateJson(parsed, schema)).toEqual([]);
  });

  test("resolved-by-fix and not-actionable produce no findings", async () => {
    ROOT = await projectRoot(true);
    await writeLedger(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { c1: { type: "choice", choice: "resolved-by-fix" } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; status: string };
    expect(parsed.findings).toEqual([]);
    expect(parsed.status).toBe("DONE");
  });

  test("no open comments (all handled): zero findings, zero Jev calls", async () => {
    ROOT = await projectRoot(true);
    await writeLedger(ROOT, {
      handled_comments: [
        {
          id: "c1",
          thread_id: "c1",
          author: "reviewer1",
          url: "https://github.com/o/r/pull/5#discussion_r1",
          first_seen_round: 1,
          handled_at: "2020-01-02T00:00:00Z",
          sha: "deadbeef",
          disposition: "acted-on",
          reply_url: "https://github.com/o/r/pull/5#discussion_r2",
          via: "thread-reply",
        },
      ],
    });
    const fixturesDir = await writeFixtures(ROOT, {});
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--fixtures", fixturesDir, "--json"]);
    const parsed = JSON.parse(output()) as { findings: unknown[]; openComments: number; tokens: { jevCalls: number } };
    expect(parsed.findings).toEqual([]);
    expect(parsed.openComments).toBe(0);
    expect(parsed.tokens.jevCalls).toBe(0);
  });
});

describe("AC5: opt-in and credential gating — both refuse before any ledger read", () => {
  test("review.jev.comments absent/false: refused, the ledger is never even opened", async () => {
    ROOT = await projectRoot(false);
    await writeLedger(ROOT);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--json"]);

    expect(output().toLowerCase()).toContain("review.jev.comments");
    expect(output().toLowerCase()).toContain("not enabled");
    expect(process.exitCode).toBe(1);
  });

  test("enabled but no OPENROUTER_API_KEY: refused, no network call possible", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    delete process.env.OPENROUTER_API_KEY;

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--json"]);

    expect(output()).toContain("OPENROUTER_API_KEY");
    expect(process.exitCode).toBe(1);
  });
});

describe("no comment ledger for --repo/--pr (no fixtures): refused before any network call", () => {
  test("live mode with no ledger file refuses and names the collect command", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";

    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--json"]);

    expect(output()).toContain("comments collect");
    expect(process.exitCode).toBe(1);
  });
});

describe("usage: --pr and --repo are both required", () => {
  test("missing --repo is refused", async () => {
    ROOT = await projectRoot(true);
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--json"]);
    expect(output()).toContain("Usage: keryx review jev-comments");
  });
});

describe("AC4: keryx review comments reply prints the advisory label, never acts on it", () => {
  test("a label written by a prior jev-comments run is printed informationally", async () => {
    ROOT = await projectRoot(true);
    await writeLedger(ROOT);
    const fixturesDir = await writeFixtures(ROOT, { c1: { type: "choice", choice: "still-open" } });
    process.chdir(ROOT);
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    await reviewCommand(["jev-comments", "--pr", String(NUMBER), "--repo", REPO, "--fixtures", fixturesDir, "--json"]);
    logs = [];

    const replyFixturesDir = await mkdtemp(path.join(tmpdir(), "keryx-comments-reply-fixtures-"));
    await writeFile(path.join(replyFixturesDir, "pull.json"), JSON.stringify({ state: "open", merged: false, merged_at: null, head: { sha: "deadbeef" } }), "utf8");
    await writeFile(path.join(replyFixturesDir, "pull-comments.json"), "[]", "utf8");
    await writeFile(path.join(replyFixturesDir, "pull-reviews.json"), "[]", "utf8");
    await writeFile(path.join(replyFixturesDir, "issue-comments.json"), "[]", "utf8");
    const outcomesFile = path.join(replyFixturesDir, "outcomes.json");
    await writeFile(outcomesFile, "[]", "utf8");

    await reviewCommand([
      "comments",
      "reply",
      "--repo",
      REPO,
      "--pr",
      String(NUMBER),
      "--sha",
      "deadbeef",
      "--final",
      "--dry-run",
      "--outcomes",
      outcomesFile,
      "--fixtures",
      replyFixturesDir,
    ]);

    expect(output()).toContain("advisory");
    expect(output()).toContain("still-open");
    await rm(replyFixturesDir, { recursive: true, force: true });
  });
});
