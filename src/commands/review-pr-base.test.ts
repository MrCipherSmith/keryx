// The pull request's own base, read with `gh pr view` (flow 460): branch-name validation, the refusals, and the off switch.
// The real reader runs in a child whose PATH starts with a stand-in `gh` (Bun resolves `gh` from the PATH it started with).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prBaseRef } from "./review";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-pr-base-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** `ghPrBase(ref)` run against a stand-in `gh` that prints `output` and exits `code`; `off` sets the opt-out variable. */
async function readBase(ref: string, output: string, code = 0, off = false): Promise<string> {
  const bin = path.join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(output)}\nexit ${code}\n`, { mode: 0o755 });
  const entry = path.join(root, "child.ts");
  await writeFile(entry, `import { ghPrBase } from ${JSON.stringify(path.resolve(import.meta.dir, "review"))};\nconsole.log(JSON.stringify((await ghPrBase(${JSON.stringify(ref)})) ?? null));\n`);
  const env: Record<string, string | undefined> = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
  if (off) env.KERYX_REVIEW_PR_BASE = "off";
  else delete env.KERYX_REVIEW_PR_BASE;
  const child = Bun.spawn([process.execPath, "run", entry], { cwd: root, env, stdout: "pipe", stderr: "ignore" });
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return stdout.trim();
}

test("prBaseRef accepts a plain branch name and nothing else", () => {
  expect(prBaseRef("main\n")).toBe("origin/main");
  expect(prBaseRef("release/1.2_x")).toBe("origin/release/1.2_x");
  for (const bad of ["", "-x", "--upload-pack=evil", "a..b", "a b", "a;b", "$(x)", "a".repeat(201)]) expect(prBaseRef(bad)).toBeUndefined();
});

test("the real reader returns origin/<base> for a branch name and nothing for a bad name, a failed gh, a flag-like ref or the off switch", async () => {
  const pr = "https://github.com/o/r/pull/7";
  expect(await readBase(pr, "main")).toBe('"origin/main"');
  expect(await readBase(pr, "-x")).toBe("null");
  expect(await readBase(pr, "a..b")).toBe("null");
  expect(await readBase(pr, "main", 1)).toBe("null");
  expect(await readBase("--web", "main")).toBe("null");
  expect(await readBase(pr, "main", 0, true)).toBe("null");
});
