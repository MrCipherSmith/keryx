// Nothing writes into the shared user-global config directory except through
// `ensureKeryxConfigDir` and `writeOwnerOnlyFile`.
//
// This is a SOURCE-level guard, and the reason is four consecutive review
// rounds. Each round produced a behavioural test over "every writer", each was
// honestly believed complete, and each covered a subset:
//
//   round 1  tightened `writeStore` only — four writers left creating the
//            directory 0775, with `auth.json` and its plaintext provider keys
//            group-replaceable.
//   round 3  swept four writers and missed `createSession`, which is the FIRST
//            thing to create that directory on a fresh install.
//   round 4  swept five and missed `saveShellPermissions` and
//            `saveSandboxDefaults` — the first of which decides which shell
//            commands are auto-approved without asking the operator.
//
// A behavioural test can only cover the writers whoever wrote it thought of. A
// test that reads the source can enumerate them, and fails when a new one
// appears. Same construction as the command-registry coverage guard, and for
// the same reason: derive the denominator from the code, then assert the
// complement is empty.
//
// LIMITS, measured rather than assumed. The first version of this header
// claimed the only gap was "a path laundered through another module"; a review
// then planted twelve writer shapes and this guard caught ONE. What it catches
// now, verified by `the detector reports every writer shape` below, is a file
// that both names a config-path resolver and calls any of `mkdirSync`,
// `writeFileSync`, `appendFileSync`, `copyFileSync`, `createWriteStream`,
// `writeSync`, `Bun.write`, or the `node:fs/promises` `writeFile`/`appendFile`/
// `copyFile`/`mkdir` — with string literals and comments removed first, so
// neither a glob nor an explanatory comment can hide or fake a call.
//
// What it still does not catch, and there is no test claiming otherwise:
//
//   - a path built in one module and written in another;
//   - a write behind a dynamic call (`fs[name](...)`);
//   - `renameSync` into place from a temp file created elsewhere in the tree.
//
// It catches the failures that actually happened, not every possible one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CONFIG_PATH_RESOLVERS,
  code,
  type Exemption,
  type Offence,
  scanFor,
  sourceFiles as scanSourceFiles,
  treeSources as scanTreeSources,
} from "./config-dir.scan";

const SRC = path.join(import.meta.dir, "..");

// `code`, the tree walk and `CONFIG_PATH_RESOLVERS` moved to
// `config-dir.scan.ts` when the reader-side guard was built, so the two guards
// cannot drift about what the source says or about which files count as
// touching the shared directory. What stays here is what is specific to writes:
// the call list, the exemptions, and the `offenders` seam the mutation test
// below drives.

/**
 * Raw filesystem calls that create or write, and therefore decide a mode.
 *
 * A review put twelve writer shapes into the tree and this list caught ONE. The
 * rest — `Bun.write`, `fs/promises`, `appendFileSync`, `copyFileSync`,
 * `openSync` + `writeSync`, `createWriteStream`, `renameSync` into place — went
 * straight past, while the header claimed the only gap was a path laundered
 * through another module. So the list is the set of ways a file or directory
 * actually gets created in this codebase, not the two that happened to be in
 * the diff that prompted it.
 *
 * `mkdirSync` is flagged UNCONDITIONALLY. It used to be flagged only in files
 * containing no `ensureKeryxConfigDir(` at all, which made a writer that
 * correctly created the root and then `mkdirSync`'d a mode-less subdirectory
 * inside it invisible — precisely the `sessions/` shape of the `createSession`
 * miss this guard exists for. Files that legitimately need it are exempted by
 * name, with a reason.
 */
const RAW_WRITE_CALLS = [
  "mkdirSync(",
  "writeFileSync(",
  "appendFileSync(",
  "copyFileSync(",
  "createWriteStream(",
  "writeSync(",
  "Bun.write(",
  // The `node:fs/promises` forms, matched by CALL name rather than by module
  // specifier. Matching the specifier does not work and the first version of
  // this list tried: the specifier is a string literal, and `code()` blanks
  // string literals before scanning, so `"node:fs/promises"` is gone by then.
  "writeFile(",
  "appendFile(",
  "copyFile(",
  "mkdir(",
] as const;

