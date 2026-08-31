// Flow 207, §5.3 at the CLI boundary — `keryx skills verify --bundled`.
//
// `src/gdskills/bundled-eval.test.ts` proves the sweep. This proves the COMMAND:
// routing, `--root`, `--json`, and the exit code, which is the part a function
// cannot assert about itself and the part anything gating on this depends on.
//
// The guard and the command are the same predicate on purpose — see the note on
// `verifyBundledSkills` for why both ship. This file is the seam where "the
// command exists and behaves" is checkable; without it, the guard could stay
// green while `--bundled` silently did nothing.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = path.join(import.meta.dir, "..", "cli.ts");

async function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  // A temp HOME so nothing reads or writes the operator's own configuration.
  const home = mkdtempSync(path.join(tmpdir(), "keryx-bundled-verify-home-"));
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOME = home;
  env.XDG_DATA_HOME = home;

  const proc = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

describe("keryx skills verify --bundled", () => {
  test("the shipped tree passes, over a non-zero denominator, and exits 0", async () => {
    const result = await runCli(["skills", "verify", "--bundled"]);
    expect(result.out).toContain("skills_evaluated: 67");
    expect(result.out).toContain("findings: 0");
    expect(result.code).toBe(0);
  });

  test("--json emits the evaluation, both denominators included", async () => {
    const result = await runCli(["skills", "verify", "--bundled", "--json"]);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out) as {
      skills: number;
      documents: number;
      findings: unknown[];
      skillNames: string[];
    };
    expect(parsed.skills).toBe(67);
    // The harness builds are read too, and the count says so. `skills` alone
    // read as full coverage while 100-odd builds went unopened.
    expect(parsed.documents).toBeGreaterThan(parsed.skills);
    expect(parsed.findings).toEqual([]);
    expect(parsed.skillNames).toContain("review-orchestrator");
  });

  test("a tree with a defect is reported and exits 1", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "keryx-bundled-verify-"));
    const dir = path.join(root, "skills", "quality", "broken-command-fixture");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---
name: broken-command-fixture
description: Deliberately broken, to prove the exit code is wired.
metadata:
  version: 1.0.0
---

Launch \`no-such-skill\` skill on the diff.
`,
      "utf8",
    );

    const result = await runCli(["skills", "verify", "--bundled", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("skills_evaluated: 1");
    expect(result.out).toContain("[xref:skill]");
    expect(result.out).toContain("no-such-skill");
  });

  test("an empty tree exits 1 and refuses to read as a pass", async () => {
    // `findings: 0` over `skills: 0` is the defect this whole sweep exists to
    // remove. Exiting 0 here would reintroduce it at the command layer.
    const root = mkdtempSync(path.join(tmpdir(), "keryx-bundled-verify-empty-"));
    const result = await runCli(["skills", "verify", "--bundled", "--root", root]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("NOTHING WAS EVALUATED");
    expect(result.err).toContain("Nothing was evaluated, so nothing was verified");
  });

  test("the help text states which layer this is", async () => {
    const result = await runCli(["skills", "verify"]);
    expect(result.out).toContain("keryx skills verify --bundled");
    expect(result.out).toContain("LAYER\nONE");
    expect(result.out).toContain("does NOT judge");
  });
});
