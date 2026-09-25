// Flow 313 (W4 portability), re-plan lane C1 + round-4 fix (R4-F1): the
// ratchet that keeps every write/remove/rename/mkdir site in the modules
// this lane retrofitted routed through `contained-write.ts`, rather than a
// raw `node:fs/promises` call creeping back in at the next edit. Scans
// SOURCE TEXT (not behaviour), so it needs zero new tooling and runs in the
// same `bun test` pass as everything else; its failure message names the
// exact file and the shape it caught.
//
// Round 4 review (R4-F1) found this only caught 3 of 13 realistic raw-write
// shapes (a plain `import { writeFile }`, aliased, or multi-line — every
// namespace import (`fsp.writeFile`), default import (`fs.writeFileSync`),
// `*Sync` variant, `Bun.write`, `open(p, "w")`, `createWriteStream`, a
// dynamic `import("node:fs/promises")`, and `lib/fs.ts`'s own
// `writeFileAtomic` wrapper all passed uncaught), and did not scan
// `src/bundle`, `src/lib/private-dir.ts` or `src/commands/{rules,update}.ts`
// at all. This rewrite widens both: `WRITE_VERBS` covers every shape the
// review listed, `detectRawWrites` matches each one against named imports,
// aliased namespace/default imports of `node:fs`/`node:fs/promises`, `Bun.write`,
// a dynamic `fs` import, and `writeFileAtomic`; `COVERED_DIRS`/`COVERED_FILES`
// now includes the modules the review named.

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

// R700-04 (review round PR #700): widened to cover the modules the review
// named as writing through raw `node:fs` primitives outside the ratchet's
// reach — `src/learning`, `src/security/impact-evidence`,
// `src/security/audit-harness`, `src/stack` and the `gdskills`
// manifest/governance subtrees. Each directory added here was first checked
// by hand for any file NOT owned by this fix (flow 319 lane B) that also
// writes raw — none did, so widening to the whole directory (rather than
// per-file) does not risk flagging a file this lane cannot fix.
const COVERED_DIRS = [
  "src/integrations",
  "src/rules",
  "src/bundle",
  "src/learning",
  "src/security/impact-evidence",
  "src/security/audit-harness",
  "src/stack",
  "src/gdskills/manifest",
  "src/gdskills/governance",
];
const COVERED_FILES = [
  "src/agents/export.ts",
  "src/agents/bootstrap.ts",
  "src/lib/private-dir.ts",
  "src/commands/rules.ts",
  "src/commands/update.ts",
  "src/commands/security-audit-harness.ts",
  "src/lib/install-plan.ts",
  "src/commands/init.ts",
  "src/testing/service.ts",
  "src/lib/metaproject-gitignore.ts",
  "src/lib/project-sandbox-policy.ts",
  "src/assets/seed.ts",
  "src/gdskills/install.ts",
  "src/gdskills/guarded-fs-ops.ts",
  "src/lib/routing-entrypoint.ts",
  "src/mcp/client-config.ts",
  "src/capability/registry.ts",
  "src/lib/managed-git-hook.ts",
];

/** Every write/remove/rename/mkdir-shaped `node:fs`/`node:fs/promises` export the review's 13 shapes exercise. */
const WRITE_VERBS = [
  "writeFile",
  "writeFileSync",
  "rm",
  "rmSync",
  "unlink",
  "unlinkSync",
  "rename",
  "renameSync",
  "mkdir",
  "mkdirSync",
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "rmdir",
  "rmdirSync",
  "chmod",
  "chmodSync",
  "truncate",
  "truncateSync",
  "symlink",
  "symlinkSync",
  "link",
  "linkSync",
  "cp",
  "cpSync",
  "open",
  "openSync",
  "createWriteStream",
  "utimes",
  "utimesSync",
];

/**
 * Explicit, short, justified exceptions. Every entry here is a raw
 * `node:fs/promises` write this ratchet would otherwise flag, kept raw on
 * purpose — never a silent gap. File-granularity (the ratchet scans source
 * text, not call sites), so each reason names EVERY raw call the file still
 * makes.
 */
const ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  {
    file: "src/lib/private-dir.ts",
    reason: "Creates the private-dir .gitignore with O_EXCL (open 'wx') by design — the primitive it would otherwise route through does not offer exclusive-create-only semantics distinct from writeContained's own 'exclusive' option, and this predates it (R4-F1 allowlist).",
  },
  {
    file: "src/bundle/export.ts",
    reason: "Writes the exported archive/manifest to the USER'S OWN chosen output path (--out), which is deliberately outside any project/scope containment boundary — not a Keryx-managed location (R4-F1 allowlist, matches the round-4 site enumeration).",
  },
  {
    file: "src/bundle/audit.ts",
    reason: "Stages bundle content inside its own mkdtemp-created private temp directory (never a project/scope path) purely to run format checks against real files on disk (R4-F1 allowlist).",
  },
  {
    file: "src/bundle/external.ts",
    reason: "Writes the external-imports key/registry/lock under ~/.keryx/state with its own strict lstat/O_EXCL checks (R3-I3, tracked separately) rather than the project/scope containment this primitive enforces (R4-F1 allowlist).",
  },
  {
    file: "src/bundle/apply.ts",
    reason: "mkdirRecordingCreated's raw mkdir and the rollback's raw rmdir are mitigated: refuseSymlinkChain re-checks the scope root and every segment immediately before each write in the same loop, and rollback's rmdir only ever removes a directory this same apply just created and is a no-op if non-empty (R4-F1 allowlist, matches the round-4 site enumeration).",
  },
  {
    file: "src/gdskills/guarded-fs-ops.ts",
    reason: "R2-F3 fix: the raw `unlink` (removeStaleRuntimeBuilds, removeUnmodifiedRetiredRules) and raw `cp` (copyDirectoryContained) install.ts's whole-file entry used to cover for ANY raw write in that file now live in this small, dedicated module ALONE — install.ts itself carries no allowlist entry and is fully ratcheted, matching the R1-F3 fix already applied to init.ts/update.ts. Every export here keeps its own, more discriminating containment right next to the raw call: unlink only ever fires after an `lstat`+`realpath` walk that refuses a symlinked skills root, category, or skill directory (see removeStaleRuntimeBuilds's doc comment) or an `lstat`-confirmed-regular-file retired rule; copyDirectoryContained's callers `mkdirContained` (R1-F1 fix) the target immediately before calling it, confirming it resolves inside metaprojectRoot with no escaping symlink on the way (flow 315 T16 allowlist).",
  },
  {
    file: "src/gdskills/governance/judge-recordings.ts",
    reason:
      "R700-04 allowlist: writes a recording keyed by a schema-validated `pack/skill` id under this module's OWN packaged `judge-recordings/` directory (or a test-only KERYX_JUDGE_RECORDINGS_DIR override), never into a user project tree, through a synchronous `writeJudgeRecording` whose only non-test caller (src/commands/skills-governance.ts, a different lane's file) calls it synchronously — converting to the async containment primitive would require changing that caller too.",
  },
  {
    file: "src/gdskills/governance/scout.ts",
    reason:
      "R700-04 allowlist: recordScout is a synchronous append into a stack pack's own governance/scout.json, called synchronously from src/commands/skills-governance.ts (a different lane's file) — same sync-API constraint as judge-recordings.ts, so converting to the async containment primitive would require changing that unowned caller too.",
  },
  {
    file: "src/gdskills/governance/stocktake.ts",
    reason:
      "R700-04 allowlist: runStocktake's cache/report writes are synchronous and its only non-test caller (src/commands/skills-governance.ts, a different lane's file, which the orchestrator asked this lane not to touch the output paths/gitignore of) reads its return value synchronously — converting to the async containment primitive would require changing that unowned caller too.",
  },
  {
    file: "src/lib/managed-git-hook.ts",
    reason: "installManagedHook/removeManagedHook write into .git/hooks by design (a managed git hook) — contained-write.ts categorically refuses any .git path segment, so this module keeps raw mkdir/writeFile/chmod. R1-F3/R1-F6 fix: this is now the ONE shared copy (deduplicated out of init.ts and update.ts, which no longer contain raw hook writes and carry no allowlist entry of their own), and unlike the old per-command comment this module actually verifies containment itself before writing — it lstat/realpath-checks that both the hooks directory and the target hook file resolve inside the git common dir resolveGitHooksRoot derived from, refusing (not silently writing through) a hooks dir or hook file symlinked elsewhere (flow 315 T12 allowlist).",
  },
];

