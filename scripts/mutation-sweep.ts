#!/usr/bin/env bun
// Does the test suite notice when the production code is WRONG?
//
// The criterion this package has been using — "does the reported
// reproduction now pass" — cannot converge, and four review rounds proved
// it: every fix was correct at the site it was given and wrong one step to
// the side, because a fix that only knows about the reproduction is all
// the criterion asks for. The class tables were the first answer. A
// reviewer then sharpened it, and the sharpening is what this script
// implements:
//
//   a class table's unit is an input to ONE FUNCTION, and the defect class
//   is "the decision is right and the surface around it is not". The
//   criterion that converges is MUTATION COVERAGE OVER THE DIFF: no line
//   of new production code may be inverted without at least one test
//   failing.
//
// They demonstrated it rather than argued it — `if (true) return message;`
// at the top of `explainConnectFailure` left 505 tests green, which is a
// forty-line, seven-branch function with zero coverage that four rounds of
// human review had walked past.
//
// A surviving mutant is not automatically a bug. It is a line whose
// behaviour no test constrains, which is the thing that has been true of
// every defect this package produced.
//
// Usage:
//   bun scripts/mutation-sweep.ts --base main --tests src/mcp-servers/
//   bun scripts/mutation-sweep.ts --files src/mcp-servers/doctor.ts
//   bun scripts/mutation-sweep.ts --max 40        # a sample, for a quick read
//
// It edits files in place and restores them. It refuses to start on a
// dirty tree for exactly that reason.

import { readFileSync, writeFileSync } from "node:fs";

type Mutant = {
  readonly file: string;
  readonly line: number;
  readonly from: string;
  readonly to: string;
  readonly source: string;
  readonly mutated: string;
};

/**
 * Swaps that stay syntactically valid and change meaning.
 *
 * Deliberately not "delete the line": a deleted statement usually fails to
 * parse, and a parse error kills every mutant for the wrong reason, which
 * reports coverage the suite does not have. Every operator here leaves the
 * file compiling and inverts a decision.
 */
const OPERATORS: Array<readonly [RegExp, string]> = [
  [/ === /g, " !== "],
  [/ !== /g, " === "],
  [/ && /g, " || "],
  [/ \|\| /g, " && "],
  // `>=` → `>` and `<=` → `<` only, never the reverse. Widening `>` to
  // `>=` rewrote `Promise<SdkHttpModules>` as `Promise<SdkHttpModules>=`,
  // and a file that does not parse fails every test — which the sweep
  // scores as "killed" and reports as coverage the suite does not have.
  // A mutant that cannot compile measures nothing.
  [/ >= /g, " > "],
  [/ <= /g, " < "],
  [/\breturn true\b/g, "return false"],
  [/\breturn false\b/g, "return true"],
  [/\?\? /g, "|| "],
  [/!([a-zA-Z_$][\w$.]*)\b/g, "$1"],
];

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function sh(argv: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: out + err };
}

/** Lines this branch ADDED, per file — the diff is the unit, not the repo. */
async function addedLines(base: string, file: string): Promise<number[]> {
  const { out } = await sh(["git", "diff", "-U0", `${base}...HEAD`, "--", file]);
  const lines: number[] = [];
  for (const hunk of out.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = 0; i < count; i++) lines.push(start + i);
  }
  return lines;
}

/** A line worth mutating: real code, not a comment, an import or a string. */
function isMutable(text: string): boolean {
  const t = text.trim();
  if (t === "" || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return false;
  if (t.startsWith("import ") || t.startsWith("export type") || t.startsWith("export {")) return false;
  return true;
}

async function main(): Promise<void> {
  const base = arg("base", "main") as string;
  const testPath = arg("tests", "src/mcp-servers/ src/mcp-client/") as string;
  const max = Number(arg("max", "0"));
  const only = arg("files");

  const dirty = await sh(["git", "status", "--porcelain"]);
  if (dirty.out.split("\n").some((l) => l.startsWith(" M src/") || l.startsWith("M  src/"))) {
    console.error(
      "refusing to run: src/ has uncommitted changes.\n" +
        "This script edits files in place and restores them from memory; a crash\n" +
        "would take your work with it. Commit or stash first.",
    );
    process.exit(2);
  }

  let files: string[];
  if (only !== undefined) {
    files = only.split(",");
  } else {
    const { out } = await sh(["git", "diff", "--name-only", `${base}...HEAD`, "--", "src/"]);
    files = out
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"));
  }

  // Build the mutant list before running anything, so the count is known.
  const mutants: Mutant[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      continue; // deleted on this branch
    }
    const lines = source.split("\n");
    const targets = only === undefined ? await addedLines(base, file) : lines.map((_, i) => i + 1);

    for (const lineNo of new Set(targets)) {
      const text = lines[lineNo - 1];
      if (text === undefined || !isMutable(text)) continue;

      for (const [pattern, replacement] of OPERATORS) {
        const mutatedLine = text.replace(pattern, replacement);
        if (mutatedLine === text) continue;
        const copy = [...lines];
        copy[lineNo - 1] = mutatedLine;
        mutants.push({
          file,
          line: lineNo,
          from: text.trim(),
          to: mutatedLine.trim(),
          source,
          mutated: copy.join("\n"),
        });
      }
    }
  }

  const chosen = max > 0 ? mutants.slice(0, max) : mutants;
  console.log(`${chosen.length} mutants across ${files.length} file(s); tests: ${testPath}`);
  if (chosen.length === 0) return;

  const survivors: Mutant[] = [];
  const originals = new Map(chosen.map((m) => [m.file, m.source]));
  const restore = (): void => {
    for (const [file, source] of originals) writeFileSync(file, source);
  };
  // A SIGKILL cannot be caught, and the first run of this script was
  // killed mid-mutation and left a mutant on disk. Nothing was lost —
  // the tree was committed and `git checkout` undid it, and the
  // dirty-tree guard refused the next run rather than compounding it —
  // but "recovery depends on remembering which file" is not a plan. The
  // journal is written BEFORE each edit, so the last line names the file
  // that may still be mutated.
  const journal = `${process.cwd()}/.mutation-sweep-journal`;
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });

  // Progress goes to a file as it happens. Bun buffers stdout to a pipe,
  // so a backgrounded run shows nothing at all until it exits — which for
  // a sweep measured in tens of minutes is indistinguishable from a hang.
  const progress = `${process.cwd()}/.mutation-sweep-progress`;
  writeFileSync(progress, `0/${chosen.length}\n`);

  try {
    for (const [index, mutant] of chosen.entries()) {
      writeFileSync(journal, `${mutant.file}\n`);
      writeFileSync(mutant.file, mutant.mutated);
      const { code } = await sh(["bun", "test", ...testPath.split(" ")]);
      writeFileSync(mutant.file, mutant.source);
      writeFileSync(journal, "");

      const killed = code !== 0;
      if (!killed) survivors.push(mutant);
      process.stdout.write(killed ? "." : "S");
      writeFileSync(
        progress,
        `${index + 1}/${chosen.length} — ${survivors.length} survived\n` +
          survivors.map((s) => `${s.file}:${s.line}  ${s.from}  ->  ${s.to}`).join("\n"),
      );
    }
  } finally {
    restore();
    writeFileSync(journal, "");
  }

  console.log(`\n\n${chosen.length - survivors.length} killed, ${survivors.length} SURVIVED\n`);
  for (const s of survivors) {
    console.log(`${s.file}:${s.line}`);
    console.log(`  -  ${s.from}`);
    console.log(`  +  ${s.to}`);
  }
  process.exit(survivors.length === 0 ? 0 : 1);
}

await main();
