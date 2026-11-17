import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { MOVED_RULES } from "./retired-rules";

// ADR-0001 P3: once a rule leaves `rules/core/`, nothing keryx ships or
// documents may still point an agent at the old path — the installer removes
// that file from every project on the next `keryx update`.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** What keryx ships into projects, plus the docs and entrypoints that describe it. */
const SHIPPED_ROOTS = [
  "src/gdskills/bundled",
  ".metaproject/skills",
  ".metaproject/rules",
  "docs/docs",
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
];

const TEXT = /\.(md|mdc|json|ya?ml|txt|toml)$/;

async function listFiles(target: string): Promise<string[]> {
  if (!existsSync(target)) return [];
  if (TEXT.test(target) && !(await readdir(target).catch(() => null))) return [target];
  const out: string[] = [];
  for (const entry of await readdir(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile() && TEXT.test(entry.name)) out.push(full);
  }
  return out;
}

/** `core/<moved name>` — but not `project/core/<name>`, a project's own override slot that the installer migrates. */
function movedCorePath(): RegExp {
  const names = MOVED_RULES.map((entry) => entry.fileName.replace(/\.mdc$/, "").replace(/[.-]/g, (c) => `\\${c}`));
  return new RegExp(`(?<!project/)\\bcore/(?:${names.join("|")})\\.mdc\\b`, "g");
}

test("MOVED_RULES is not empty, so the scan below checks something", () => {
  expect(MOVED_RULES.length).toBeGreaterThan(0);
});

test("no shipped skill, rule, doc or entrypoint cites a rule at the core/ path it moved away from", async () => {
  const pattern = movedCorePath();
  const offenders: string[] = [];
  for (const root of SHIPPED_ROOTS) {
    for (const file of await listFiles(path.join(REPO_ROOT, root))) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(pattern)) {
        offenders.push(`${path.relative(REPO_ROOT, file)}: ${match[0]}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the scan pattern matches an old citation and spares the override slot and the new path", () => {
  const pattern = movedCorePath();
  const sample = "`rules/core/git-rules.mdc` `rules/project/core/git-rules.mdc` `rules/process/git-rules.mdc` `core/error-handling.mdc`";
  expect([...sample.matchAll(pattern)].map((match) => match[0])).toEqual(["core/git-rules.mdc"]);
});
