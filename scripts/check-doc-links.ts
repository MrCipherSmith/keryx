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
//   * code is not prose: link syntax inside a fenced block or a backtick span
//     is quoted text, not a link. A normative document that has to SPELL a
//     markdown construct in order to define it was being failed for the
//     spelling — docs/requirements/keryx-agent-first-core/policies.md quotes
//     `![alt](URL)` to say which forms the auto-fetch floor covers, and this
//     gate reported three broken links pointing at a file named URL.
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

/**
 * Blank out code so its contents are never read as prose, preserving every
 * newline and every column so that line-anchored patterns still line up.
 *
 * Fences are removed first: a backtick span cannot span a fence boundary, and
 * an unbalanced backtick inside a fenced block would otherwise swallow the
 * rest of the document. Inline spans follow CommonMark's rule that a run of N
 * backticks closes only on a run of exactly N.
 */
export function blankCode(text: string): string {
  const blank = (line: string): string => line.replace(/[^\n]/g, " ");

  // Fences first, line by line. A backtick span cannot cross a fence
  // boundary, and an unbalanced backtick inside a fenced block would
  // otherwise swallow the rest of the document.
  const lines = text.split("\n");
  let open: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (open === undefined) {
      const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      // An info string on a backtick fence may not itself contain a backtick.
      if (opener && !(opener[1]!.startsWith("`") && opener[2]!.includes("`"))) {
        open = { char: opener[1]![0]!, length: opener[1]!.length };
        lines[i] = blank(line);
      }
      continue;
    }
    lines[i] = blank(line);
    const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (closer && closer[1]![0] === open.char && closer[1]!.length >= open.length) open = undefined;
  }

  // Then inline spans, over the whole remaining text so a span may wrap a
  // line. A run of N backticks closes only on a run of exactly N.
  return lines.join("\n").replace(/(`+)[\s\S]*?\1(?!`)/g, blank);
}

export function linksIn(text: string): string[] {
  const prose = blankCode(text);
  const targets: string[] = [];
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) targets.push(m[1]!);
  for (const m of prose.matchAll(/^\[[^\]]+\]:\s*(\S+)$/gm)) targets.push(m[1]!);
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

if (import.meta.main) main();
