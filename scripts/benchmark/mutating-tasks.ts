// Shared task definitions for the M1 ablation runner's MUTATING slice
// (docs/requirements/keryx-benchmark-suite/plan.md, "Remaining in M1: Ablation
// runner — coverage beyond read-only comprehension tasks to actual mutating
// coding tasks"). Unlike scripts/benchmark/ablation-tasks.ts (find-the-symbol
// questions with a checkable text answer), these give the agent write
// capability and ask it to make a real, small, correctly-scoped code change —
// verified by running the actual seeded test after the turn, never by trusting
// the agent's own claim.
//
// All three gaps are real, not invented for this benchmark: `writeJsonFileAtomic`
// is a genuine missing counterpart to the existing `writeFileAtomic` helper
// (src/lib/fs.ts, used repeatedly this session — session-wrap-up.ts,
// wiki-owner-writer.ts, skill-owner-writer.ts) that src/lib/json.ts's
// read-with-fallback pair (readJsonFile/readJsonFileOr) has no write-side
// equivalent for; `flagPresent` is the literal one-line pattern
// (`args.includes(flag)`) repeated many times across src/commands/init.ts's
// own `--sac`/`--no-sac`-style flag parsing this same session; `readTextFileOr`
// is the plain-text sibling `src/sac/proposal-evidence.ts`'s `readSidecarNote`
// hand-rolls inline (`readFile(...).catch(() => undefined)`) rather than
// reusing a shared helper, because src/lib/fs.ts has no such helper today.

// AC-5 (specification.md §7): this file's seedTestContent IS each task's solution
// spec (the exact behavior the agent's edit must satisfy) — a real gold artifact, and
// (like ablation-tasks.ts) a tracked file that a `git worktree add HEAD` checkout
// includes. Every mutating-ablation producer strips this exact path from every
// worktree before the agent ever sees it.
export const MUTATING_GOLD_ARTIFACT_PATH = "scripts/benchmark/mutating-tasks.ts";

export type MutatingTask = {
  readonly name: string;
  /** The prompt given to the agent. */
  readonly prompt: string;
  /** Real, existing file the agent must edit (never create a new file). */
  readonly targetFile: string;
  /** Worktree-relative path of the seeded failing test, written before the agent runs. */
  readonly seedTestFile: string;
  readonly seedTestContent: string;
};

const SHELL_INSTRUCTIONS =
  "You have a real shell via the shell_exec tool. To edit a file, use a heredoc, e.g.: " +
  "cat > path/to/file.ts <<'KERYX_EOF'\n<full file content>\nKERYX_EOF\n" +
  "Read the target file first, then rewrite it in full with your addition — do not try " +
  "to use sed/patch. Run `bun test <seed test path>` yourself to check your work before " +
  "answering. When the test passes, reply with exactly: DONE";

export const MUTATING_TASKS: readonly MutatingTask[] = [
  {
    name: "atomic-json-write",
    targetFile: "src/lib/json.ts",
    seedTestFile: "src/lib/json.ablation-task.test.ts",
    prompt:
      `In this repository, there is a FAILING test at src/lib/json.ablation-task.test.ts. ` +
      `It imports \`writeJsonFileAtomic\` from ./json (src/lib/json.ts), which does not exist ` +
      `yet. Read the failing test to see the exact required behavior, then add a new EXPORTED ` +
      `function to the EXISTING src/lib/json.ts (do not create a new file) that makes it pass. ` +
      `${SHELL_INSTRUCTIONS}`,
    seedTestContent: `import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeJsonFileAtomic } from "./json";

describe("writeJsonFileAtomic (ablation task)", () => {
  test("writes exact JSON content, matching JSON.stringify(value, null, 2) plus a trailing newline", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ablation-json-"));
    try {
      const filePath = path.join(dir, "out.json");
      await writeJsonFileAtomic(filePath, { hello: "world", n: 2 });
      const content = await readFile(filePath, "utf8");
      expect(content).toBe(\`\${JSON.stringify({ hello: "world", n: 2 }, null, 2)}\\n\`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("leaves no leftover temp file in the target directory (it is genuinely atomic)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ablation-json-"));
    try {
      const filePath = path.join(dir, "out.json");
      await writeJsonFileAtomic(filePath, { a: 1 });
      const entries = await readdir(dir);
      expect(entries).toEqual(["out.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
`,
  },
  {
    name: "flag-present",
    targetFile: "src/lib/args.ts",
    seedTestFile: "src/lib/args.ablation-task.test.ts",
    prompt:
      `In this repository, there is a FAILING test at src/lib/args.ablation-task.test.ts. ` +
      `It imports \`flagPresent\` from ./args (src/lib/args.ts), which does not exist yet. ` +
      `Read the failing test to see the exact required behavior, then add a new EXPORTED ` +
      `function to the EXISTING src/lib/args.ts (do not create a new file) that makes it ` +
      `pass. ${SHELL_INSTRUCTIONS}`,
    seedTestContent: `import { describe, expect, test } from "bun:test";
import { flagPresent } from "./args";

describe("flagPresent (ablation task)", () => {
  test("true when the flag is present anywhere in argv", () => {
    expect(flagPresent(["--sac", "--other"], "--sac")).toBe(true);
    expect(flagPresent(["--other", "--sac"], "--sac")).toBe(true);
  });

  test("false when the flag is absent", () => {
    expect(flagPresent(["--other"], "--sac")).toBe(false);
    expect(flagPresent([], "--sac")).toBe(false);
  });
});
`,
  },
  {
    name: "read-text-file-or",
    targetFile: "src/lib/fs.ts",
    seedTestFile: "src/lib/fs.ablation-task.test.ts",
    prompt:
      `In this repository, there is a FAILING test at src/lib/fs.ablation-task.test.ts. ` +
      `It imports \`readTextFileOr\` from ./fs (src/lib/fs.ts), which does not exist yet. ` +
      `Read the failing test to see the exact required behavior, then add a new EXPORTED ` +
      `function to the EXISTING src/lib/fs.ts (do not create a new file) that makes it ` +
      `pass. ${SHELL_INSTRUCTIONS}`,
    seedTestContent: `import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readTextFileOr } from "./fs";

describe("readTextFileOr (ablation task)", () => {
  test("returns the file's real content when it exists", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ablation-fs-"));
    try {
      const filePath = path.join(dir, "note.txt");
      await writeFile(filePath, "hello there", "utf8");
      expect(await readTextFileOr(filePath, "fallback")).toBe("hello there");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("returns the fallback when the file does not exist", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "keryx-ablation-fs-"));
    try {
      const missing = path.join(dir, "missing.txt");
      expect(await readTextFileOr(missing, "fallback value")).toBe("fallback value");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
`,
  },
];