function isAllowed(file: string): boolean {
  return ALLOWLIST.some((entry) => entry.file === file);
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/** Every alias a source binds to the `node:fs`/`node:fs/promises` module object itself — `import * as X` or `import X` (the default export mirrors the namespace for both specifiers in Node/Bun). */
function fsModuleAliases(source: string): string[] {
  const aliases: string[] = [];
  const nsRe = /import\s*\*\s*as\s+(\w+)\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g;
  const defaultRe = /import\s+(\w+)\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g;
  let m: RegExpExecArray | null;
  while ((m = nsRe.exec(source)) !== null) if (m[1]) aliases.push(m[1]);
  while ((m = defaultRe.exec(source)) !== null) if (m[1]) aliases.push(m[1]);
  return aliases;
}

/** True when `source` imports `name` from a `node:fs`/`fs` module (either specifier style, `promises` or not), across a possibly multi-line `{ ... }` import block. */
function importsRawFsFunction(source: string, name: string): boolean {
  const importBlockRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g;
  let match: RegExpExecArray | null;
  while ((match = importBlockRe.exec(source)) !== null) {
    const names = (match[1] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.trim());
    if (names.includes(name)) return true;
  }
  return false;
}

/** Every raw-write shape this ratchet catches, named for the failure message. */
function detectRawWrites(source: string): string[] {
  const hits: string[] = [];

  for (const fn of WRITE_VERBS) {
    if (importsRawFsFunction(source, fn)) {
      hits.push(`imports raw "${fn}" from node:fs/promises`);
    }
  }

  const aliases = fsModuleAliases(source);
  for (const alias of aliases) {
    for (const fn of WRITE_VERBS) {
      const re = new RegExp(`\\b${alias}\\.${fn}\\s*\\(`);
      if (re.test(source)) {
        hits.push(`calls "${alias}.${fn}(" — a namespace/default import of node:fs used as a raw writer`);
      }
    }
  }

  if (/\bBun\.write\s*\(/.test(source)) {
    hits.push('calls "Bun.write(" directly, bypassing the containment primitive');
  }

  // A dynamic `await import("node:fs/promises")` destructured into names,
  // e.g. `const { writeFile } = await import("node:fs/promises")` — checked
  // against the SAME write-verb list as a static import, so a read-only
  // dynamic import (`{ readFile }`) or a type-only reference
  // (`import("node:fs").Dirent`, which is never destructured) is not
  // flagged.
  const dynamicImportRe = /const\s*\{([^}]*)\}\s*=\s*await\s+import\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g;
  let dynMatch: RegExpExecArray | null;
  while ((dynMatch = dynamicImportRe.exec(source)) !== null) {
    const names = (dynMatch[1] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.trim());
    for (const fn of WRITE_VERBS) {
      if (names.includes(fn)) {
        hits.push(`dynamically imports raw "${fn}" from node:fs/promises`);
      }
    }
  }
  // Namespace-style dynamic import: `const fsp = await import("node:fs/promises"); fsp.writeFile(...)`.
  const dynamicNsRe = /const\s+(\w+)\s*=\s*await\s+import\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g;
  let dynNsMatch: RegExpExecArray | null;
  while ((dynNsMatch = dynamicNsRe.exec(source)) !== null) {
    const alias = dynNsMatch[1];
    if (!alias) continue;
    for (const fn of WRITE_VERBS) {
      if (new RegExp(`\\b${alias}\\.${fn}\\s*\\(`).test(source)) {
        hits.push(`dynamically imports node:fs as "${alias}" and calls "${alias}.${fn}("`);
      }
    }
  }

  // R1-F7: parses the `lib/fs` import BLOCK for every name it binds
  // `writeFileAtomic` to — the plain name, or an alias via `as` — rather
  // than just checking the unaliased name appears as a call anywhere in the
  // file. `import { writeFileAtomic as w } from "../lib/fs"; w(p, c);` used
  // to pass uncaught: `writeFileAtomic(` never occurred literally, so the
  // old regex's `\bwriteFileAtomic\s*\(` half never matched.
  for (const alias of libFsImportAliases(source, "writeFileAtomic")) {
    if (new RegExp(`\\b${alias}\\s*\\(`).test(source)) {
      hits.push(
        alias === "writeFileAtomic"
          ? 'imports and calls "writeFileAtomic" from lib/fs — a raw-write wrapper, not the containment primitive'
          : `imports "writeFileAtomic" from lib/fs aliased as "${alias}" and calls it — a raw-write wrapper, not the containment primitive`,
      );
    }
  }

  return hits;
}

/**
 * Every alias `source`'s `lib/fs` import block binds `name` to — the plain
 * name (no `as`) or an aliased one.
 *
 * R2-F4: the specifier half matches every relative form that resolves to
 * `src/lib/fs.ts` — `"lib/fs"`, `"./lib/fs"`, `"../lib/fs"` (any number of
 * leading `../` segments), AND the sibling-import form a file already inside
 * `src/lib` uses to reach it, `"./fs"` / `"../fs"` — each with or without an
 * explicit `.ts` extension. The old regex required a literal `lib/` path
 * segment, so `metaproject-gitignore.ts`, `routing-entrypoint.ts`,
 * `install-plan.ts`, and `project-sandbox-policy.ts` (all of which live in
 * `src/lib` and import their sibling `fs.ts` as `"./fs"`) were never even
 * checked for a raw `writeFileAtomic` import — this widens the check to
 * cover them too, not just files reaching `lib/fs` from elsewhere in the
 * tree.
 */
function libFsImportAliases(source: string, name: string): string[] {
  const aliases: string[] = [];
  const importBlockRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:\.\.?\/)*(?:lib\/)?fs(?:\.ts)?["']/g;
  let match: RegExpExecArray | null;
  while ((match = importBlockRe.exec(source)) !== null) {
    const names = (match[1] ?? "").split(",").map((n) => n.trim()).filter((n) => n.length > 0);
    for (const entry of names) {
      const parts = entry.split(/\s+as\s+/).map((p) => p.trim());
      if (parts[0] === name) {
        aliases.push(parts[1] ?? parts[0]);
      }
    }
  }
  return aliases;
}

describe("contained-write ratchet", () => {
  test("no raw fs write/remove/rename/mkdir shape outside contained-write.ts in owned modules", async () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const files: string[] = [...COVERED_FILES];
    for (const dir of COVERED_DIRS) {
      files.push(...(await listTsFiles(path.join(repoRoot, dir))));
    }

    const violations: string[] = [];
    for (const file of files) {
      const relFile = path.relative(repoRoot, path.isAbsolute(file) ? file : path.join(repoRoot, file));
      const posixRel = relFile.split(path.sep).join("/");
      if (posixRel === "src/lib/contained-write.ts") continue;
      if (posixRel === "src/lib/symlink-safety.ts") continue;
      if (isAllowed(posixRel)) continue;

      const absolute = path.isAbsolute(file) ? file : path.join(repoRoot, file);
      const source = await readFile(absolute, "utf8");
      for (const hit of detectRawWrites(source)) {
        violations.push(`${posixRel}: ${hit}`);
      }
    }

    expect(violations).toEqual([]);
  });

  test("the allowlist itself stays short and every entry carries a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    // R700-04: raised from 8 to 11 for three sync-API exemptions
    // (judge-recordings.ts, scout.ts, stocktake.ts) — each justified above,
    // never bumped just to make a violation go away.
    expect(ALLOWLIST.length).toBeLessThanOrEqual(11);
  });
});

