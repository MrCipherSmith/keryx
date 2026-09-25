// R1-01 (flow 319, review round 1, blocker): the shipped `bin` (`dist/
// cli.js`, `package.json`'s `bin.keryx`) must carry the safe shebang —
// `#!/usr/bin/env -S bun --no-env-file --config=/dev/null` — not Bun's
// default `#!/usr/bin/env bun`, which auto-loads a `.env*`/`bunfig.toml`
// from the invoking shell's CURRENT WORKING DIRECTORY. See `src/cli.ts`'s
// own shebang comment and `src/lib/safe-exec.ts`.
//
// The build command is DERIVED from `package.json`'s own `build` script
// (only its `--outdir` is redirected to a throwaway tmp dir), the same
// method `src/core-package.test.ts` uses and explains at length: a copy of
// the flags here could drift from what `bun run build` really does, and this
// test's whole claim is about the artifact the release actually publishes.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const SAFE_SHEBANG = "#!/usr/bin/env -S bun --no-env-file --config=/dev/null";

function manifest(): { scripts: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
}

/**
 * The exact `bun build … src/cli.ts …` step from `package.json`'s `build`
 * script, with `--outdir` redirected to `outDir`. Throws (rather than
 * silently building something else) if the build script no longer has a
 * step for `src/cli.ts` — same fail-loud shape `core-package.test.ts`'s
 * `releaseBuildFor` uses.
 */
function cliBuildTokensFor(outDir: string): string[] {
  const script = manifest().scripts.build;
  if (script === undefined) {
    throw new Error("package.json has no build script; this guard has nothing to ask about");
  }
  for (const command of script.split("&&")) {
    const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
    const entryAt = tokens.findIndex((t) => t.endsWith("src/cli.ts"));
    if (entryAt === -1) continue;
    const outAt = tokens.findIndex((t) => t === "--outdir" || t.startsWith("--outdir="));
    if (outAt === -1) {
      throw new Error(`the cli.ts build step has no --outdir to redirect: ${command.trim()}`);
    }
    const rewritten = [...tokens];
    if ((tokens[outAt] as string).startsWith("--outdir=")) {
      rewritten[outAt] = `--outdir=${outDir}`;
    } else {
      rewritten[outAt + 1] = outDir;
    }
    return rewritten;
  }
  throw new Error("no `bun build` step in package.json's build script builds src/cli.ts");
}

let root = "";

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

test("the built dist/cli.js carries exactly the safe shebang", async () => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-cli-shebang-"));
  const tokens = cliBuildTokensFor(root);
  const proc = Bun.spawn(tokens, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  if (exit !== 0) {
    throw new Error(`build failed (exit ${exit}): ${err.slice(0, 400)}`);
  }
  const built = readFileSync(path.join(root, "cli.js"), "utf8");
  const firstLine = built.split("\n", 1)[0];
  expect(firstLine).toBe(SAFE_SHEBANG);
}, 60_000);

test("src/cli.ts's own source shebang is the same safe line (what bun build carries through verbatim)", () => {
  const source = readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
  const firstLine = source.split("\n", 1)[0];
  expect(firstLine).toBe(SAFE_SHEBANG);
});

// R3 (review round 3, contamination note): during this round a WORKER'S OWN
// uncommitted edit briefly replaced the guard call with `// TEMP-DISABLED-
// FOR-REGRESSION-CHECK-FLOW-319: await ensureSafeBunExec();` to do a manual
// red/green check, directly in the shipped source file — the reviewer had to
// re-run every form-b probe against a separately archived pristine copy to
// get a trustworthy result, and flagged that a temporary disable must never
// be left in (or even pass through) a shipped source file: for a red/green
// check, copy the file or inject a fake dependency, never comment out the
// real guard call in place. This test is the backstop for that class of
// mistake landing in a commit — it reads src/cli.ts and every file under
// src/ from disk each run (not a cached import), so it also catches the
// marker if it turns up somewhere other than cli.ts.
test("R3: src/cli.ts calls ensureSafeBunExec() unconditionally under import.meta.main — never commented out, never behind a marker", () => {
  const source = readFileSync(path.join(ROOT, "src", "cli.ts"), "utf8");
  const guardMarkerIndex = source.indexOf("ensureSafeBunExec()");
  expect(guardMarkerIndex).toBeGreaterThan(-1);

  // The call must sit on a line that is a REAL, uncommented `await
  // ensureSafeBunExec();` — not disabled, not merely mentioned in a comment.
  const lineStart = source.lastIndexOf("\n", guardMarkerIndex) + 1;
  const lineEndIdx = source.indexOf("\n", guardMarkerIndex);
  const line = source.slice(lineStart, lineEndIdx === -1 ? source.length : lineEndIdx).trim();
  expect(line.startsWith("//")).toBe(false);
  expect(line.startsWith("await ensureSafeBunExec()")).toBe(true);

  // And it must be reached unconditionally under `import.meta.main`, not
  // nested behind some other new condition that could quietly gate it off.
  const mainGuardIndex = source.indexOf("if (import.meta.main)");
  expect(mainGuardIndex).toBeGreaterThan(-1);
  expect(mainGuardIndex).toBeLessThan(guardMarkerIndex);
});

test("R3: no TEMP-DISABLED marker (a manual red/green check left in place) appears anywhere under src/", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const self = path.join(ROOT, "src", "cli-shebang.test.ts"); // this file legitimately DOCUMENTS the marker string; excluded from its own scan
  const offenders: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && full !== self) {
        const text = await readFile(full, "utf8").catch(() => "");
        if (text.includes("TEMP-DISABLED")) offenders.push(full);
      }
    }
  }
  await walk(path.join(ROOT, "src"));
  expect(offenders).toEqual([]);
});
