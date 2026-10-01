#!/usr/bin/env bun
// Fail when a Markdown file under the docs site is neither in the mkdocs nav
// nor excluded.
//
// `mkdocs build --strict` does not catch this: a page that exists but is not in
// the nav only produces an INFO line, so it ships published and unreachable
// (`jev-in-review.md` did exactly that). This gate closes the gap.
//
// No dependencies: it reads `mkdocs.yml` line by line, which is enough for the
// three things it needs (`docs_dir`, nav entries, and the `exclude_docs` /
// `not_in_nav` block scalars).
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

export type NavConfig = {
  docsDir: string;
  nav: Set<string>;
  patterns: string[];
};

/** Lines of a top-level `key: |` block scalar, trimmed, comments and blanks dropped. */
function blockScalar(lines: string[], key: string): string[] {
  const start = lines.findIndex((l) => new RegExp(`^${key}:\\s*[|>]`).test(l));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    const t = line.trim();
    if (t && !t.startsWith("#")) out.push(t);
  }
  return out;
}

export function parseMkdocs(yaml: string): NavConfig {
  const lines = yaml.split("\n");
  const docsDir = lines.map((l) => /^docs_dir:\s*(\S+)/.exec(l)?.[1]).find(Boolean) ?? "docs";
  const navStart = lines.findIndex((l) => /^nav:\s*$/.test(l));
  const nav = new Set<string>();
  if (navStart >= 0) {
    for (const line of lines.slice(navStart + 1)) {
      if (line.trim() !== "" && !/^\s/.test(line)) break;
      if (line.trim().startsWith("#")) continue;
      const m = /:\s*["']?([^\s"']+\.md)["']?\s*$/.exec(line) ?? /^\s*-\s*["']?([^\s"']+\.md)["']?\s*$/.exec(line);
      if (m?.[1]) nav.add(m[1]);
    }
  }
  return {
    docsDir,
    nav,
    patterns: [...blockScalar(lines, "exclude_docs"), ...blockScalar(lines, "not_in_nav")],
  };
}

/** gitignore-style match, reduced to what the config uses: exact path, `dir/`, or a glob. */
export function matchesPattern(file: string, pattern: string): boolean {
  const p = pattern.replace(/^\//, "");
  if (p.endsWith("/")) return file.startsWith(p);
  return new Glob(p).match(file) || file === p || file.startsWith(`${p}/`);
}

export function orphans(files: string[], cfg: NavConfig): string[] {
  return files
    .filter((f) => !cfg.nav.has(f) && !cfg.patterns.some((p) => matchesPattern(f, p)))
    .sort();
}

function main(): void {
  const cfg = parseMkdocs(readFileSync(path.join(ROOT, "mkdocs.yml"), "utf8"));
  const base = path.join(ROOT, cfg.docsDir);
  const files = [...new Glob("**/*.md").scanSync({ cwd: base })];
  const missing = orphans(files, cfg);
  const dangling = [...cfg.nav].filter((f) => !files.includes(f));
  for (const f of missing) console.error(`not in nav and not excluded: ${cfg.docsDir}/${f}`);
  for (const f of dangling) console.error(`in nav but file missing: ${cfg.docsDir}/${f}`);
  if (missing.length || dangling.length) process.exit(1);
  console.log(`docs nav: ${files.length} Markdown files, ${cfg.nav.size} in nav, 0 orphans`);
}

if (import.meta.main) main();