describe("contained-write ratchet: detection shapes (mutation coverage, R4-F1)", () => {
  const shapes: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
    { name: "named import", source: 'import { writeFile } from "node:fs/promises";\nwriteFile(a, b);' },
    { name: "aliased named import", source: 'import { writeFile as wf } from "node:fs/promises";\nwf(a, b);' },
    {
      name: "multi-line named import",
      source: 'import {\n  readFile,\n  writeFile,\n} from "node:fs/promises";\nwriteFile(a, b);',
    },
    { name: "namespace import (fsp.writeFile)", source: 'import * as fsp from "node:fs/promises";\nfsp.writeFile(a, b);' },
    { name: "default import (fs.writeFileSync)", source: 'import fs from "node:fs";\nfs.writeFileSync(a, b);' },
    { name: "sync named import", source: 'import { writeFileSync } from "node:fs";\nwriteFileSync(a, b);' },
    { name: "Bun.write", source: "Bun.write(a, b);" },
    { name: "dynamic namespace import", source: 'const fsp = await import("node:fs/promises");\nfsp.writeFile(a, b);' },
    { name: "dynamic destructured import", source: 'const { writeFile } = await import("node:fs/promises");\nwriteFile(a, b);' },
    { name: "open(p, \"w\") plus handle.writeFile", source: 'import { open } from "node:fs/promises";\nconst h = await open(p, "w");' },
    { name: "writeFileAtomic from lib/fs", source: 'import { writeFileAtomic } from "../lib/fs";\nawait writeFileAtomic(p, c);' },
    {
      name: "aliased writeFileAtomic from lib/fs (R1-F7)",
      source: 'import { writeFileAtomic as w } from "../lib/fs";\nawait w(p, c);',
    },
    {
      name: "writeFileAtomic from sibling \"./fs\" (R2-F4)",
      source: 'import { writeFileAtomic } from "./fs";\nawait writeFileAtomic(p, c);',
    },
    {
      name: "writeFileAtomic from \"../fs.ts\" with an explicit extension (R2-F4)",
      source: 'import { writeFileAtomic } from "../fs.ts";\nawait writeFileAtomic(p, c);',
    },
    {
      name: "writeFileAtomic from \"../lib/fs.ts\" with an explicit extension (R2-F4)",
      source: 'import { writeFileAtomic } from "../lib/fs.ts";\nawait writeFileAtomic(p, c);',
    },
    { name: "createWriteStream", source: 'import { createWriteStream } from "node:fs";\ncreateWriteStream(p);' },
    { name: "rmSync", source: 'import { rmSync } from "node:fs";\nrmSync(p);' },
    { name: "namespace mkdir", source: 'import * as fs from "node:fs/promises";\nfs.mkdir(p, { recursive: true });' },
  ];

  for (const shape of shapes) {
    test(`catches: ${shape.name}`, () => {
      expect(detectRawWrites(shape.source).length).toBeGreaterThan(0);
    });
  }

  test("a read-only import (readFile) is never flagged", () => {
    expect(detectRawWrites('import { readFile } from "node:fs/promises";\nreadFile(p);')).toEqual([]);
  });

  test("a read-only dynamic import is never flagged", () => {
    expect(detectRawWrites('const { readFile } = await import("node:fs/promises");\nreadFile(p);')).toEqual([]);
  });

  test("a type-only import(\"node:fs\") reference is never flagged", () => {
    expect(detectRawWrites('let entries: import("node:fs").Dirent[];')).toEqual([]);
  });

  test("R2-F4: an unrelated name imported from a sibling \"./fs\" is never flagged", () => {
    // The widened specifier match (R2-F4) only matters for the `writeFileAtomic`
    // name it looks for — an ordinary read-only helper reached the same way
    // (e.g. `pathExists` from `./fs`, as metaproject-gitignore.ts does) must
    // stay silent.
    expect(detectRawWrites('import { pathExists } from "./fs";\nawait pathExists(p);')).toEqual([]);
  });
});

