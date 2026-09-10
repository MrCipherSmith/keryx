import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * AC2 of flow 213, demonstrated the way the criterion demands: by running a
 * violating payload through the real command and watching it refuse, "not by a
 * unit test over the schema alone".
 *
 * The distinction is the whole point of the flow. A schema test proves the
 * schema says something. It cannot prove anything loads the schema — and for
 * eight of the eleven registered contracts, nothing does. Only running the
 * command shows the refusal exists.
 *
 * `src/cli.ts` is spawned from the working tree, never the installed `keryx`,
 * which is a released build that predates this enforcement and would pass or
 * fail for reasons unrelated to the change.
 */
const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function runReply(resultPath: string, extra: string[] = []): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI,
      "review",
      "comments",
      "reply",
      "--repo",
      "owner/repo",
      "--pr",
      "1",
      "--sha",
      "0123abc",
      "--outcomes",
      resultPath, // never read: the refusal happens before outcomes are parsed
      "--result",
      resultPath,
      ...extra,
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1" } },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** A result that satisfies every required field, so only the conditional decides. */
function baseResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "DONE",
    mode: "analyze",
    pr: "owner/repo#1",
    head_sha: "0123abcdef0123abcdef0123abcdef0123abcdef",
    collected: 0,
    verdicts: { valid: 0, "out-of-scope": 0 },
    plan_items: 0,
    summary: "nothing to do",
    screen_status: "ran",
    screened: 0,
    excluded_for_injection: [],
    filtered: [],
    ...over,
  };
}

describe("review-pr-feedback-output is refused at a keryx-owned write path", () => {
  test("an analyze-mode result carrying a populated fix is refused, naming the field, and posts nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-result-contract-"));
    try {
      const file = path.join(dir, "result.json");
      // The payload AC2 names. Before the conditional was expressed, this
      // validated clean: the rule "Present in fix mode only. Null in analyze
      // mode" lived in the `fix` property's DESCRIPTION, where no validator
      // reads it.
      await writeFile(
        file,
        JSON.stringify(
          baseResult({
            mode: "analyze",
            fix: {
              flow_id: "244",
              flow_status: "done",
              merged_into: "main",
              operator_confirmed: true,
            },
          }),
        ),
        "utf8",
      );

      const { code, stdout, stderr } = await runReply(file);
      const output = `${stdout}${stderr}`;

      expect(code).not.toBe(0);
      expect(output).toContain("review-pr-feedback-output");
      // The failing field by name, not a count.
      expect(output).toContain("fix");
      // The success header never printed, so the pass was not built and
      // nothing reached the pull request. Asserting on the absence of
      // "posted:" would be wrong: the refusal's own message ends with "so
      // nothing was posted:".
      expect(output).not.toContain("# review comments reply");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test("a result claiming the injection screen never ran while excluding comments is refused", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-result-contract-"));
    try {
      const file = path.join(dir, "result.json");
      await writeFile(
        file,
        JSON.stringify(
          baseResult({
            screen_status: "unavailable",
            screened: 2,
            excluded_for_injection: ["c1"],
          }),
        ),
        "utf8",
      );

      const { code, stdout, stderr } = await runReply(file);
      expect(code).not.toBe(0);
      expect(`${stdout}${stderr}`).toContain("review-pr-feedback-output");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // Anti-vacuity: the two tests above would pass just as well if the command
  // refused everything, or refused for some unrelated reason such as a missing
  // flag. A conforming result must get PAST the contract check.
  test("a conforming analyze-mode result passes the contract check and fails later, if at all", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-result-contract-"));
    try {
      const file = path.join(dir, "result.json");
      await writeFile(file, JSON.stringify(baseResult({ mode: "analyze", fix: null })), "utf8");

      const { stdout, stderr } = await runReply(file);
      const output = `${stdout}${stderr}`;

      // Whatever else happens — this run has no tracker and no real pull
      // request — it must not be the contract that rejected it.
      expect(output).not.toContain("does not satisfy the review-pr-feedback-output contract");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
