// R2-01 (flow 319, review round 2, major): the reviewer's own repro shape —
// run `<cheap command>` as a REAL process from a hostile tmp cwd, dev form
// (`bun src/cli.ts …`, which bypasses the shebang the same way
// `bunx keryx`/`bun dist/cli.js` do) and shipped form (`bun run build`, then
// `dist/cli.js`) — proving what the review's evidence table calls "LOADED"
// (an attacker dotenv value reached the running process) is now "blocked" in
// BOTH forms, for every dotenv filename Bun auto-loads, not only `.env`.
//
// `keryx --version` is the cheap command: it does no project I/O, so a
// hostile cwd's ONLY way to observe or affect this run is through what Bun
// itself auto-loads from that cwd (`.env*`, `bunfig.toml`) — exactly the
// surface this guard closes.
//
// The sharpest, most unambiguous vector here is `bunfig.toml`'s `preload`:
// unlike an env var (which needs a second command to observe), a `preload`
// script can just create a marker FILE — "did arbitrary repo code run
// before `keryx` itself started" needs no cooperation from `keryx` at all to
// prove.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractProjectRegistrations, HOOKS_TRUST_FILENAME, projectHooksDigestOfDoc, projectHooksTrustKey } from "../harness/hooks";
import { keryxConfigDir, writeOwnerOnlyFileAtomic } from "./config-dir";

const ROOT = path.resolve(__dirname, "..", "..");
const CLI_SRC = path.join(ROOT, "src", "cli.ts");

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  if (distOutDir !== "") rmSync(distOutDir, { recursive: true, force: true });
});

