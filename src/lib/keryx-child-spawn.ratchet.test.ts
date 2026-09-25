// R2-02 (flow 319, review round 2, major): a ratchet — modelled on
// `src/lib/contained-write.ratchet.test.ts` — that keeps every site spawning
// `keryx`'s OWN interpreter (`process.execPath`), the bare `bun` binary, or a
// literal keryx CLI entry basename (`cli.ts`/`cli.js`) routed through
// `SAFE_BUN_SPAWN_ARGS` (`src/lib/safe-exec.ts`), rather than a raw
// `spawn(process.execPath, [scriptPath, ...])` creeping back in at the next
// edit. Scans SOURCE TEXT (not behaviour), so it needs no new tooling and
// runs in the same `bun test` pass as everything else.
//
// Why this matters: a child that runs `bun <script>` (as opposed to a
// compiled `keryx` binary, or `keryx` resolved via `PATH`, which goes
// through the shebang) bypasses `src/cli.ts`'s own shebang exactly the way
// `bun dist/cli.js` does — without `SAFE_BUN_SPAWN_ARGS` ahead of the script
// path, that child auto-loads whatever `.env`/`bunfig.toml` sits in ITS OWN
// cwd, defeating whatever the PARENT process already protected against (the
// exact class 18ab7fb2 fixed for six call sites, and this review round found
// a seventh family — `src/trigger/schedule.ts`'s `invocationArgv`, which
// `src/trigger/install.ts` and `src/tui/trigger-run-now.ts` both build their
// argv from — that had been missed).
//
// FILE granularity, like `contained-write.ratchet.test.ts`: a file that
// spawns `process.execPath`/`"bun"` anywhere must ALSO mention
// `SAFE_BUN_SPAWN_ARGS` somewhere in its own text. This does not prove the
// two are on the SAME call (a per-call AST check would), but it is enough to
// catch the shape of regression this round found — a NEW spawn site added to
// a file that has never needed the safe flags before — while staying a
// simple, dependency-free text scan.

import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

/**
 * Explicit, short, justified exceptions — every entry here is a file that
 * spawns `process.execPath`/`"bun"` WITHOUT the safe flags, on purpose.
 */
const ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly reason: string }> = [
  {
    file: "src/harness/web/web-worker-runner.ts",
    reason:
      'Spawns `[process.execPath, "--eval", WORKER_SOURCE]` — no script PATH at all (a `--eval` string, which Bun cannot auto-load a cwd `.env`/`bunfig.toml` preload FOR — there is no cwd-resolved entry file to attach one to), `cwd: "/"` and `env: {}` (no project directory, no environment to read a dotenv from in the first place). `SAFE_BUN_SPAWN_ARGS` would be inert here, not merely redundant (R2-02 review class_scope: "web-worker-runner (bun --eval, cwd=/, env={}) ... checked and excluded").',
  },
  {
    file: "src/lib/import-policy.ts",
    reason:
      '`Bun.spawn(["bun", "build", entry, "--outdir", outDir, ...])` — `bun build` COMPILES the target, it never EXECUTES it, so there is no `preload`/dotenv-driven code execution for the safe flags to guard against; `--no-env-file`/`--config=/dev/null` are runtime flags for `bun run`/`bun <script>`, not meaningful additions to a `bun build` invocation.',
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
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".ratchet.test.ts")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Every shape this ratchet catches: a `spawn`/`spawnSync`/`execFile`/
 * `execFileSync`/`Bun.spawn`/`Bun.spawnSync` call whose COMMAND argument is
 * `process.execPath` or the literal `"bun"`/`'bun'` — the two ways a call
 * site launches "this same interpreter" or "bun" rather than some unrelated
 * external tool (`git`, `gh`, `stty`, …), which this ratchet has no interest
 * in. `(?<!Bun\.)` on the bare-`spawn`/`spawn Sync` patterns avoids
 * double-counting a `Bun.spawn(` call already matched by its own pattern.
 */
const SELF_SPAWN_PATTERNS: readonly RegExp[] = [
  /\bBun\.spawn(?:Sync)?\(\s*\[\s*process\.execPath\b/,
  /\bBun\.spawn(?:Sync)?\(\s*\[\s*["']bun["']/,
  /(?<!Bun\.)\bspawn(?:Sync)?\(\s*process\.execPath\b/,
  /(?<!Bun\.)\bspawn(?:Sync)?\(\s*["']bun["']/,
  /\bexecFile(?:Sync)?\(\s*process\.execPath\b/,
  /\bexecFile(?:Sync)?\(\s*["']bun["']/,
];

function detectSelfSpawns(source: string): string[] {
  const hits: string[] = [];
  for (const pattern of SELF_SPAWN_PATTERNS) {
    const match = pattern.exec(source);
    if (match !== null) hits.push(`spawns "${match[0].trim()}" — this same interpreter or bun`);
  }
  return hits;
}

describe("keryx child-spawn ratchet (R2-02)", () => {
  test("every file that spawns process.execPath or bare `bun` also carries SAFE_BUN_SPAWN_ARGS, or is allowlisted with a reason", async () => {
    const repoRoot = path.resolve(__dirname, "../..");
    const files = await listTsFiles(path.join(repoRoot, "src"));

    const violations: string[] = [];
    for (const file of files) {
      const relFile = path.relative(repoRoot, file).split(path.sep).join("/");
      if (relFile === "src/lib/safe-exec.ts") continue; // defines SAFE_BUN_SPAWN_ARGS; its OWN re-exec spawn is exercised directly by safe-exec.test.ts.
      if (isAllowed(relFile)) continue;

      const source = await readFile(file, "utf8");
      const hits = detectSelfSpawns(source);
      if (hits.length === 0) continue;
      if (source.includes("SAFE_BUN_SPAWN_ARGS")) continue;
      for (const hit of hits) violations.push(`${relFile}: ${hit} — without SAFE_BUN_SPAWN_ARGS anywhere in the file`);
    }

    expect(violations).toEqual([]);
  });

  test("the allowlist itself stays short and every entry carries a reason", () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(10);
    }
    expect(ALLOWLIST.length).toBeLessThanOrEqual(4);
  });

  test("known self-spawn call sites (a literal `spawn(process.execPath, ...)`) are actually found by the scan (a positive control, so the patterns above are proven to match real code, not just proven not to false-positive)", async () => {
    const repoRoot = path.resolve(__dirname, "../..");
    // Only these two files contain the ACTUAL `spawn(...)` call text with
    // `process.execPath` as the literal command — the other four of the "six
    // sites fixed in 18ab7fb2" (builtins.ts, acp-run.ts,
    // metaproject-tools.ts, trigger-dispatch.ts) each build a REUSABLE argv
    // array (`[execPath, ...SAFE_BUN_SPAWN_ARGS, scriptPath, ...rest]`) that
    // the actual spawn happens at a call site elsewhere, through a variable —
    // exactly the "variable command" limitation the test below documents.
    // Every one of the six still carries `SAFE_BUN_SPAWN_ARGS` in its own
    // text (checked directly here, not via `detectSelfSpawns`), which is what
    // the main ratchet test above actually relies on.
    const literalSpawnSites = ["src/commands/gdgraph.ts", "src/tui/debug-watcher.ts"];
    for (const relFile of literalSpawnSites) {
      const source = await readFile(path.join(repoRoot, relFile), "utf8");
      expect(detectSelfSpawns(source).length).toBeGreaterThan(0);
    }
    const argvBuilderSites = [
      "src/harness/hooks/builtins.ts",
      "src/harness/external/acp-run.ts",
      "src/harness/tool/builtin/metaproject-tools.ts",
      "src/commands/trigger-dispatch.ts",
      ...literalSpawnSites,
    ];
    for (const relFile of argvBuilderSites) {
      const source = await readFile(path.join(repoRoot, relFile), "utf8");
      expect(source).toContain("SAFE_BUN_SPAWN_ARGS");
    }
  });

  test("detection shapes (mutation coverage)", () => {
    const shapes: ReadonlyArray<{ readonly name: string; readonly source: string }> = [
      { name: "node:child_process spawn(process.execPath, ...)", source: 'spawn(process.execPath, [scriptPath], {});' },
      { name: "node:child_process spawnSync(process.execPath, ...)", source: 'spawnSync(process.execPath, [scriptPath], {});' },
      { name: "Bun.spawn([process.execPath, ...])", source: "Bun.spawn([process.execPath, scriptPath], {});" },
      { name: 'Bun.spawn(["bun", ...])', source: 'Bun.spawn(["bun", "run", "x.ts"], {});' },
      { name: 'spawn("bun", ...)', source: 'spawn("bun", ["x.ts"], {});' },
      { name: "execFile(process.execPath, ...)", source: "execFile(process.execPath, [scriptPath], () => {});" },
      { name: "execFileSync(process.execPath, ...)", source: "execFileSync(process.execPath, [scriptPath]);" },
    ];
    for (const shape of shapes) {
      expect(detectSelfSpawns(shape.source).length).toBeGreaterThan(0);
    }
  });

  test("an unrelated external-tool spawn (git, gh, stty) is never flagged", () => {
    expect(detectSelfSpawns('Bun.spawn(["git", "status"], {});')).toEqual([]);
    expect(detectSelfSpawns('spawnSync("gh", ["pr", "view"], {});')).toEqual([]);
    expect(detectSelfSpawns('spawnSync("stty", ["-a"], {});')).toEqual([]);
  });

  test("a variable command (e.g. argv[0], not a literal) is not flagged — this ratchet is a text scan, not an AST check", () => {
    // This is a documented LIMITATION, not a gap left unhandled: sites like
    // `src/tui/trigger-run-now.ts` (`spawn(argv[0] as string, argv.slice(1),
    // ...)`) build their argv from `../trigger/schedule.ts`'s
    // `invocationArgv`, the single place SAFE_BUN_SPAWN_ARGS is inserted for
    // that whole family — proven instead by `src/trigger/schedule.test.ts`
    // ("a real script entry keeps [interpreter, ...safe flags, absolute
    // script]") and `src/tui/trigger-run-now.test.ts` (asserts the spawned
    // `args` include the two safe flags), not by this text scan.
    expect(detectSelfSpawns("spawn(argv[0] as string, argv.slice(1), {});")).toEqual([]);
  });
});
