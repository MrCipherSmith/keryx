// `keryx agents external review|apply|discard` (flow 370, AC5). A real temp git repo; a
// write run is seeded the way write-run.ts stores it, and the confirmation prompt and
// the terminal checks are driven through the run seams. No claude binary is involved.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EXTERNAL_WRITE_PATCH_FILE, EXTERNAL_WRITE_RUN_FILE, type ExternalWriteRunRecord } from "../harness/external/write-run";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { createSession, EXTERNAL_RUN_PROVIDER_PREFIX } from "../session/store";
import { agentsExternalCommand, renderRunOutcome, type AgentsExternalDeps, type AgentsExternalRunSeams } from "./agents-external";

const GIT_ENV = withoutGitDiscoveryOverrides(process.env);

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

let root = "";
let repo = "";
let dataDir = "";
let baseCommit = "";
let out: string[] = [];
let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-ext-write-cli-")));
  repo = path.join(root, "repo");
  dataDir = path.join(root, "data");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "operator@example.com");
  git(repo, "config", "user.name", "Operator");
  writeFileSync(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  baseCommit = git(repo, "rev-parse", "HEAD").trim();
  out = [];
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  process.exitCode = 0;
});

afterEach(() => {
  errorSpy?.mockRestore();
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

function makePatch(): string {
  const clone = path.join(root, "clone");
  git(root, "clone", "-q", repo, clone);
  writeFileSync(path.join(clone, "a.txt"), "one\nTWO\nthree\n");
  git(clone, "add", "-A");
  return git(clone, "diff", "--cached", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", baseCommit);
}

function seed(patch: string, overrides: Partial<ExternalWriteRunRecord> = {}): ExternalWriteRunRecord {
  const runId = crypto.randomUUID();
  const handle = createSession({ cwd: repo, dataDir, id: runId, provider: `${EXTERNAL_RUN_PROVIDER_PREFIX}claude-cli`, title: "External write claude-cli: Completed" });
  const refused = overrides.state === "refused";
  const patchPath = path.join(handle.dir, EXTERNAL_WRITE_PATCH_FILE);
  if (!refused) writeFileSync(patchPath, patch);
  const record: ExternalWriteRunRecord = {
    runId,
    agentId: "claude-cli",
    baseCommit,
    ...(refused ? {} : { patchPath, patchHash: sha256(patch) }),
    files: [{ path: "a.txt", status: "modified" }],
    flaggedPaths: [],
    refusedPaths: [],
    state: "pending-review",
    redacted: false,
    runStatus: "Completed",
    projectRoot: handle.summary.projectPath,
    createdAt: handle.summary.createdAt,
    ...overrides,
  };
  writeFileSync(path.join(handle.dir, EXTERNAL_WRITE_RUN_FILE), JSON.stringify(record, null, 2));
  return record;
}

function deps(run: AgentsExternalRunSeams = {}): AgentsExternalDeps {
  return { cwd: repo, log: (line) => out.push(line), run: { dataDir, ...run } };
}

/** A terminal on both ends whose one answer is `answer`; records every question asked. */
function terminal(answer: string): { run: AgentsExternalRunSeams; questions: string[] } {
  const questions: string[] = [];
  return {
    questions,
    run: {
      isTTY: true,
      stdoutIsTTY: true,
      prompt: async (question) => {
        questions.push(question);
        return answer;
      },
    },
  };
}

function branches(): string[] {
  return git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").trim().split("\n");
}

describe("agents external review", () => {
  test("prints identity, flagged paths before files, then the patch", async () => {
    const patch = makePatch();
    const record = seed(patch, {
      files: [
        { path: "a.txt", status: "modified" },
        { path: ".github/workflows/ci.yml", status: "added" },
        { path: "logo.png", status: "added", binary: true },
      ],
      flaggedPaths: [".github/workflows/ci.yml"],
    });
    await agentsExternalCommand(["review", record.runId], deps());
    const text = out.join("\n");
    expect(process.exitCode).toBe(0);
    expect(text).toContain(`run: ${record.runId}`);
    expect(text).toContain("agent: claude-cli");
    expect(text).toContain(`base commit: ${baseCommit}`);
    expect(text).toContain("run status: Completed");
    expect(text).toContain(`patch hash (sha256): ${record.patchHash}`);
    expect(text).toContain("logo.png (binary: noted, not carried)");
    expect(text).toContain("+TWO");
    expect(text.indexOf("FLAGGED PATHS")).toBeGreaterThan(-1);
    expect(text.indexOf("FLAGGED PATHS")).toBeLessThan(text.indexOf("files (3)"));
    expect(text.indexOf("! .github/workflows/ci.yml")).toBeLessThan(text.indexOf("files (3)"));
  });

  test("agent-controlled text is printed with control characters escaped, and the stored patch and hash stay byte-exact", async () => {
    const forged = "+ok\n+\x1b[2J\x1b[Hforged\r+tab\there\n";
    const patch = `${makePatch()}${forged}`;
    const evil = "src/\x1b[2Jevil.txt";
    const record = seed(patch, {
      files: [{ path: evil, status: "added" }],
      flaggedPaths: [evil],
      agentId: "claude-cli\x1b[31m",
    });
    await agentsExternalCommand(["review", record.runId], deps());
    const text = out.join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\r");
    expect(text).toContain("\\x1b[2Jevil.txt");
    expect(text).toContain("agent: claude-cli\\x1b[31m");
    expect(text).toContain("+\\x1b[2J\\x1b[Hforged\\x0d+tab\there");
    expect(text).toContain("shown as \\xNN escapes");
    expect(text).toContain(`patch hash (sha256): ${sha256(patch)}`);
    const stored = JSON.parse(readFileSync(path.join(path.dirname(record.patchPath as string), EXTERNAL_WRITE_RUN_FILE), "utf8")) as ExternalWriteRunRecord;
    expect(readFileSync(record.patchPath as string, "utf8")).toBe(patch);
    expect(stored.patchHash).toBe(sha256(patch));
  });

  test("the run report escapes the agent's output and partial output but keeps its line breaks", () => {
    const outcome = { status: "completed", output: "line one\n\x1b[2Jline two", partial: "half\x1b[31m", sessionRef: "ref\x1b[H" } as unknown as Parameters<typeof renderRunOutcome>[0];
    const text = renderRunOutcome(outcome).join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("partial output: half\\x1b[31m");
    expect(text).toContain("conversation: ref\\x1b[H");
    expect(text).toContain("line one\n\\x1b[2Jline two");
  });

  test("a clean run carries no escape note", async () => {
    const record = seed(makePatch());
    await agentsExternalCommand(["review", record.runId], deps());
    expect(out.join("\n")).not.toContain("escapes");
  });

  test("apply prints the same escaped review before it asks", async () => {
    const patch = `${makePatch()}+\x1b[2Jhidden\n`;
    const record = seed(patch);
    const t = terminal("no");
    await agentsExternalCommand(["apply", record.runId], deps(t.run));
    const text = out.join("\n");
    expect(text).not.toContain("\x1b");
    expect(text).toContain("+\\x1b[2Jhidden");
    expect(text).toContain("shown as \\xNN escapes");
  });

  test("an unknown run exits 1", async () => {
    await agentsExternalCommand(["review", "nope"], deps());
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain('no external write run "nope"');
  });

  test("a refused run says why and that it can only be discarded", async () => {
    const record = seed("", { state: "refused", refusedPaths: ["escape"], files: [{ path: "escape", status: "added" }] });
    await agentsExternalCommand(["review", record.runId], deps());
    const text = out.join("\n");
    expect(process.exitCode).toBe(0);
    expect(text).toContain("refused: 1 changed symlink(s) point outside the worktree");
    expect(text).toContain("can only be discarded");
    expect(text).not.toContain("patch:");
  });

  test("a missing run id is a usage error", async () => {
    await agentsExternalCommand(["review"], deps());
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Provide a run id");
  });
});

describe("agents external apply", () => {
  test("without a terminal it lands nothing and never asks", async () => {
    const record = seed(makePatch());
    for (const run of [{ isTTY: false, stdoutIsTTY: false }, { isTTY: true, stdoutIsTTY: false }, { isTTY: false, stdoutIsTTY: true }]) {
      process.exitCode = 0;
      let asked = false;
      await agentsExternalCommand(["apply", record.runId], deps({ ...run, prompt: async () => ((asked = true), record.patchHash?.slice(0, 12) ?? "") }));
      expect(process.exitCode).toBe(1);
      expect(asked).toBe(false);
    }
    expect(errors.filter((line) => line === "apply needs a terminal: nobody can answer for you")).toHaveLength(3);
    expect(branches()).toEqual(["main"]);
  });

  test("a wrong answer cancels; so does the full hash or an empty answer", async () => {
    const record = seed(makePatch());
    const hash = record.patchHash as string;
    for (const answer of ["yes", "", hash, `sha256:${hash.slice(0, 12)}`, hash.slice(0, 11), `${hash.slice(0, 12)} `, hash.slice(0, 12).toUpperCase()]) {
      process.exitCode = 0;
      const t = terminal(answer);
      await agentsExternalCommand(["apply", record.runId], deps(t.run));
      expect(process.exitCode).toBe(1);
      expect(t.questions).toEqual([`\nType the first 12 hex digits of the patch hash (without any sha256: prefix) to land this diff (anything else cancels): `]);
    }
    expect(out.join("\n")).toContain("cancelled: nothing was applied");
    expect(branches()).toEqual(["main"]);
  });

  test("the first 12 hex characters land the diff as external/<run-id> and touch nothing else", async () => {
    const patch = makePatch();
    const record = seed(patch);
    writeFileSync(path.join(repo, "untracked.txt"), "mine\n");
    const statusBefore = git(repo, "status", "--porcelain");
    const headBefore = git(repo, "rev-parse", "HEAD");
    const t = terminal((record.patchHash as string).slice(0, 12));
    await agentsExternalCommand(["apply", record.runId], deps(t.run));

    expect(process.exitCode).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`landed: branch external/${record.runId}`);
    expect(text).toContain("nothing was applied to your current branch or working tree");
    const commit = git(repo, "rev-parse", `external/${record.runId}`).trim();
    expect(text).toContain(`commit: ${commit}`);
    expect(git(repo, "show", `${commit}:a.txt`)).toBe("one\nTWO\nthree\n");
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("one\ntwo\nthree\n");

    // Decided once: a second apply is refused after the operator has typed the hash again.
    process.exitCode = 0;
    await agentsExternalCommand(["apply", record.runId], deps(terminal((record.patchHash as string).slice(0, 12)).run));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("refused (not-pending)");
  });

  test("a flagged run is refused after the prompt unless --allow-flagged is given, which never skips the prompt", async () => {
    const record = seed(makePatch(), { flaggedPaths: ["a.txt"] });
    const t = terminal((record.patchHash as string).slice(0, 12));
    await agentsExternalCommand(["apply", record.runId], deps(t.run));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("refused (flagged)");
    expect(branches()).toEqual(["main"]);

    process.exitCode = 0;
    const cancelled = terminal("no");
    await agentsExternalCommand(["apply", record.runId, "--allow-flagged"], deps(cancelled.run));
    expect(cancelled.questions).toHaveLength(1);
    expect(branches()).toEqual(["main"]);

    process.exitCode = 0;
    await agentsExternalCommand(["apply", record.runId, "--allow-flagged"], deps(t.run));
    expect(process.exitCode).toBe(0);
    expect(branches()).toContain(`external/${record.runId}`);
  });

  test("a refused run or a changed patch is never offered a prompt", async () => {
    const refused = seed("", { state: "refused", refusedPaths: ["escape"] });
    const changed = seed(makePatch());
    writeFileSync(changed.patchPath as string, "tampered\n");
    for (const id of [refused.runId, changed.runId]) {
      process.exitCode = 0;
      const t = terminal("anything");
      await agentsExternalCommand(["apply", id], deps(t.run));
      expect(process.exitCode).toBe(1);
      expect(t.questions).toEqual([]);
    }
    expect(branches()).toEqual(["main"]);
  });
});

describe("agents external discard", () => {
  test("records the decision, deletes the patch, and a later apply lands nothing", async () => {
    const record = seed(makePatch());
    await agentsExternalCommand(["discard", record.runId], deps());
    expect(process.exitCode).toBe(0);
    expect(out.join("\n")).toContain(`discarded: ${record.runId}`);
    expect(existsSync(record.patchPath as string)).toBe(false);

    process.exitCode = 0;
    await agentsExternalCommand(["discard", record.runId], deps());
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("refused (not-pending)");

    process.exitCode = 0;
    const t = terminal((record.patchHash as string).slice(0, 12));
    await agentsExternalCommand(["apply", record.runId], deps(t.run));
    expect(process.exitCode).toBe(1);
    expect(branches()).toEqual(["main"]);
  });

  test("an unknown run exits 1", async () => {
    await agentsExternalCommand(["discard", "nope"], deps());
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("refused (not-found)");
  });
});
