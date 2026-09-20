import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// Flow 276 (shell god-file split, P1). `src/tui/tui-shell.ts` and
// `src/commands/shell.ts` are pinned in place by tests that read them as TEXT
// — exact substrings, `indexOf` offset comparisons, occurrence counts and
// fixed character windows — to assert that production code is wired a
// particular way. Those assertions are coupled to the physical layout of the
// file rather than to its behaviour, so they fail on edits nothing can observe
// (during the agent-bus flows, once on a signature wrapped onto two lines,
// once on one extra `makeAgentDeps` call) and pass while the behaviour they
// name breaks, as long as the literal survives somewhere in the file.
//
// The consequence is that neither file can be split: a mechanical move
// relocates the literals and fails a pile of tests, and the failures do not
// distinguish "you moved the code" from "you broke the wiring".
//
// `docs/requirements/keryx-shell-split/source-text-audit-inventory.md` records
// every one of those audits and what behaviour it actually protects, so the
// conversion PR (P2) can replace them with behavioural tests. A document is
// accurate exactly once unless something re-derives it, which is what this
// file does: it re-runs the scan the inventory was built from and fails when
// the result and the inventory's manifest disagree.
//
// So a new source-text audit added against either file cannot land silently —
// it has to be written down, with the behaviour it protects, or this fails.
// And as P2 converts them, the counts here fall, which is the progress signal.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INVENTORY = new URL(
  "../docs/requirements/keryx-shell-split/source-text-audit-inventory.md",
  import.meta.url,
);

/** The two god-files, relative to `src/`. */
const TARGETS = ["tui/tui-shell.ts", "commands/shell.ts"] as const;
const TARGET_PATHS = TARGETS.map((p) => path.join(HERE, p));

const READ_PRIMITIVE = /readFileSync|Bun\.file|readFile\(|fs\.promises\.readFile/;
const LITERAL = /["'`]([^"'`\n]+)["'`]/g;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Every path a single line could be naming, in the forms tests actually write:
 *
 * - one literal on its own — `source("commands/shell.ts")`, where a local
 *   helper joins it onto `src/` (`mcp-servers/approval-wiring.test.ts`);
 * - the literals joined — `path.join(import.meta.dir, "..", "tui",
 *   "tui-shell.ts")` (`commands/shell-lease.test.ts:568`), truncated at the
 *   segment naming the file so a trailing `"utf8"` is not appended.
 *
 * resolved against both bases a test plausibly joins from: its own directory
 * and `src/`.
 *
 * A line that is a comment is skipped. Prose naming the file is not a
 * dependency on its text — it does not break when the file is split, and
 * these two are named in comments across dozens of files that have no audit
 * in them at all.
 */
function pathsNamedOn(line: string, dir: string): string[] {
  const code = line.trim();
  if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return [];
  const literals = [...line.matchAll(LITERAL)].map((m) => m[1] ?? "");
  if (literals.length === 0) return [];
  const fileSegment = literals.findIndex((l) => l.endsWith(".ts"));
  const joined = fileSegment >= 0 ? literals.slice(0, fileSegment + 1).join("/") : "";
  const out: string[] = [];
  for (const form of [...literals, joined]) {
    if (!form.includes(".ts")) continue;
    for (const base of [dir, HERE]) out.push(path.resolve(base, form));
  }
  return out;
}

export interface SourceTextAudit {
  /** The test file, relative to `src/`. */
  file: string;
  /** Which god-files it reads, relative to `src/`, sorted. */
  targets: string[];
  /** How many lines in it name one of those paths outside a comment. */
  sites: number;
}

/** Re-derives the inventory's subject: which tests read either god-file's source text. */
export function scanSourceTextAudits(): SourceTextAudit[] {
  const found: SourceTextAudit[] = [];
  for (const file of testFiles(HERE).sort()) {
    if (path.resolve(file) === path.resolve(fileURLToPath(import.meta.url))) continue;
    const text = readFileSync(file, "utf8");
    if (!READ_PRIMITIVE.test(text)) continue;
    const dir = path.dirname(file);
    const targets = new Set<string>();
    let sites = 0;
    for (const line of text.split("\n")) {
      const named = pathsNamedOn(line, dir).filter((p) => TARGET_PATHS.includes(p));
      if (named.length === 0) continue;
      sites += 1;
      for (const hit of named) targets.add(path.relative(HERE, hit));
    }
    if (targets.size > 0) {
      found.push({ file: path.relative(HERE, file), targets: [...targets].sort(), sites });
    }
  }
  return found;
}

/**
 * The inventory's manifest: a fenced block under `## Manifest`, one row per
 * file, `<test file> | <targets, comma-separated> | <site count>`.
 *
 * Deliberately not line numbers. Pinning those would reproduce, in the guard
 * against fragile text assertions, exactly the fragility it guards against —
 * every edit above an audit would fail it. Line numbers belong in the
 * inventory's prose tables, which are documentation and assert nothing.
 */
function manifest(): SourceTextAudit[] {
  const doc = readFileSync(INVENTORY, "utf8");
  const block = doc.match(/## Manifest[\s\S]*?```text\n([\s\S]*?)```/);
  if (block === null) throw new Error(`no \`## Manifest\` fenced block in ${INVENTORY.pathname}`);
  return (block[1] ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((row) => {
      const [file, targets, sites] = row.split("|").map((c) => c.trim());
      return {
        file: file ?? "",
        targets: (targets ?? "").split(",").map((t) => t.trim()).filter(Boolean).sort(),
        sites: Number(sites),
      };
    });
}

test("the inventory lists exactly the tests that read either shell god-file as source text", () => {
  expect(scanSourceTextAudits().map((a) => a.file)).toEqual(manifest().map((a) => a.file));
});

test("and records, per file, which god-file it reads and how many sites read it", () => {
  // The counts are the P2 worklist. They only ever go down; a row that grows
  // is a new audit, which needs its behaviour written into the table above the
  // manifest before it can land.
  expect(scanSourceTextAudits()).toEqual(manifest());
});

test("BOUNDARY — the scan is looking at the real files, and a comment is not an audit", () => {
  // Without this, a scan that silently resolved nothing would report an empty
  // set, the manifest would be emptied to match, and both tests above would
  // pass while the audits they exist for went unrecorded.
  const found = scanSourceTextAudits();
  expect(found.length).toBeGreaterThan(0);
  expect(found.map((a) => a.file)).toContain("tui/tui-shell.test.ts");
  expect(found.map((a) => a.file)).toContain("commands/shell.test.ts");

  // And the comment filter earns its place: these two files are named in
  // prose all over the suite. `goal-command.test.ts` names
  // `commands/shell.ts` in its header comment and reads files elsewhere, so
  // it is a hit for a scan without the filter and is not an audit.
  expect(found.map((a) => a.file)).not.toContain("commands/goal-command.test.ts");
});
