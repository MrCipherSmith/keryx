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
  ".metaproject/routing.md",
  ".metaproject/index.md",
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

/** `core/<moved name>` (`.mdc` or `.md`) — but not `project/core/<name>`, a project's own override slot that the installer migrates. */
function movedCorePath(): RegExp {
  const names = MOVED_RULES.map((entry) => entry.fileName.replace(/\.mdc?$/, "").replace(/[.-]/g, (c) => `\\${c}`));
  return new RegExp(`(?<!project/)\\bcore/(?:${names.join("|")})\\.mdc?\\b`, "g");
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

// Review F3: keryx's own sources also hand agents rule paths — help text, the
// generators of CLAUDE.md / AGENTS.md / routing.md / index.md (`templates.ts`),
// flow templates. They are scanned too, for literal and path.join spellings.

/** The move machinery itself, which must name the old path to clean it up. */
const MOVE_MACHINERY = new Set([
  "src/gdskills/retired-rules.ts",
  "src/gdskills/rule-references.ts",
  "src/gdskills/guarded-fs-ops.ts",
  "src/gdskills/project-rules.ts",
  // Loads only rules that stay in core (pinned below); its `core/${cite}` flip
  // resolves a project rule's own citations, not a moved keryx rule.
  "src/gdskills/context-resolver.ts",
]);

async function listSources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__fixtures__" || entry.name === "bundled" || entry.name === "node_modules") continue;
      out.push(...(await listSources(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function joinedMovedCorePath(): RegExp {
  const names = MOVED_RULES.map((entry) => entry.fileName.replace(/[.-]/g, (c) => `\\${c}`));
  return new RegExp(`["']rules["'],\\s*["']core["'],\\s*["'](?:${names.join("|")})["']`, "g");
}

/** A path into rules/core built from a variable: whoever adds one must make it move-aware (and list the file above). */
const BUILT_CORE_PATH = /core\/\$\{|["']rules["'],\s*["']core["'],\s*[A-Za-z_$]/g;

test("no keryx source outside the move machinery names a moved rule's core/ path, literally or built", async () => {
  const offenders: string[] = [];
  for (const file of await listSources(path.join(REPO_ROOT, "src"))) {
    const relative = path.relative(REPO_ROOT, file).split(path.sep).join("/");
    if (MOVE_MACHINERY.has(relative)) continue;
    const text = await readFile(file, "utf8");
    for (const pattern of [movedCorePath(), joinedMovedCorePath(), BUILT_CORE_PATH]) {
      for (const match of text.matchAll(pattern)) offenders.push(`${relative}: ${match[0]}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("the source patterns catch a literal citation, a path.join spelling and a built path", () => {
  const sample = 'see rules/core/skills-storage-workflow.mdc; path.join(root, "rules", "core", "git-rules.mdc"); `rules/core/${name}`';
  expect([...sample.matchAll(movedCorePath())].map((m) => m[0])).toEqual(["core/skills-storage-workflow.mdc"]);
  expect([...sample.matchAll(joinedMovedCorePath())]).toHaveLength(1);
  expect([...sample.matchAll(BUILT_CORE_PATH)].map((m) => m[0])).toEqual(["core/${"]);
});

test("the context resolver loads no moved rule from rules/core", async () => {
  const { CONDITIONAL_RULES } = await import("./context-resolver");
  const source = await readFile(path.join(REPO_ROOT, "src", "gdskills", "context-resolver.ts"), "utf8");
  const moved = MOVED_RULES.map((entry) => entry.fileName.replace(/\.mdc?$/, ""));
  const named = [...source.matchAll(/"([a-z0-9-]+)"/g)].map((match) => match[1]);
  expect(named.filter((name) => name !== undefined && moved.includes(name))).toEqual([]);
  for (const rule of CONDITIONAL_RULES) {
    expect(existsSync(path.join(REPO_ROOT, "src", "gdskills", "bundled", "rules", "core", `${rule.name}.mdc`))).toBe(true);
  }
});
