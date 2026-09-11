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
//
// DO NOT EDIT `src/` WHILE THIS IS RUNNING. The dirty-tree guard stops
// it STARTING on top of your work; nothing stops your work landing on
// top of it. Measured, by doing it: an edit made mid-run was restored
// out of existence by the sweep's in-memory copy of the file, and the
// same file was left holding a live mutant (`<=` narrowed to `<`) that
// type-checked and would have been committed. `.mutation-sweep-journal`
// named the file, which is how it was found. Treat a running sweep as a
// lock on `src/`.

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

/**
 * DELETE a single-line guard clause.
 *
 * Inversion is not enough, and a reviewer proved it on a branch this
 * sweep had already passed: `if (syscall === "ECONNREFUSED") return ...`
 * inside a dispatch chain. Inverting `===` to `!==` makes the branch fire
 * for every OTHER code, which a sibling's exact-wording test catches — so
 * the mutant died and the line read as covered. REMOVING the branch is
 * invisible: control falls through to the generic fallback, and the only
 * test behind it accepted the fallback's wording as an alternative.
 *
 * Restricted to lines that are entirely `if (…) <single statement>;`,
 * which is the one shape that can be deleted whole and still parse. This
 * sweep does not delete arbitrary statements — a file that fails to
 * compile fails every test, which scores as "killed" and reports
 * coverage that does not exist.
 */
const DELETABLE_GUARD = /^\s*if \(.+\) (return|throw|continue|break)\b[^;]*;\s*$/;

/**
 * Mutants that cannot change behaviour, skipped so the report stays read.
 *
 * `x ?? {}` and `x || {}` differ only when `x` is falsy-but-not-nullish.
 * For an object, array, boolean or empty-string default there is no such
 * value, so the mutant is EQUIVALENT — it survives every possible test
 * suite. The first run reported eighteen of them among thirty-nine
 * survivors, and a report that is half noise is a report nobody reads to
 * the end, which would waste the two real findings sitting in it.
 *
 * `?? findHeader(...)`, `?? process.env` and `?? 3` are NOT skipped: a
 * falsy left-hand side is reachable there, and one of them was a genuine
 * gap.
 */
const EQUIVALENT = [/\?\? \{\}/, /\?\? \[\]/, /\?\? ""/, /\?\? false/];

/**
 * Was the mutation ITSELF a `??` swap on a safe default?
 *
 * The first version asked whether the ORIGINAL LINE contained a safe
 * `??` anywhere and whether the MUTATED line contained `|| ` anywhere —
 * which is true of a completely different mutation on the same line. A
 * reviewer replayed the operator table over `src/` and found 13 mutants
 * wrongly suppressed, all `&&`→`||` or `===`→`!==` on lines that merely
 * happened to also carry a `?? {}`:
 *
 *   src/wiki/section-marker.ts  `if (match && (match[1] ?? "").length >= 2)`
 *
 * Suppressing a real mutant is worse than reporting a false one: a
 * survivor gets triaged, a suppressed mutant is invisible.
 *
 * So compare the two lines directly — the swap is equivalent only when
 * the ONLY difference is a safe `?? <literal>` becoming `|| <literal>`.
 *
 * `?? null` is no longer on the list. It is NOT equivalent when the left
 * side can be `0`, `""` or `false`, and nothing here can tell whether it
 * can be.
 */
function isEquivalent(original: string, mutated: string): boolean {
  for (const pattern of EQUIVALENT) {
    const match = pattern.exec(original);
    if (match === null) continue;
    const swapped = original.replace(match[0], match[0].replace("?? ", "|| "));
    if (swapped === mutated) return true;
  }
  return false;
}

function arg(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

async function sh(
  argv: string[],
  timeoutMs?: number,
): Promise<{ code: number; out: string; timedOut: boolean }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });

  // A DEADLINE, because some mutants do not fail — they hang.
  //
  // Measured, twice, on the same run: `if (code !== null || code !== "")`
  // is always true, so the callback listener never settles, so a test
  // awaiting its result waits forever. The sweep had no timeout, so one
  // such mutant stalled the entire run for two hours and looked
  // identical to slow progress. Both times it took killing the child by
  // hand to find out.
  //
  // A hang is NOT reported as a kill. The suite did stop passing, but
  // "no test asserts this" and "this wedges the process" are different
  // findings with different fixes — the second usually means a test is
  // missing a timeout of its own.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);
    timer.unref?.();
  }
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, out: out + err, timedOut };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * How long one mutant's test run may take before it is called a hang.
 *
 * Generous against the honest worst case — the scoped suite runs in
 * well under a minute — and finite, because the alternative is a sweep
 * that cannot distinguish "working" from "wedged".
 */