/**
 * Files exempt, each with the reason. A bare path is not accepted: an exemption
 * without a reason is indistinguishable from an oversight, which is the failure
 * this guard exists to prevent.
 */
const EXEMPTIONS: ReadonlyArray<Exemption> = [
  {
    file: "lib/config-dir.ts",
    reason: "defines the sanctioned helpers; it is the one place allowed to call mkdirSync and writeFileSync directly",
  },
  {
    file: "lib/file-lock.ts",
    reason:
      "creates the lock file's parent at 0700 and writes a lock file it removes again; generic over a lock path and not a config-file writer",
  },
  {
    file: "lib/serve-credential.ts",
    reason:
      "writes through openSync(wx, 0o600) + fsync + rename, which carries the mode; it does call ensureKeryxConfigDir for the directory",
  },
  {
    file: "lib/project-registry.ts",
    reason: "same temp+fsync+rename shape as the credential store; calls ensureKeryxConfigDir for the directory",
  },
  {
    file: "session/store.ts",
    reason:
      "creates a directory TREE below the shared root and forces 0700 down each level; calls ensureKeryxConfigDir for the root. Files are written temp+rename",
  },
];

function sourceFiles(): string[] {
  return scanSourceFiles(SRC);
}

/**
 * Files that both resolve a config path and write with a raw call.
 *
 * PURE over a `{ path -> source }` map, deliberately, and it stays a named
 * function here rather than an inlined `scanFor` call. The first version read
 * the tree itself, and its "the detector can fail" test then re-implemented the
 * predicate inline rather than calling this — so replacing the whole body with
 * `return []` left the file green with a real offender planted in the tree. A
 * guard whose self-check does not exercise the guard is the decorative shape
 * this file's own header warns about, reproduced inside it. This is the seam
 * that mutation targets; keep it.
 */
function offenders(sources: ReadonlyMap<string, string>): Offence[] {
  return scanFor(sources, { calls: RAW_WRITE_CALLS, exemptions: EXEMPTIONS });
}

/** The real source tree, as the map `offenders` consumes. */
function treeSources(): Map<string, string> {
  return scanTreeSources(SRC);
}

