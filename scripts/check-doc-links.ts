#!/usr/bin/env bun
// Resolve every relative Markdown link in the published documentation.
//
// `keryx wiki check-links` already does this for the wiki (42 pages, 233 links).
// Nothing covered `docs/` or the root Markdown, which is how a documentation
// pass can green-light a set of pages that point at each other incorrectly.
// This is that gate, and it runs in CI so a broken link fails a pull request
// rather than being noticed by a reader.
//
// What counts as a link to check:
//   * inline   `[text](./path.md)`  and  `[text](path.md#anchor)`
//   * reference `[label]: ./path.md`
//   * absolute (`https:`, `mailto:`) and bare-anchor (`#x`) targets are skipped
//   * an anchor is verified against the target file's headings when the target
//     is Markdown, because `file.md#missing-section` is the failure that
//     survives a plain existence check
import { existsSync, readFileSync, statSync } from "node:fs";
import { Glob } from "bun";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** Files whose links are part of the published surface. */
const PATTERNS = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "docs/**/*.md",
];

type Broken = { file: string; target: string; reason: string };

/** GitHub-style slug for a heading, which is what an in-page anchor resolves to. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(file: string): Set<string> {
  const out = new Set<string>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    if (match) out.add(slug(match[1]!));
  }
  return out;
}

function linksIn(text: string): string[] {
  const targets: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) targets.push(m[1]!);
  for (const m of text.matchAll(/^\[[^\]]+\]:\s*(\S+)$/gm)) targets.push(m[1]!);
  return targets;
}

function collectFiles(): string[] {
  const files = new Set<string>();
  for (const pattern of PATTERNS) {
    for (const rel of new Glob(pattern).scanSync(ROOT)) files.add(rel);
  }
  return [...files].sort();
}

function main(): void {
  const files = collectFiles();
  const broken: Broken[] = [];
  let checked = 0;

  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    const dir = path.dirname(abs);
    for (const target of linksIn(readFileSync(abs, "utf8"))) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      checked += 1;

      const [rawPath, anchor] = target.split("#");
      const resolved = path.resolve(dir, decodeURIComponent(rawPath ?? ""));

      if (!existsSync(resolved)) {
        broken.push({ file: rel, target, reason: "no such file" });
        continue;
      }
      if (anchor === undefined || anchor === "" || !statSync(resolved).isFile()) continue;
      if (!resolved.endsWith(".md")) continue;
      if (!anchorsOf(resolved).has(slug(anchor))) {
        broken.push({ file: rel, target, reason: `no heading matching #${anchor}` });
      }
    }
  }

  for (const b of broken) console.log(`BROKEN  ${b.file}  ->  ${b.target}   (${b.reason})`);
  console.log(`checked ${checked} relative links across ${files.length} files, ${broken.length} broken`);

  // A zero-link run would pass vacuously — a glob or regex that silently stopped
  // matching would look identical to a clean sweep.
  if (checked === 0) {
    console.log("FAIL: no links were checked at all; the collector matched nothing.");
    process.exitCode = 1;
    return;
  }
  if (broken.length > 0) process.exitCode = 1;
}

main();