const MUTANT_TIMEOUT_MS = 240_000;

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
  // `--skip N` with `--max M` runs mutants [N, N+M). Slicing exists
  // because this environment reaps detached background processes: three
  // separate runs were killed part-way, each leaving a live mutant that
  // the journal then had to name. A slice that finishes inside a
  // foreground call cannot be reaped mid-write.
  const skip = Number(arg("skip", "0"));
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

      const variants: Array<{ line: string; label: string }> = [];
      if (DELETABLE_GUARD.test(text)) {
        variants.push({ line: "", label: "DELETED (guard clause)" });
      }
      for (const [pattern, replacement] of OPERATORS) {
        const swapped: string = text.replace(pattern, replacement);
        if (swapped !== text && !isEquivalent(text, swapped)) {
          variants.push({ line: swapped, label: swapped.trim() });
        }
      }

      for (const variant of variants) {
        const mutatedLine: string = variant.line;
        const copy = [...lines];
        copy[lineNo - 1] = mutatedLine;
        mutants.push({
          file,
          line: lineNo,
          from: text.trim(),
          to: variant.label,
          source,
          mutated: copy.join("\n"),
        });
      }
    }
  }

  const windowed = mutants.slice(skip);
  const chosen = max > 0 ? windowed.slice(0, max) : windowed;
  console.log(
    `${mutants.length} mutants across ${files.length} file(s); running ${chosen.length}` +
      `${skip > 0 || max > 0 ? ` (slice ${skip}..${skip + chosen.length})` : ""}; tests: ${testPath}`,
  );
  if (chosen.length === 0) return;

  const survivors: Mutant[] = [];
  /** Mutants whose test run had to be killed. Reported separately. */
  const hung: Mutant[] = [];
  let ran = 0;
  let stopped = false;
  const originals = new Map(chosen.map((m) => [m.file, m.source]));
  // Files that must NEVER be restored from memory, because something
  // outside this run wrote them. Restoring would discard that write.
  const untouchable = new Set<string>();
  const restore = (): void => {
    for (const [file, source] of originals) {
      if (untouchable.has(file)) continue;
      writeFileSync(file, source);
    }
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
      // Has someone edited this file since the run began? If so, STOP.
      //
      // Restoring `mutant.source` would silently discard their work —
      // which is not hypothetical: it happened, and the file was left
      // holding a live mutant that type-checked. The dirty-tree guard
      // only covers the start. This covers the middle.
      const onDisk = readFileSync(mutant.file, "utf8");
      if (onDisk !== mutant.source && onDisk !== mutant.mutated) {
        // MARK IT FIRST, then stop. `break` falls into the `finally`
        // below, and `restore()` used to write every original back —
        // including this file. So the message said "nothing was
        // written" and then the run wrote, discarding exactly the edit
        // it had just refused to touch. The guard's promise was
        // inverted, which a reviewer reproduced in a scratch repo.
        //
        // Third time this script has had the defect it exists to catch,
        // and the second time in this same guard.
        untouchable.add(mutant.file);
        stopped = true;
        console.error(
          `\n\nSTOPPING: ${mutant.file} changed on disk since this run began.\n` +
            "It is left exactly as found; no other file is affected.\n" +
            "A running sweep is a lock on src/ — re-run when the tree is settled.",
        );
        break;
      }
      writeFileSync(journal, `${mutant.file}\n`);
      writeFileSync(mutant.file, mutant.mutated);
      const { code, timedOut } = await sh(["bun", "test", ...testPath.split(" ")], MUTANT_TIMEOUT_MS);
      writeFileSync(mutant.file, mutant.source);
      writeFileSync(journal, "");

      ran++;
      if (timedOut) hung.push(mutant);
      const killed = code !== 0;
      if (!killed) survivors.push(mutant);
      process.stdout.write(timedOut ? "T" : killed ? "." : "S");
      writeFileSync(
        progress,
        `${index + 1}/${chosen.length} — ${survivors.length} survived, ${hung.length} hung\n` +
          survivors.map((s) => `${s.file}:${s.line}  ${s.from}  ->  ${s.to}`).join("\n"),
      );
    }
  } finally {
    restore();
    writeFileSync(journal, "");
  }

  // `ran`, not `chosen.length`. Subtracting survivors from the PLANNED
  // count reported every never-executed mutant as killed — so a run that
  // stopped after three of six printed "5 killed, 1 SURVIVED", which is
  // the "coverage the suite does not have" this file's own header warns
  // about, produced by the file itself.
  console.log(
    `\n\n${ran - survivors.length} killed of ${ran} run, ${survivors.length} SURVIVED` +
      `${hung.length === 0 ? "" : `, ${hung.length} HUNG`}`,
  );
  if (hung.length > 0) {
    // Counted as killed above — the run did stop passing — but named
    // here, because a mutant that wedges the process usually means a
    // test awaits something with no timeout of its own.
    console.log("\nHUNG (test run killed at the deadline, not by an assertion):");
    for (const h of hung) console.log(`  ${h.file}:${h.line}  ${h.from}  ->  ${h.to}`);
  }
  if (ran < chosen.length) {
    console.log(`${chosen.length - ran} mutant(s) were NOT run. This is not a clean sweep.`);
  }
  console.log("");
  for (const s of survivors) {
    console.log(`${s.file}:${s.line}`);
    console.log(`  -  ${s.from}`);
    console.log(`  +  ${s.to}`);
  }
  // A stopped run is a failure even with no survivors yet: it measured
  // nothing about the mutants it never reached.
  process.exit(stopped || ran < chosen.length ? 2 : survivors.length === 0 ? 0 : 1);
}

await main();
