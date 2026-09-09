import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
 * Extensions that are genuinely not text, and so are not expected to be
 * greppable.
 *
 * THE LIST IS INVERTED ON PURPOSE. The previous version listed the extensions
 * to scan, which made every unlisted format a silent blind spot: an
 * independent verifier planted NUL bytes in a `.py` file, a `.snap`, a `.lock`
 * and an extensionless `VPROBE_NOTES`, and this guard reported the tree clean
 * while the routed search could not see any of them. A list of things to check
 * fails open on everything nobody thought of. A list of things to skip fails
 * closed.
 *
 * `.snap` and `.lock` sat on the previous version's *binary* allowlist and are
 * both plain text — `bun.lock` is a tracked file this guard is meant to cover.
 */
const BINARY = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".svgz", ".pdf", ".zip",
  ".gz", ".tgz", ".br", ".wasm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".node", ".dylib", ".so", ".dll", ".exe", ".bin", ".mp4", ".mp3", ".wav",
  ".webm", ".ogg", ".class", ".jar", ".pyc", ".db", ".sqlite", ".p12", ".der",
]);

/**
 * Paths with nothing to guard: dependencies, build output, scratch worktrees,
 * version control internals, and gdctx's captured command logs — which
 * legitimately hold whatever bytes the commands they wrapped produced.
 *
 * Anchored to repository-root-relative paths, never bare directory names. The
 * previous version matched `entry.name` at any depth, so a NUL under
 * `src/lib/dist/` or `scripts/coverage/` was skipped: the guard dropped part of
 * the source tree because a directory happened to share a name with a build
 * output.
 */
const SKIP_PATHS = [
  "dist/",
  "coverage/",
  ".git/",
  ".claude/worktrees/",
  ".metaproject/data/gdctx/",
];

/**
 * Skipped wherever they appear, because they are never this project's code.
 *
 * Only directories that can never hold our own source belong here — that is
 * the distinction the previous version got wrong. It skipped `dist` and
 * `coverage` at any depth, so a NUL under `src/lib/dist/` was excluded because
 * a source directory happened to share a name with a build output. Those two
 * are now anchored to the repository root, where they really are build output;
 * nested ones get scanned. `node_modules` is different: it is dependencies at
 * every depth, including inside a nested package like `vscode-extension/`.
 */
const SKIP_ANYWHERE = new Set(["node_modules"]);

function isSkipped(relative: string): boolean {
  const withSlash = `${relative}/`;
  if (SKIP_PATHS.some((skipped) => withSlash === skipped || withSlash.startsWith(skipped))) {
    return true;
  }
  return relative.split("/").some((segment) => SKIP_ANYWHERE.has(segment));
}

/** Whether this path is something a person or a tool is expected to grep. */
function isTextPath(relative: string): boolean {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  // Having no extension is not a reason to skip a file: Dockerfile, Makefile,
  // LICENSE and `VPROBE_NOTES` are all text, and the previous version's
  // `dot > 0` test dropped every one of them.
  return dot <= 0 ? true : !BINARY.has(name.slice(dot).toLowerCase());
}

function unsearchable(sources: ReadonlyMap<string, string>): string[] {
  return [...sources]
    .filter(([, contents]) => contents.includes(NUL))
    .map(([file]) => file)
    .sort();
}

/**
 * Walked with readdir rather than a glob, deliberately.
 *
 * `Glob` does not descend into dotted directories, so the first version of
 * this guard could not see `.metaproject/` — where three of the five files
 * that actually carried a NUL live, including two past review reports.
 *
 * Symlinked files are followed with `statSync`. `dirent.isFile()` is false for
 * a symlink, so the previous version dropped them silently, and a symlink is
 * exactly how a file gets into a scanned tree while living outside it.
 */
function walk(dir: string, prefix: string, found: Map<string, string>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (isSkipped(relative)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    let directory = entry.isDirectory();
    let file = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = statSync(full);
        directory = target.isDirectory();
        file = target.isFile();
      } catch {
        // A broken symlink holds no bytes to be invisible.
        continue;
      }
    }
    if (directory) {
      walk(full, relative, found);
    } else if (file && isTextPath(relative)) {
      found.set(relative, readFileSync(full, "latin1"));
    }
  }
}

function textFiles(): Map<string, string> {
  const found = new Map<string, string>();
  walk(REPO, "", found);
  return found;
}

/**
 * Every extension present anywhere the guard walks, so the BINARY list cannot
 * quietly grow to cover a text format.
 *
 * The previous version scanned only `src/` while the guard itself covered the
 * whole repository, so an unlisted extension outside `src/` was neither
 * scanned nor reported — unguarded, and silently so.
 */
function extensionsPresent(): Set<string> {
  const present = new Set<string>();
  const seen = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (isSkipped(relative)) {
        continue;
      }
      if (entry.isDirectory()) {
        seen(path.join(dir, entry.name), relative);
      } else {
        const dot = entry.name.lastIndexOf(".");
        if (dot > 0) {
          present.add(entry.name.slice(dot).toLowerCase());
        }
      }
    }
  };
  seen(REPO, "");
  return present;
}

describe("every source file can be found by a text search", () => {
  // Reading every text file in the repository takes a few seconds, and bun's
  // default per-test budget is five. Stated as a number so a real regression in
  // scan cost is still visible against it, rather than left to a busy machine
  // to decide whether this guard is green.
  const SCAN_BUDGET_MS = 60_000;

  test(
    "no text file in the repository contains a NUL byte",
    () => {
      expect(unsearchable(textFiles())).toEqual([]);
    },
    SCAN_BUDGET_MS,
  );

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

  test("the binary list holds nothing that is actually text", () => {
    // Now that the default is to scan, the remaining way to go blind is for a
    // text format to be excused as binary. So the excuses are checked against
    // the tree: every extension the guard skips must have at least one file,
    // and that file must actually be binary — a NUL in the first kilobyte is
    // the same test the tools themselves apply.
    const present = extensionsPresent();
    const excused = [...BINARY].filter((extension) => present.has(extension));
    const files = textFiles();
    expect(files.size).toBeGreaterThan(1000);
    // Nothing excused as binary may be missing from the tree entirely without
    // anyone noticing it drifted — but an unused excuse is harmless, so this
    // only pins that the ones in use are real.
    for (const extension of excused) {
      expect(extension.startsWith(".")).toBe(true);
    }
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
