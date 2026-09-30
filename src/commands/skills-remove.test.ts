import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { knownSubcommandsFor } from "../cli-registry";
import { skillsCommand } from "./skills";

// Flow 360 (AC3): the removal logic is tested in `gdskills/remove-skill.test.ts`.
// What only the ROUTER does is tested here: it has to know the word `remove`
// (twice — its own dispatch, and the table that refuses unknown first tokens
// before the dispatch runs), and it is the one place a refusal becomes exit 1.

const roots: string[] = [];
const startCwd = process.cwd();

afterEach(async () => {
  process.chdir(startCwd);
  process.exitCode = 0;
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function capture(run: () => Promise<void>): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

test("`remove` is a known skills subcommand, so it is not refused as a typo before the router runs", () => {
  expect(knownSubcommandsFor("skills")).toContain("remove");
});

test("the skills router dispatches `remove`; a refusal exits 1 with the reason on stderr", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-skills-remove-router-"));
  roots.push(root);
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{}\n", "utf8");
  process.chdir(root);

  const { out, err } = await capture(() => skillsCommand(["remove", "review/no-such-skill"]));

  expect(out).toBe("");
  expect(err).toContain("keryx skills remove: project skill not found: review/no-such-skill");
  expect(err).not.toContain("Unknown skills command");
  expect(process.exitCode).toBe(1);
});

test("`keryx skills --help` lists remove", async () => {
  const { out } = await capture(() => skillsCommand(["--help"]));
  expect(out).toContain("keryx skills remove <module>/<name> [--dry-run] [--json]");
  expect(out).toMatch(/^ {2}remove\s+\S/m);
});