describe("contained-write ratchet: R2-F3 (install.ts is no longer whole-file allowlisted)", () => {
  test("src/gdskills/install.ts carries no allowlist entry of its own", () => {
    expect(isAllowed("src/gdskills/install.ts")).toBe(false);
  });

  test("src/gdskills allowlist entries are exactly guarded-fs-ops.ts plus the R700-04 sync-API exemptions", () => {
    // R700-04 widened `src/gdskills/manifest` and `src/gdskills/governance`
    // into COVERED_DIRS — every file in those subtrees is now scanned, and
    // judge-recordings.ts/scout.ts/stocktake.ts are exempted (sync API, an
    // unowned caller) rather than converted. Anything else under
    // `src/gdskills/` reintroducing a raw write is still caught.
    const gdskillsEntries = ALLOWLIST.filter((entry) => entry.file.startsWith("src/gdskills/"));
    expect(gdskillsEntries.map((entry) => entry.file).sort()).toEqual(
      [
        "src/gdskills/guarded-fs-ops.ts",
        "src/gdskills/governance/judge-recordings.ts",
        "src/gdskills/governance/scout.ts",
        "src/gdskills/governance/stocktake.ts",
      ].sort(),
    );
  });

  test("a raw writeFile reintroduced into install.ts's text would be caught", () => {
    // Before this fix, `isAllowed("src/gdskills/install.ts")` was true — the
    // whole-file allowlist entry that existed to keep install.ts's guarded
    // `cp`/`unlink` calls also exempted every OTHER raw write shape in the
    // same file, so this text would have been skipped before `detectRawWrites`
    // ever ran on it (R2-F3). Now the file carries no allowlist entry, so the
    // main ratchet test's loop actually scans it, and a reintroduced raw
    // `writeFile` — the exact shape R1-F1 fixed — is flagged like any other
    // covered file.
    const reintroducedRawWrite = [
      'import { writeFile } from "node:fs/promises";',
      "",
      "async function installSkillManifest(target: string, content: string) {",
      "  await writeFile(target, content);",
      "}",
    ].join("\n");
    expect(isAllowed("src/gdskills/install.ts")).toBe(false);
    expect(detectRawWrites(reintroducedRawWrite).length).toBeGreaterThan(0);
  });

  test("a raw copyFile reintroduced into install.ts's text would be caught", () => {
    const reintroducedRawCopy = [
      'import { copyFile } from "node:fs/promises";',
      "",
      "async function installSkillFile(source: string, target: string) {",
      "  await copyFile(source, target);",
      "}",
    ].join("\n");
    expect(isAllowed("src/gdskills/install.ts")).toBe(false);
    expect(detectRawWrites(reintroducedRawCopy).length).toBeGreaterThan(0);
  });
});