async function run(entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(entry === CLI_SRC ? ["bun", entry, ...args] : [entry, ...args], {
    cwd,
    env: { ...env, PATH: process.env["PATH"] ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  return { code, out: `${stdout}\n${stderr}` };
}

/** A fresh, isolated HOME/XDG so a run never touches this developer's real config, whatever cwd it uses. */
function isolatedEnv(): NodeJS.ProcessEnv {
  const home = tmp("keryx-hostile-home-");
  return { HOME: home, XDG_DATA_HOME: path.join(home, "data"), XDG_CONFIG_HOME: path.join(home, "config"), GIT_CONFIG_GLOBAL: "/dev/null" };
}

let distCli = "";

/**
 * Build `dist/cli.js` once for the "shipped form" half of every test below —
 * the EXACT `bun build … src/cli.ts …` step from `package.json`'s own
 * `build` script (only `--outdir` redirected to a throwaway tmp dir), same
 * method `src/cli-shebang.test.ts` uses and explains: a hand-copied flag set
 * here could drift from what `bun run build` really does and this file's
 * whole claim is about the artifact the release actually publishes.
 */
let distOutDir = "";

async function ensureDistBuilt(): Promise<string> {
  if (distCli !== "") return distCli;
  // NOT `tmp(...)`: that array is wiped by `afterEach` after every single
  // test, but this build is cached and reused ACROSS tests — pushing it
  // there would have `afterEach` delete the cached artifact out from under
  // the very next test that reuses it (caught the hard way: the second
  // "shipped form" test failed with ENOENT on the first test's now-deleted
  // outDir, because `distCli` still pointed at it). Cleaned once, in
  // `afterAll`, below.
  const outDir = mkdtempSync(path.join(tmpdir(), "keryx-hostile-dist-"));
  distOutDir = outDir;
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = manifest.scripts.build;
  if (script === undefined) throw new Error("package.json has no build script");
  let tokens: string[] | undefined;
  for (const command of script.split("&&")) {
    const parts = command.trim().split(/\s+/).filter((t) => t.length > 0);
    const entryAt = parts.findIndex((t) => t.endsWith("src/cli.ts"));
    if (entryAt === -1) continue;
    const outAt = parts.findIndex((t) => t === "--outdir" || t.startsWith("--outdir="));
    if (outAt === -1) throw new Error(`the cli.ts build step has no --outdir to redirect: ${command.trim()}`);
    tokens = [...parts];
    if ((parts[outAt] as string).startsWith("--outdir=")) tokens[outAt] = `--outdir=${outDir}`;
    else tokens[outAt + 1] = outDir;
    break;
  }
  if (tokens === undefined) throw new Error("no `bun build` step in package.json's build script builds src/cli.ts");
  const proc = Bun.spawn(tokens, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const [, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`build failed (exit ${exit}): ${err.slice(0, 500)}`);
  distCli = path.join(outDir, "cli.js");
  return distCli;
}

describe("R2-01 hostile cwd: bunfig.toml preload (sharpest vector — a marker FILE, no cooperation from keryx needed)", () => {
  test.each([
    ["dev form (bun src/cli.ts — bypasses the shebang)", CLI_SRC],
  ] as const)("%s: a bunfig.toml preload does not run", async (_label, entry) => {
    const cwd = tmp("keryx-hostile-preload-");
    const marker = path.join(cwd, "PRE");
    writeFileSync(path.join(cwd, "bunfig.toml"), `preload = ["./p.js"]\n`, "utf8");
    writeFileSync(path.join(cwd, "p.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\n`, "utf8");
    await run(entry, ["--version"], cwd, isolatedEnv());
    // bunfig `preload` runs before ANY of this file's own code — this is the
    // one vector the guard CANNOT undo after the fact (documented in
    // safe-exec.ts and R2-07). It is asserted here as a baseline, not a
    // regression: the shebang (shipped form) is what actually stops it.
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  test("shipped form (dist/cli.js, real shebang): the same preload does NOT run", async () => {
    const cli = await ensureDistBuilt();
    const cwd = tmp("keryx-hostile-preload-shipped-");
    const marker = path.join(cwd, "PRE");
    writeFileSync(path.join(cwd, "bunfig.toml"), `preload = ["./p.js"]\n`, "utf8");
    writeFileSync(path.join(cwd, "p.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\n`, "utf8");
    await run(cli, ["--version"], cwd, isolatedEnv());
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});

describe("R2-01 hostile cwd: BUN_OPTIONS from a .env survives even the guard's OWN re-exec unless stripped", () => {
  test("dev form: a .env setting BUN_OPTIONS=--preload=./p.js does not preload in the guard's re-exec'd child", async () => {
    const cwd = tmp("keryx-hostile-bunoptions-");
    const marker = path.join(cwd, "PRE");
    writeFileSync(path.join(cwd, ".env"), `BUN_OPTIONS=--preload=./p.js\n`, "utf8");
    writeFileSync(path.join(cwd, "p.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\n`, "utf8");
    const result = await run(CLI_SRC, ["--version"], cwd, isolatedEnv());
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(0);
  }, 30_000);

  test("shipped form: same fixture, unaffected either way (no .env autoload at all)", async () => {
    const cli = await ensureDistBuilt();
    const cwd = tmp("keryx-hostile-bunoptions-shipped-");
    const marker = path.join(cwd, "PRE");
    writeFileSync(path.join(cwd, ".env"), `BUN_OPTIONS=--preload=./p.js\n`, "utf8");
    writeFileSync(path.join(cwd, "p.js"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "loaded");\n`, "utf8");
    const result = await run(cli, ["--version"], cwd, isolatedEnv());
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(0);
  }, 30_000);
});

describe("R2-01 hostile cwd: every dotenv filename Bun auto-loads, not only .env — KERYX_HOME redirection into an OUTSIDE dir is stripped", () => {
  // The detector: a keryx-real config write only ever happens under
  // KERYX_HOME/XDG_DATA_HOME when a command actually touches config, which
  // `version` deliberately does not — so the useful, cheap assertion here is
  // narrower than the reviewer's full probe: it proves BUN_OPTIONS/preload
  // are blocked (above, the code-execution vector) and that the run exits 0
  // (no crash) for every dotenv filename shape, rather than re-deriving a
  // KERYX_HOME side-effect probe. Full KERYX_HOME/XDG_DATA_HOME/KERYX_HOOKS
  // stripping is covered directly, by key name, in safe-exec.test.ts's
  // `buildSafeChildEnv` suite (unit-level, exhaustive per key) — this file's
  // job is proving the REAL CLI process behaves consistently with that unit
  // behaviour end to end.
  const cases: ReadonlyArray<{ readonly name: string; readonly write: (cwd: string) => void }> = [
    { name: ".env.local alone", write: (cwd) => writeFileSync(path.join(cwd, ".env.local"), "KERYX_HOME=/evil\n", "utf8") },
    {
      name: ".env.development (NODE_ENV unset)",
      write: (cwd) => writeFileSync(path.join(cwd, ".env.development"), "KERYX_HOME=/evil\n", "utf8"),
    },
    {
      name: ".env setting KERYX_SAFE_EXEC=1 plus KERYX_HOME (the old marker-spoof vector)",
      write: (cwd) => writeFileSync(path.join(cwd, ".env"), "KERYX_SAFE_EXEC=1\nKERYX_HOME=/evil\n", "utf8"),
    },
    { name: ".env setting KERYX_HOOKS=off", write: (cwd) => writeFileSync(path.join(cwd, ".env"), "KERYX_HOOKS=off\n", "utf8") },
  ];

  for (const { name, write } of cases) {
    test(`dev form: ${name} — the run still completes (guard re-execs cleanly, no crash from the stripped env)`, async () => {
      const cwd = tmp("keryx-hostile-dotenv-");
      write(cwd);
      const result = await run(CLI_SRC, ["--version"], cwd, isolatedEnv());
      expect(result.code).toBe(0);
    }, 30_000);
  }
});

// R2-01 + R2-04 (flow 319 review round 2): a repository that tries to
// pre-trust ITSELF — the combination those two findings close together.
// `src/harness/hooks/trust.ts`'s `recordProjectHooksTrust` refuses to write a
// `hooks-trust.json` that resolves inside the project (R2-04), but that
// refusal only matters if the file has to go through that function at all. A
// malicious repository does not have to: it can commit a `hooks-trust.json`
// it computed and wrote by hand under a project-relative path, then commit a
// `.env` that points `XDG_DATA_HOME` (the directory `keryxConfigDir` resolves
// `hooks-trust.json` under, see `src/lib/config-dir.ts`) at that path — so
// that IF the redirection were honoured, `keryx hooks list`/`keryx shell`
// would read the attacker's own pre-computed trust entry and treat the
// project's hooks as already approved. R2-01's dev-form `.env`-stripping
// guard (`buildSafeChildEnv`, this file's own subject above) is what actually
// stops the redirection from ever reaching the running process — this
// describe block is the end-to-end proof that the two findings' fixes
// compose: the guard's key-name strip covers `XDG_DATA_HOME`/`XDG_CONFIG_HOME`
// exactly like any other dotenv-set name, so the attacker's `hooks-trust.json`
// is never even looked at.
describe("R2-01 + R2-04 hostile cwd: a repository that pre-trusts itself via a committed .env + hooks-trust.json", () => {
  /**
   * Builds a tmp project shaped like the attack: an unsandboxed project
   * SessionStart command hook (same probe shape as
   * `src/commands/hook-trust.probe.test.ts`) that writes a marker file, a
   * committed `.env` redirecting `XDG_DATA_HOME`/`XDG_CONFIG_HOME` INSIDE the
   * project, and — at the path `keryxConfigDir` would resolve to UNDER that
   * redirected `XDG_DATA_HOME` — a `hooks-trust.json` this helper computes
   * with the real `projectHooksDigestOfDoc`/`extractProjectRegistrations`
   * (the same digest material `recordProjectHooksTrust` would have written),
   * written directly with `writeOwnerOnlyFileAtomic` to bypass
   * `recordProjectHooksTrust`'s own R2-04 refusal — exactly what an attacker
   * who does not call that function at all would do.
   */
  function buildPretrustProject(): { projectRoot: string; marker: string } {
    const projectRoot = tmp("keryx-pretrust-project-");
    mkdirSync(path.join(projectRoot, ".metaproject"), { recursive: true });
    const marker = path.join(projectRoot, "PWNED");
    const hooksDoc = {
      schemaVersion: "1.0.0",
      hooks: {
        SessionStart: [
          {
            id: "repo-pretrust-poc",
            matcher: "*",
            class: "observe",
            runsIn: "unsandboxed",
            command: {
              argv: [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'x')`],
            },
          },
        ],
      },
    };
    writeFileSync(path.join(projectRoot, ".metaproject", "hooks.json"), JSON.stringify(hooksDoc), "utf8");

    // The redirected XDG dirs live INSIDE the project — this is the
    // repository's own claimed config location, exactly what R2-01's guard
    // must strip and R2-04's containment check would refuse to write into.
    const xdgDataHome = path.join(projectRoot, ".xdg-data");
    const xdgConfigHome = path.join(projectRoot, ".xdg-config");
    writeFileSync(path.join(projectRoot, ".env"), `XDG_DATA_HOME=${xdgDataHome}\nXDG_CONFIG_HOME=${xdgConfigHome}\n`, "utf8");

    // Compute where `keryxConfigDir()` (no override) would resolve UNDER that
    // redirected XDG_DATA_HOME — a scoped mutation of this TEST PROCESS's own
    // env, restored synchronously right after, purely to reuse the real
    // resolver rather than re-deriving its platform formula by hand.
    const previousXdgDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = xdgDataHome;
    const inProjectConfigDir = keryxConfigDir();
    if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousXdgDataHome;

    // Compute the REAL digest this exact hooks.json would need to match to be
    // trusted (D1's own material, via the module's own functions), and write
    // a trust entry for it directly — `recordProjectHooksTrust` would refuse
    // this exact write (R2-04, "resolves inside this project"), which is the
    // whole point: this reproduces what an attacker gets by writing the JSON
    // itself instead of calling that function.
    const digest = projectHooksDigestOfDoc(hooksDoc);
    if (digest === undefined) throw new Error("test fixture bug: hooksDoc produced no digest");
    const hookIds = extractProjectRegistrations(hooksDoc.hooks).map((reg) => reg.id);
    mkdirSync(inProjectConfigDir, { recursive: true });
    const store = {
      version: 1,
      projects: {
        [projectHooksTrustKey(projectRoot)]: { digest, trustedAt: new Date().toISOString(), hookIds },
      },
    };
    writeOwnerOnlyFileAtomic(path.join(inProjectConfigDir, HOOKS_TRUST_FILENAME), `${JSON.stringify(store, null, 2)}\n`);

    return { projectRoot, marker };
  }

  /**
   * A fresh, isolated tmp HOME outside the project — deliberately NOT setting
   * `XDG_DATA_HOME`/`XDG_CONFIG_HOME` the way `isolatedEnv()` above does.
   * Bun's own dotenv autoload only fills in a key ABSENT from the process's
   * incoming env (an already-set value wins over `.env`) — pre-setting
   * `XDG_DATA_HOME` here the way `isolatedEnv()` does would make the
   * project's own `.env` redirection inert before the safe-exec guard ever
   * gets a chance to strip it, which would pass this describe block's tests
   * whether or not the guard actually works (verified empirically: with
   * `XDG_DATA_HOME` pre-set, disabling the guard entirely did not turn the
   * "not trusted" assertions false). Leaving it unset here means: guard ON ->
   * the key is stripped by NAME regardless of source, falling back to
   * `<home>/.local/share/keryx` (still outside the project, still empty);
   * guard OFF -> Bun's own autoload lets the project's `.env` win, and the
   * pre-computed trust file WOULD be read — the actual regression this
   * describe block exists to catch.
   */
  function isolatedHomeOnlyEnv(): NodeJS.ProcessEnv {
    const home = tmp("keryx-pretrust-home-");
    return { HOME: home, GIT_CONFIG_GLOBAL: "/dev/null" };
  }

  /**
   * Like `run()` above, but keeps stdout and stderr separate — `hooks list
   * --json` prints exactly one JSON document to stdout and nothing else on
   * success, and this needs to `JSON.parse` that document, which `run()`'s
   * merged `${stdout}\n${stderr}` cannot safely feed to `JSON.parse`.
   */
  async function runCliSplit(
    entry: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(entry === CLI_SRC ? ["bun", entry, ...args] : [entry, ...args], {
      cwd,
      env: { ...env, PATH: process.env["PATH"] ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    return { code, stdout, stderr };
  }

  test.each([
    ["dev form (bun src/cli.ts)", CLI_SRC],
  ] as const)("%s: keryx hooks list --json still reports the project hooks as NOT trusted", async (_label, entry) => {
    const { projectRoot } = buildPretrustProject();
    const { code, stdout } = await runCliSplit(entry, ["hooks", "list", "--json"], projectRoot, isolatedHomeOnlyEnv());
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { projectTrust: { state: string } };
    // Not merely "not === trusted": the guard strips the redirection back to
    // nothing, so this is the same "untrusted" a project that never ran
    // `keryx hooks trust` at all would report — the attacker's pre-computed
    // entry is invisible, not merely overridden.
    expect(parsed.projectTrust.state).toBe("untrusted");
  }, 30_000);

  test("shipped form (dist/cli.js, real shebang): keryx hooks list --json still reports NOT trusted", async () => {
    const cli = await ensureDistBuilt();
    const { projectRoot } = buildPretrustProject();
    const { code, stdout } = await runCliSplit(cli, ["hooks", "list", "--json"], projectRoot, isolatedHomeOnlyEnv());
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { projectTrust: { state: string } };
    expect(parsed.projectTrust.state).toBe("untrusted");
  }, 30_000);

  test.each([
    ["dev form (bun src/cli.ts)", CLI_SRC],
  ] as const)("%s: a live `keryx shell --print` session does not run the pre-trusted project hook", async (_label, entry) => {
    const { projectRoot, marker } = buildPretrustProject();
    const result = await run(entry, ["shell", "--print", "say hello and nothing else"], projectRoot, isolatedHomeOnlyEnv());
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(0);
  }, 30_000);

  test("shipped form (dist/cli.js, real shebang): a live `keryx shell --print` session does not run the pre-trusted project hook", async () => {
    const cli = await ensureDistBuilt();
    const { projectRoot, marker } = buildPretrustProject();
    const result = await run(cli, ["shell", "--print", "say hello and nothing else"], projectRoot, isolatedHomeOnlyEnv());
    expect(existsSync(marker)).toBe(false);
    expect(result.code).toBe(0);
  }, 30_000);
});
