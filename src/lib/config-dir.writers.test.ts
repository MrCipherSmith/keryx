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
// Known limit, stated rather than hidden: this is textual. It catches a writer
// that calls `mkdirSync`/`writeFileSync` on a path built from one of the
// config-directory resolvers in the same file. A writer that launders the path
// through an unrelated helper first would slip past. It catches the failure
// that actually happened four times, not every possible one.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Glob } from "bun";
import path from "node:path";

const SRC = path.join(import.meta.dir, "..");

/** Functions that resolve a path inside the shared user-global directory. */
const CONFIG_PATH_RESOLVERS = [
  "keryxConfigDir(",
  "keryxDataDir(",
  "shellConfigPath(",
  "shellPermissionsPath(",
  "sandboxConfigPath(",
  "serveConfigPath(",
  "serveCredentialPath(",
  "projectRegistryPath(",
];

/** The two helpers that own the modes. A writer must reach the directory through one. */
const SANCTIONED_DIRECTORY_CALL = "ensureKeryxConfigDir(";

/**
 * Raw filesystem calls that create or write, and therefore decide a mode.
 *
 * `openSync(..., "wx", 0o600)` + `renameSync` is deliberately absent: rename
 * carries the temp file's mode, so those writers are correct by construction
 * and both are covered behaviourally in `config-dir.permissions.test.ts`.
 */
const RAW_DIRECTORY_CREATE = "mkdirSync(";
const RAW_FILE_WRITE = "writeFileSync(";

/**
 * Files exempt, each with the reason. A bare path is not accepted: an exemption
 * without a reason is indistinguishable from an oversight, which is the failure
 * this guard exists to prevent.
 */
const EXEMPTIONS: ReadonlyArray<{ file: string; reason: string }> = [
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

interface Offence {
  file: string;
  raw: string;
}

/**
 * The source with comments removed.
 *
 * Necessary, not tidy: the very comments explaining why a writer stopped
 * calling `writeFileSync` mention `writeFileSync`, so scanning raw text
 * reported `serve-config.ts` — a file that had just been fixed. A guard whose
 * first finding is a false positive teaches everyone to ignore it.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function sourceFiles(): string[] {
  return [...new Glob("**/*.ts").scanSync(SRC)]
    .map((relative) => relative.split(path.sep).join("/"))
    .filter((relative) => !relative.includes(".test."))
    .sort();
}

/** Files that both resolve a config path and write with a raw call. */
function offenders(): Offence[] {
  const exempt = new Set(EXEMPTIONS.map((exemption) => exemption.file));
  const found: Offence[] = [];
  for (const relative of sourceFiles()) {
    if (exempt.has(relative)) {
      continue;
    }
    const source = code(readFileSync(path.join(SRC, relative), "utf8"));
    if (!CONFIG_PATH_RESOLVERS.some((resolver) => source.includes(resolver))) {
      continue;
    }
    if (source.includes(RAW_DIRECTORY_CREATE) && !source.includes(SANCTIONED_DIRECTORY_CALL)) {
      found.push({ file: relative, raw: RAW_DIRECTORY_CREATE });
    }
    if (source.includes(RAW_FILE_WRITE)) {
      found.push({ file: relative, raw: RAW_FILE_WRITE });
    }
  }
  return found;
}

describe("every writer of the shared config directory goes through the helpers", () => {
  test("no un-exempt file both resolves a config path and writes raw", () => {
    expect(offenders()).toEqual([]);
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

  test("the detector can fail — a raw writer IS reported", () => {
    // Mutation-checking this guard from inside it, because a guard that has
    // never been observed failing is decorative. Reproduces the exact shape
    // `saveSandboxDefaults` had: resolve a config path, then write raw.
    const fixture = code('const p = sandboxConfigPath(dir);\nwriteFileSync(p, "{}", { mode: 0o600 });\n');
    const resolves = CONFIG_PATH_RESOLVERS.some((resolver) => fixture.includes(resolver));
    const writesRaw = fixture.includes(RAW_FILE_WRITE);
    expect(resolves && writesRaw).toBe(true);

    // And the comment stripper does not hide a real call: a writer whose raw
    // call sits on the same line as a trailing comment is still reported.
    const commented = code('writeFileSync(p, "{}"); // sandboxConfigPath(dir)\n');
    expect(commented.includes(RAW_FILE_WRITE)).toBe(true);
    expect(commented.includes("sandboxConfigPath(")).toBe(false);
  });
});
