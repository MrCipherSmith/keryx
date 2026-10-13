import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

export async function writeProjectFile(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

export const TRACKED_GRAPH_ARTIFACTS = [
  ".metaproject/data/gdgraph/.provenance.json",
  ".metaproject/data/gdgraph/artifacts/module-map.json",
  ".metaproject/data/gdgraph/artifacts/summary.md",
] as const;

export interface LayersFixture {
  root: string;
  first: string;
  second: string;
  packageDir: string;
  cleanup(): Promise<void>;
}

const WIKI_PAGE = [
  "---",
  "title: Alpha",
  "type: architecture",
  "---",
  "",
  "# Alpha",
  "",
  "Describes: src/a.ts",
  "",
].join("\n");

/**
 * A repository with two commits, tracked graph artifacts recorded at the FIRST
 * commit, a gitignored `storage/` that does not exist, a wiki page and a memory
 * entry. HEAD is the second commit.
 */
export async function createLayersFixture(): Promise<LayersFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-layers-"));
  git(root, ["init", "-q", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "test"]);
  await writeProjectFile(root, ".gitignore", ".metaproject/data/**/storage/\n.metaproject/data/memory/index/\n");
  await writeProjectFile(root, "package.json", '{"name":"fixture","version":"1.0.0"}\n');
  await writeProjectFile(root, "src/a.ts", "export const a = 1;\n");
  await writeProjectFile(root, "src/b.ts", 'import { a } from "./a";\nexport const b = a + 1;\n');
  await writeProjectFile(root, ".metaproject/wiki/architecture/alpha.md", WIKI_PAGE);
  await writeProjectFile(
    root,
    ".metaproject/memory/lessons/first-lesson.md",
    "---\ntype: lesson\nstatus: active\n---\n\n# First lesson\n\nKeep the graph honest.\n",
  );
  await writeProjectFile(root, TRACKED_GRAPH_ARTIFACTS[0], '{"commit":"from-another-commit"}\n');
  await writeProjectFile(root, TRACKED_GRAPH_ARTIFACTS[1], '{"modules":[]}\n');
  await writeProjectFile(root, TRACKED_GRAPH_ARTIFACTS[2], "# old summary\n");
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "first"]);
  const first = git(root, ["rev-parse", "HEAD"]);

  await writeProjectFile(root, "src/c.ts", 'import { b } from "./b";\nexport const c = b + 1;\n');
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "second"]);
  const second = git(root, ["rev-parse", "HEAD"]);

  const packageDir = path.join(root, ".metaproject", "reviews", "2026-10-13-fixture-review");
  await mkdir(packageDir, { recursive: true });
  return { root, first, second, packageDir, cleanup: () => rm(root, { recursive: true, force: true }) };
}

export async function readText(file: string): Promise<string> {
  return readFile(file, "utf8");
}

/** `git status --porcelain` with the review package's own directory left out. */
export function statusOutsidePackage(root: string): string {
  return git(root, ["status", "--porcelain", "--", ".", ":(exclude).metaproject/reviews"]);
}