describe("every writer of the shared config directory goes through the helpers", () => {
  test("no un-exempt file both resolves a config path and writes raw", () => {
    expect(offenders(treeSources())).toEqual([]);
  });

  test("the scan actually reaches the source tree", () => {
    // Without this the assertion above passes vacuously if the glob root moves
    // — which is exactly how the flow-087 coverage guard was decorative.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("lib/shell-config.ts");
    expect(files).toContain("lib/shell-permissions.ts");
    expect(files).toContain("lib/sandbox-config.ts");
  });

  test("the scan finds files that genuinely resolve a config path", () => {
    // The complement being empty means nothing if the numerator is empty too.
    const resolving = sourceFiles().filter((relative) => {
      const source = code(readFileSync(path.join(SRC, relative), "utf8"));
      return CONFIG_PATH_RESOLVERS.some((resolver) => source.includes(resolver));
    });
    expect(resolving.length).toBeGreaterThanOrEqual(7);
  });

  test("every exemption names a file that exists and states a reason", () => {
    const files = new Set(sourceFiles());
    for (const exemption of EXEMPTIONS) {
      expect({ file: exemption.file, present: files.has(exemption.file) }).toEqual({
        file: exemption.file,
        present: true,
      });
      expect(exemption.reason.trim().length).toBeGreaterThan(20);
    }
  });

  test("the detector reports every writer shape, through offenders() itself", () => {
    // The version this replaces did NOT call `offenders()`. It re-implemented
    // the predicate inline, so it asserted that two string constants matched a
    // string literal — and a review replaced the whole body of `offenders()`
    // with `return []`, planted a real raw writer in the tree, and watched this
    // file stay green. That is the decorative shape the header above warns
    // about, reproduced inside the guard meant to prevent it.
    //
    // The fixtures are the twelve shapes the review used. Each resolves a config
    // path and writes; each must be reported.
    const shapes: ReadonlyArray<{ label: string; source: string }> = [
      { label: "writeFileSync", source: 'const p = sandboxConfigPath(dir);\nwriteFileSync(p, "{}");' },
      { label: "mkdirSync", source: "const p = keryxConfigDir(dir);\nmkdirSync(p, { recursive: true });" },
      {
        label: "mkdirSync on a SUBdirectory, with the root done correctly",
        source:
          "ensureKeryxConfigDir(dir);\nmkdirSync(path.join(keryxConfigDir(dir), 'cache'), { recursive: true });",
      },
      { label: "appendFileSync", source: 'appendFileSync(shellConfigPath(dir), "x");' },
      { label: "copyFileSync", source: "copyFileSync(a, projectRegistryPath(dir));" },
      { label: "createWriteStream", source: "createWriteStream(serveConfigPath(dir)).end();" },
      { label: "openSync + writeSync", source: 'const h = openSync(serveCredentialPath(dir), "w");\nwriteSync(h, "x");' },
      { label: "Bun.write", source: 'Bun.write(shellPermissionsPath(dir), "{}");' },
      {
        label: "fs/promises",
        source: 'import { writeFile } from "node:fs/promises";\nawait writeFile(keryxDataDir(), "x");',
      },
      {
        label: "a glob in a string literal, which used to swallow the write",
        source: 'const g = "**/*.json";\nwriteFileSync(sandboxConfigPath(dir), "{}");',
      },
      {
        label: "a raw call with a trailing comment naming the resolver",
        source: 'const p = sandboxConfigPath(dir);\nwriteFileSync(p, "{}"); // not through the helper',
      },
    ];

    const missed = shapes
      .filter((shape) => offenders(new Map([[`probe/${shape.label}.ts`, shape.source]])).length === 0)
      .map((shape) => shape.label);

    expect(missed).toEqual([]);
  });

  test("the detector does NOT report a file that goes through the helpers", () => {
    // The other half. Without it the assertion above is satisfied by a detector
    // that reports everything, which would be just as useless.
    const clean = new Map([
      [
        "probe/clean.ts",
        "ensureKeryxConfigDir(dir);\nwriteOwnerOnlyFile(serveConfigPath(dir), body);",
      ],
      ["probe/unrelated.ts", 'writeFileSync("/tmp/somewhere-else.txt", "x");'],
    ]);
    expect(offenders(clean)).toEqual([]);
  });

  test("an exempted file is not reported even when it writes raw", () => {
    // Pins that exemption is what silences a file, so removing one from the
    // list has to make the tree scan fail rather than quietly changing nothing.
    const file = EXEMPTIONS[0]!.file;
    const raw = new Map([[file, 'writeFileSync(keryxConfigDir(dir), "x");']]);
    expect(offenders(raw)).toEqual([]);
  });

  test("the comment stripper removes comments without removing code", () => {
    const stripped = code('writeFileSync(p, "{}"); // sandboxConfigPath(dir)\n');
    expect(stripped).toContain("writeFileSync(");
    expect(stripped).not.toContain("sandboxConfigPath(");

    // A glob literal must not open a block comment and eat the rest of the file.
    const withGlob = code('const g = "**/*.json";\nwriteFileSync(p, "{}");\n');
    expect(withGlob).toContain("writeFileSync(");

    // Nor may a `//` inside a string literal delete the line it sits on.
    const withUrl = code('const s = "a // b";\nwriteFileSync(p, "{}");\n');
    expect(withUrl).toContain("writeFileSync(");
  });
});
