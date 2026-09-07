import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

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
const REPO = path.join(import.meta.dir, "..", "..");

const NUL = "\u0000";

/**
 * Extensions a person or a tool is expected to be able to grep.
 *
 * This list is the guard's blind spot, so it is derived and then checked
 * rather than typed once and trusted: `every extension actually present`
 * below fails when a new text extension appears in the tree and is not
 * listed here. The first version of this guard omitted `.mdc` (32 rule files
 * shipped inside src/) and `.sse`, and a NUL planted in a `.mdc` file went
 * unreported while the routed search silently skipped it.
 */
const TEXT = [
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".jsonc", ".md", ".mdc", ".mdx",
  ".txt", ".yml", ".yaml", ".sse", ".toml", ".css", ".html", ".sh", ".sql", ".csv",
];

/**
 * Directories with nothing to guard: dependencies, build output, scratch
 * worktrees, and version control internals.
 */
const SKIP = new Set(["node_modules", "dist", "coverage", "worktrees", ".git"]);

/**
 * gdctx's captured command logs, which legitimately hold whatever bytes the
 * commands they wrapped produced. Matched by PATH, not by directory name —
 * skipping every directory called `artifacts` would also have excluded
 * the per-flow `artifacts` directories under `.metaproject/flows`, where
 * three real violators live.
 */
const SKIP_PATHS = [".metaproject/data/gdctx/"];

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

/**
 * Walked with readdir rather than a glob, deliberately.
 *
 * `Glob("**\/*")` does not descend into dotted directories, so the first
 * version of this guard could not see `.metaproject/` — where three of the
 * five files that actually carried a NUL live, including two past review
 * reports — nor a NUL planted in `src/.probe/`. A guard that cannot look
 * where the defect is, is decorative.
 */
function walk(dir: string, prefix: string, found: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) {
      continue;
    }
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (SKIP_PATHS.some((skipped) => `${relative}/`.startsWith(skipped))) {
      continue;
    }
    if (entry.isDirectory()) {
      walk(path.join(dir, entry.name), relative, found);
    } else if (entry.isFile() && TEXT.some((extension) => relative.endsWith(extension))) {
      found.set(relative, readFileSync(path.join(dir, entry.name), "latin1"));
    }
  }
}

function textFiles(): Map<string, string> {
  const found = new Map<string, string>();
  walk(REPO, "", found);
  return found;
}

/** Every extension present in the tree, so the TEXT list cannot silently fall behind. */
function extensionsPresent(): Set<string> {
  const present = new Set<string>();
  const seen = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) {
        continue;
      }
      if (entry.isDirectory()) {
        seen(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot > 0) {
          present.add(entry.name.slice(dot));
        }
      }
    }
  };
  seen(path.join(REPO, "src"));
  return present;
}

describe("every source file can be found by a text search", () => {
  test("no text file in the repository contains a NUL byte", () => {
    expect(unsearchable(textFiles())).toEqual([]);
  });

  test("the scan actually reached the tree, including where the defect was", () => {
    // Without this the assertion above passes just as well when the root moves
    // and the map is empty — which is the exact failure mode being guarded
    // against, reproduced inside its own guard.
    const files = textFiles();
    expect(files.size).toBeGreaterThan(1000);
    expect(files.has("src/sac/machine-wrap-up.ts")).toBe(true);
    expect(files.has("src/lib/provider-config.ts")).toBe(true);
    expect(files.has("src/gdskills/build-parity.test.ts")).toBe(true);
    expect(files.has("src/review/fixtures/consolidated-review-2026-08-01.md")).toBe(true);
    // A dotted directory, which the previous glob-based scan could not enter,
    // and where three of the five real violators lived.
    expect([...files.keys()].some((file) => file.startsWith(".metaproject/"))).toBe(true);
    // A `.mdc` rule file, an extension the first TEXT list omitted.
    expect([...files.keys()].some((file) => file.endsWith(".mdc"))).toBe(true);
  });

  test("no text extension in src/ is missing from the scanned list", () => {
    // The list of extensions is the guard's blind spot, so it is checked
    // against the tree instead of being trusted. A new text format that
    // nobody adds here would otherwise be unguarded and silently so.
    const binary = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".pdf", ".zip", ".gz",
      ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".node", ".snap", ".lock",
    ]);
    const unscanned = [...extensionsPresent()].filter(
      (extension) => !TEXT.includes(extension) && !binary.has(extension),
    );
    expect(unscanned).toEqual([]);
  });

  test("the four files that carried one still spell the separator as an escape", () => {
    // Named individually, because this is where the byte will come back: each
    // of these lines is a key separator someone may "simplify" by pasting the
    // character itself. The runtime string is identical either way, which is
    // what makes the regression invisible without this assertion.
    const files = textFiles();
    for (const file of [
      "src/sac/machine-wrap-up.ts",
      "src/lib/provider-config.ts",
      "src/gdskills/build-parity.test.ts",
    ]) {
      expect(files.get(file)).toContain("\\u0000");
    }
    expect(files.get("src/review/fixtures/consolidated-review-2026-08-01.md")).toContain("\\0");
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
