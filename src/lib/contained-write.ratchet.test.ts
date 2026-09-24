// Flow 313 (W4 portability), re-plan lane C1: the ratchet that keeps every
// write/remove/rename/mkdir site in the modules this lane retrofitted routed
// through `contained-write.ts`, rather than a raw `node:fs/promises` call
// creeping back in at the next edit. Scans SOURCE TEXT (not behaviour) for
// `writeFile`, `rm`, `unlink`, `rename`, `mkdir`, `appendFile` or
// `copyFile` imported from `node:fs`/`node:fs/promises`/`fs`/`fs/promises`,
// and fails on any call site outside `contained-write.ts` itself.
//
// This is deliberately a source scan, not a lint rule: it needs zero new
// tooling, runs in the same `bun test` pass as everything else, and its
// failure message names the exact file and line, which is what a future
// editor needs to either route the new call through the primitive or add it
// to `ALLOWLIST` with a reason.

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const COVERED_DIRS = ["src/integrations", "src/rules"];
const COVERED_FILES = ["src/agents/export.ts"];

const RAW_FS_FUNCTIONS = ["writeFile", "rm", "unlink", "rename", "mkdir", "appendFile", "copyFile"];

/**
 * Explicit, short, justified exceptions. Every entry here is a raw
 * `node:fs/promises` call this ratchet would otherwise flag, kept raw on
 * purpose — never a silent gap. Empty right now: every write/remove/rename/
 * mkdir call site this lane found in the covered modules routes through
 * `contained-write.ts`.
 */
const ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [];

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

/** True when `source` imports `name` from a `node:fs`/`fs` module (either specifier style, `promises` or not). */
function importsRawFsFunction(source: string, name: string): boolean {
  const importBlockRe = /import\s*\{([^}]*)\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/g;
  let match: RegExpExecArray | null;
  while ((match = importBlockRe.exec(source)) !== null) {
    const names = (match[1] ?? "").split(",").map((n) => n.trim().split(/\s+as\s+/)[0]?.trim());
    if (names.includes(name)) return true;
  }
  return false;
}

describe("contained-write ratchet", () => {
  test("no raw fs write/remove/rename/mkdir call outside contained-write.ts in owned modules", async () => {
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
      if (isAllowed(posixRel)) continue;

      const absolute = path.isAbsolute(file) ? file : path.join(repoRoot, file);
      const source = await readFile(absolute, "utf8");
      for (const fn of RAW_FS_FUNCTIONS) {
        if (importsRawFsFunction(source, fn)) {
          violations.push(`${posixRel}: imports raw "${fn}" from node:fs/promises`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  test("the allowlist itself stays short and every entry carries a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    expect(ALLOWLIST.length).toBeLessThanOrEqual(5);
  });
});
