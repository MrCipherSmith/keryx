// Flow 204 — the `review comments` flags, driven through the real CLI.
//
// `pr-comments.test.ts` covers `enforceReplyBrevity` and `buildReplyPass`
// thoroughly, and every one of those tests passed while the character ceiling was
// unreachable from a terminal: the library accepted `maxChars`,
// `COMMENTS_REPLY_FLAGS` did not list `--max-chars`, so the one bound that stops a
// 4,000-character single sentence could only be set by a caller writing
// TypeScript. A test that calls `enforceReplyBrevity` directly exercises the
// ENFORCER. It cannot notice that the CLI never passes the option.
//
// The same hole was measured for the other two bounds: `--max-sentences` had no
// coverage at any level, and `--max-replies` was exercised only through direct
// `buildReplyPass()` calls. Disconnecting the `maxSentences` forwarding at the
// parse site left the whole suite green.
//
// So this suite passes each flag the way the operator would — as a string in
// `argv` — and asserts on what the command PRINTS or WRITES. Delete a flag from
// the allowlist and the run fails on an unknown flag; drop it at the parse site
// and the bound silently reverts to its default, which is what these assertions
// catch.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";
import type { PrCommentState } from "../review/pr-comments";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

/** The head the collection and the reply pass claim to be true of. */
const SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

let ROOT = "";
let logs: string[] = [];

function output(): string {
  return logs.join("\n");
}

/** One inline review comment, long enough that only a ceiling can bound it. */
const ONE_LONG_SENTENCE =
  `This whole reply is deliberately a single sentence, with no full stop anywhere inside it, ` +
  `so that the sentence budget passes it through verbatim and the only thing standing between ` +
  `the reviewer and a wall of text is the character ceiling that this test exists to reach ` +
  `from the command line rather than from a TypeScript caller.`;

/** Three sentences, which only the SENTENCE budget can cut. */
const THREE_SENTENCES = "Fixed in abc1234. The writer now checks the mode. A regression test covers it.";

const FLOW_LINK = "https://example.invalid/flow/204";

/**
 * A fixture directory with `count` inline review comments and one outcome each.
 *
 * The first comment always carries {@link ONE_LONG_SENTENCE}, so the reply the
 * printer emits first is the one the character-ceiling tests measure.
 */
async function fixtureDir(count = 1): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-review-comments-cli-"));
  await writeFile(
    path.join(ROOT, "pull-comments.json"),
    JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        user: { login: "reviewer" },
        body: "Does this handle the empty case?",
        html_url: `https://github.com/o/r/pull/7#discussion_r${index + 1}`,
        path: "src/a.ts",
        line: 3 + index,
        created_at: "2026-08-30T00:00:00Z",
      })),
    ),
    "utf8",
  );
  await writeFile(path.join(ROOT, "pull-reviews.json"), "[]", "utf8");
  await writeFile(path.join(ROOT, "issue-comments.json"), "[]", "utf8");
  await writeFile(
    path.join(ROOT, "outcomes.json"),
    JSON.stringify(
      Array.from({ length: count }, (_, index) => ({
        comment: `review-comment:${index + 1}`,
        disposition: "acted-on",
        text: index === 0 ? ONE_LONG_SENTENCE : "Fixed.",
        link: FLOW_LINK,
      })),
    ),
    "utf8",
  );
  await writeFile(
    path.join(ROOT, "outcomes-multi.json"),
    JSON.stringify([
      { comment: "review-comment:1", disposition: "acted-on", text: THREE_SENTENCES, link: FLOW_LINK },
    ]),
    "utf8",
  );
  process.chdir(ROOT);
  logs = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
}

async function reply(extra: string[], outcomes = "outcomes.json"): Promise<void> {
  await reviewCommand([
    "comments",
    "reply",
    "--repo",
    "o/r",
    "--pr",
    "7",
    "--sha",
    SHA,
    "--self",
    "us",
    "--final",
    "--dry-run",
    "--fixtures",
    ROOT,
    "--outcomes",
    path.join(ROOT, outcomes),
    ...extra,
  ]);
}

async function collect(extra: string[]): Promise<void> {
  await reviewCommand(["comments", "collect", "--repo", "o/r", "--pr", "7", "--self", "us", "--fixtures", ROOT, ...extra]);
}

/**
 * The bodies of the replies the pass would post, in order.
 *
 * Read from the printer's own output — `POST <path>` and the body indented under
 * it — rather than from a marker inside the text, so a body the budget rewrote
 * beyond recognition is still found.
 */
function postedBodies(): string[] {
  const bodies: string[] = [];
  logs.forEach((line, index) => {
    if (line.startsWith("POST ")) {
      bodies.push((logs[index + 1] ?? "").trim());
    }
  });
  return bodies;
}

function postedBody(): string {
  const first = postedBodies()[0];
  if (first === undefined) {
    throw new Error(`no reply body in output:\n${output()}`);
  }
  return first;
}

