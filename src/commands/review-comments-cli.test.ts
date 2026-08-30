// Flow 204 — the reply flags, driven through the real CLI.
//
// `pr-comments.test.ts` covers `enforceReplyBrevity` thoroughly, and every one of
// those tests passed while the character ceiling was unreachable from a terminal:
// the library accepted `maxChars`, `COMMENTS_REPLY_FLAGS` did not list
// `--max-chars`, so the one bound that stops a 4,000-character single sentence
// could only be set by a caller writing TypeScript. A test that calls
// `enforceReplyBrevity` directly exercises the ENFORCER. It cannot notice that
// the CLI never passes the option.
//
// So this suite passes the flag the way the operator would — as a string in
// `argv` — and asserts on what the command PRINTS. Delete `--max-chars` from the
// allowlist and the run fails on an unknown flag; drop it at the parse site and
// the over-long body comes back whole.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { reviewCommand } from "./review";

const ORIGINAL_CWD = process.cwd();
const realLog = console.log;
const realError = console.error;

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

async function fixtureDir(): Promise<void> {
  ROOT = await mkdtemp(path.join(tmpdir(), "keryx-review-comments-cli-"));
  await writeFile(
    path.join(ROOT, "pull-comments.json"),
    JSON.stringify([
      {
        id: 1,
        user: { login: "reviewer" },
        body: "Does this handle the empty case?",
        html_url: "https://github.com/o/r/pull/7#discussion_r1",
        path: "src/a.ts",
        line: 3,
        created_at: "2026-08-30T00:00:00Z",
      },
    ]),
    "utf8",
  );
  await writeFile(path.join(ROOT, "pull-reviews.json"), "[]", "utf8");
  await writeFile(path.join(ROOT, "issue-comments.json"), "[]", "utf8");
  await writeFile(
    path.join(ROOT, "outcomes.json"),
    JSON.stringify([
      {
        comment: "review-comment:1",
        disposition: "acted-on",
        text: ONE_LONG_SENTENCE,
        link: "https://example.invalid/flow/204",
      },
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

async function reply(extra: string[]): Promise<void> {
  await reviewCommand([
    "comments",
    "reply",
    "--repo",
    "o/r",
    "--pr",
    "7",
    "--sha",
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    "--self",
    "us",
    "--final",
    "--dry-run",
    "--fixtures",
    ROOT,
    "--outcomes",
    path.join(ROOT, "outcomes.json"),
    ...extra,
  ]);
}

/** The body of the single reply the pass would post, without the printer's indent. */
function postedBody(): string {
  const line = logs.find((entry) => entry.trimStart().startsWith("This whole reply"));
  if (line === undefined) {
    throw new Error(`no reply body in output:\n${output()}`);
  }
  return line.trim();
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

test("--max-chars from argv cuts the body the sentence budget passes through", async () => {
  await fixtureDir();
  await reply(["--max-chars", "120"]);

  const body = postedBody();
  expect(body.length).toBeLessThanOrEqual(120);
  // The cut carries the link, or the explanation exists nowhere the reviewer can reach.
  expect(body).toContain("https://example.invalid/flow/204");
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
  expect(body.length).toBeLessThanOrEqual(600 + "https://example.invalid/flow/204".length + 1);
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
