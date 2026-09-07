import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Glob } from "bun";

/**
 * Every source file must be readable by a text search.
 *
 * A single NUL byte anywhere in a file makes `rg` and `grep` classify it as
 * binary and skip it entirely — silently, with exit code 0 and no mention of
 * the file. It does not report a match it cannot make; it reports nothing at
 * all. So the file is not merely hard to search, it is absent from every
 * enumeration anyone performs over this repository, including this project's
 * own routed `keryx ctx rg`, the audits that use it, and a reviewer reading a
 * pull request (git renders the diff as `Bin 0 -> N bytes`).
 *
 * This is not hypothetical here. Four files carried one:
 *
 *   - `src/sac/machine-wrap-up.ts` — and it was the one file of two wrap-up
 *     producers that skipped the output redaction floor, so a credential
 *     reached the evidence tree and the model provider in the raw. Several
 *     enumerations of "everything that writes evidence" had already been run
 *     and none of them could see it.
 *   - `src/lib/provider-config.ts`
 *   - `src/gdskills/build-parity.test.ts`
 *   - `src/review/fixtures/consolidated-review-2026-08-01.md` — which is a
 *     past review that had ALREADY found this defect and prescribed the fix,
 *     in a file whose own NUL byte kept that advice out of every search for
 *     it. The advice was recorded and could not be found.
 *
 * In every case the byte was a key separator in a template literal, and in
 * every case the escape spells the identical runtime string, so the fix costs
 * nothing: `\u0000` in TypeScript, `\0` in prose.
 */
const SRC = path.join(import.meta.dir, "..");

const NUL = "\u0000";

/** Extensions that a person or a tool is expected to be able to grep. */
const TEXT = [".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".txt", ".yml", ".yaml"];

/**
 * PURE over a `{ path -> bytes }` map, so the self-check below drives THIS
 * function rather than a re-reading of the predicate. A guard whose self-check
 * re-implements the guard is the shape this repository has been bitten by more
 * than once: replacing the body with `return []` has to turn the file red.
 */
function unsearchable(sources: ReadonlyMap<string, string>): string[] {
  return [...sources]
    .filter(([, contents]) => contents.includes(NUL))
    .map(([file]) => file)
    .sort();
}

function textFiles(): Map<string, string> {
  const found = new Map<string, string>();
  for (const relative of new Glob("**/*").scanSync(SRC)) {
    const posix = relative.split(path.sep).join("/");
    if (!TEXT.some((extension) => posix.endsWith(extension))) {
      continue;
    }
    found.set(posix, readFileSync(path.join(SRC, relative), "latin1"));
  }
  return found;
}

describe("every source file can be found by a text search", () => {
  test("no file under src/ contains a NUL byte", () => {
    expect(unsearchable(textFiles())).toEqual([]);
  });

  test("the scan actually reached the tree", () => {
    // Without this the assertion above passes just as well when the root moves
    // and the map is empty — which is the exact failure mode being guarded
    // against, reproduced inside its own guard.
    const files = textFiles();
    expect(files.size).toBeGreaterThan(400);
    expect(files.has("sac/machine-wrap-up.ts")).toBe(true);
    expect(files.has("lib/provider-config.ts")).toBe(true);
    expect(files.has("gdskills/build-parity.test.ts")).toBe(true);
    expect(files.has("review/fixtures/consolidated-review-2026-08-01.md")).toBe(true);
  });

  test("the four files that carried one still spell the separator as an escape", () => {
    // Named individually, because this is where the byte will come back: each
    // of these lines is a key separator someone may "simplify" by pasting the
    // character itself. The runtime string is identical either way, which is
    // what makes the regression invisible without this assertion.
    const files = textFiles();
    for (const file of [
      "sac/machine-wrap-up.ts",
      "lib/provider-config.ts",
      "gdskills/build-parity.test.ts",
    ]) {
      expect(files.get(file)).toContain("\\u0000");
    }
    expect(files.get("review/fixtures/consolidated-review-2026-08-01.md")).toContain("\\0");
  });

  test("the guard catches a planted byte, and does not fire on the escape", () => {
    // Driven through the predicate itself. The clean half matters as much as
    // the planted half: a detector that reported every file would satisfy the
    // assertion above and mean nothing.
    const planted = new Map([
      ["probe/separator-in-a-template.ts", "const key = `${a}" + NUL + "${b}`;"],
      ["probe/prose.md", "Use the " + NUL + " escape."],
      ["probe/at-the-very-end.ts", "export const x = 1;\n" + NUL],
    ]);
    expect(unsearchable(planted)).toEqual([
      "probe/at-the-very-end.ts",
      "probe/prose.md",
      "probe/separator-in-a-template.ts",
    ]);

    const clean = new Map([
      ["probe/escaped.ts", 'const key = `${a}\\u0000${b}`;'],
      ["probe/escaped-prose.md", "Use the `\\0` escape."],
      ["probe/mentions-the-word.ts", "// a NUL byte here would be invisible"],
    ]);
    expect(unsearchable(clean)).toEqual([]);
  });
});