async function readState(): Promise<PrCommentState> {
  const file = path.join(ROOT, ".metaproject", "reviews", "pr-comments", "o__r__7.json");
  return JSON.parse(await readFile(file, "utf8")) as PrCommentState;
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

// --- --max-chars ------------------------------------------------------------

test("--max-chars from argv cuts the body the sentence budget passes through", async () => {
  await fixtureDir();
  await reply(["--max-chars", "120"]);

  const body = postedBody();
  expect(body.length).toBeLessThanOrEqual(120);
  // The cut carries the link, or the explanation exists nowhere the reviewer can reach.
  expect(body).toContain(FLOW_LINK);
  expect(body).toContain("…");
  expect(output()).toContain("posted: 0");
});

test("without --max-chars the same reply keeps the default 600-character ceiling", async () => {
  await fixtureDir();
  await reply([]);

  const body = postedBody();
  // Under the default ceiling the one long sentence survives whole — which is
  // exactly why the flag has to be reachable to bound it.
  expect(body.length).toBeGreaterThan(120);
  expect(body.length).toBeLessThanOrEqual(600 + FLOW_LINK.length + 1);
  expect(body).not.toContain("…");
});

// `reviewCommand` reports a refusal by printing it and setting a non-zero exit
// code, not by rejecting — so these assert on what the operator would see.
test("--max-chars is rejected below one rather than posting silence", async () => {
  await fixtureDir();
  await reply(["--max-chars", "0"]);

  expect(output()).toContain("zero characters is silence");
  expect(process.exitCode).toBe(1);
});

test("an unknown reply flag is still refused", async () => {
  await fixtureDir();
  await reply(["--max-charrs", "120"]);

  expect(output()).toContain("--max-charrs");
  expect(process.exitCode).toBe(1);
});

// --- --max-sentences --------------------------------------------------------

test("--max-sentences from argv cuts a reply the character ceiling would pass whole", async () => {
  // The bound with no coverage at any level: disconnecting its forwarding at the
  // parse site left 87 of 87 tests green. `THREE_SENTENCES` is far inside the
  // 600-character ceiling, so only the sentence budget can cut it.
  await fixtureDir();
  await reply(["--max-sentences", "1"], "outcomes-multi.json");

  const body = postedBody();
  expect(body).toContain("Fixed in abc1234.");
  expect(body).not.toContain("The writer now checks the mode.");
  expect(body).not.toContain("A regression test covers it.");
  // A truncation always carries the link, or the dropped explanation is unreachable.
  expect(body).toContain(FLOW_LINK);
});

test("without --max-sentences the same reply keeps the default two-sentence budget", async () => {
  await fixtureDir();
  await reply([], "outcomes-multi.json");

  const body = postedBody();
  expect(body).toContain("The writer now checks the mode.");
  expect(body).not.toContain("A regression test covers it.");
});

test("--max-sentences is rejected below one rather than posting silence", async () => {
  await fixtureDir();
  await reply(["--max-sentences", "0"], "outcomes-multi.json");

  expect(output()).toContain("zero sentences is silence");
  expect(process.exitCode).toBe(1);
});

// --- --max-replies ----------------------------------------------------------

test("--max-replies from argv caps individual replies and reports the backlog", async () => {
  // Only ever exercised through direct `buildReplyPass({ maxReplies })` calls,
  // which cannot see whether the CLI forwards the flag.
  await fixtureDir(2);
  await reply(["--max-replies", "1", "--flow-link", FLOW_LINK]);

  const bodies = postedBodies();
  // One individual reply plus exactly one overflow summary — never one comment
  // per backlogged item.
  expect(bodies).toHaveLength(2);
  expect(bodies[1]).toContain("reply cap of 1 was reached");
  expect(bodies[1]).toContain(FLOW_LINK);
  expect(output()).toContain("backlog beyond the reply cap: 1 — review-comment:2");
});

test("without --max-replies both comments are answered individually", async () => {
  await fixtureDir(2);
  await reply(["--flow-link", FLOW_LINK]);

  expect(postedBodies()).toHaveLength(2);
  expect(output()).toContain("backlog beyond the reply cap: 0");
});

// --- `comments collect` -----------------------------------------------------

test("`comments collect` writes the durable record the review gate reads, dated", async () => {
  // The command that writes the file `review-gate` condition 4 depends on had no
  // test driving it through the CLI at all. `collected_sha` is the field that
  // lets the gate tell a current collection from one that ran before the
  // comments arrived — `rounds_collected` is a count and cannot.
  await fixtureDir();
  await collect(["--sha", SHA, "--round", "2"]);

  const state = await readState();
  expect(state.repo).toBe("o/r");
  expect(state.number).toBe(7);
  expect(state.rounds_collected).toBe(2);
  expect(state.collected_sha).toBe(SHA);
  expect(state.collected_round).toBe(2);
  expect(state.seen.map((entry) => entry.id)).toEqual(["review-comment:1"]);
  expect(state.handled_comments).toEqual([]);
  expect(output()).toContain(`collected against: ${SHA} (round 2)`);
  expect(output()).toContain("unanswered so far: 1");
});

test("`comments collect` refuses without --sha: an undated collection cannot be shown current", async () => {
  await fixtureDir();
  await collect([]);

  expect(output()).toContain("`--sha` is required");
  expect(process.exitCode).toBe(1);
});

test("`comments collect --sha` refuses a value that is not a commit SHA", async () => {
  await fixtureDir();
  await collect(["--sha", "HEAD"]);

  expect(output()).toContain("is not a commit SHA");
  expect(process.exitCode).toBe(1);
});
