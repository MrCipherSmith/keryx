import { describe, expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { constants, tmpdir } from "node:os";
import path from "node:path";
import {
  buildSafeChildEnv,
  collectCwdDotenvKeyNames,
  collectDotenvKeyNames,
  ensureSafeBunExec,
  SAFE_BUN_SPAWN_ARGS,
  type SafeExecChild,
  type SafeExecDeps,
} from "./safe-exec";

const REEXEC_PARENT_PID_ENV = "KERYX_REEXEC_PARENT_PID";

describe("collectDotenvKeyNames", () => {
  test("plain KEY=VALUE, blanks and comments", () => {
    expect(collectDotenvKeyNames(["FOO=bar", "", "# a comment", "BAZ=qux"].join("\n"))).toEqual(new Set(["FOO", "BAZ"]));
  });

  test("`export KEY=` and spaces around `=`", () => {
    expect(collectDotenvKeyNames(["export A=1", "B = 2", "  C=3  "].join("\n"))).toEqual(new Set(["A", "B", "C"]));
  });

  // R2-01: the old parser compared VALUES and disagreed with Bun on these
  // shapes; this one only needs the KEY NAME, so every shape here is caught
  // regardless of how the value itself would actually be interpreted.
  test("R2-01: an inline `#` comment after the value does not hide the key", () => {
    expect(collectDotenvKeyNames("KERYX_HOME=/evil # a note")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("R2-01: `$VAR`/`${VAR}` expansion syntax in the value does not hide the key", () => {
    expect(collectDotenvKeyNames(["D=..", "KERYX_HOME=$D/det"].join("\n"))).toEqual(new Set(["D", "KERYX_HOME"]));
    expect(collectDotenvKeyNames("KERYX_HOME=${D}/det")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("R2-01: backtick quoting does not hide the key", () => {
    expect(collectDotenvKeyNames("KERYX_HOME=`echo /evil`")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("R2-01: `KEY: value` syntax is recognised too", () => {
    expect(collectDotenvKeyNames("KERYX_HOME: /evil")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("a multi-line quoted value's continuation lines are not read as new keys", () => {
    const content = ['MULTI="line one', "line two=NOT_A_KEY", 'line three"', "AFTER=1"].join("\n");
    const keys = collectDotenvKeyNames(content);
    expect(keys.has("MULTI")).toBe(true);
    expect(keys.has("AFTER")).toBe(true);
    expect(keys.has("line two")).toBe(false);
    expect(keys.has("NOT_A_KEY")).toBe(false);
  });

  test("duplicate keys collapse to one", () => {
    expect(collectDotenvKeyNames(["A=1", "A=2"].join("\n"))).toEqual(new Set(["A"]));
  });
});

describe("collectCwdDotenvKeyNames", () => {
  function deps(files: Record<string, { content?: string; dir?: boolean; size?: number }>) {
    const readdir = (p: string): string[] => (p === "/proj" ? Object.keys(files).map((f) => f.split("/").pop()!) : []);
    const stat = (p: string) => {
      const name = Object.keys(files).find((f) => `/proj/${f}` === p);
      if (name === undefined) return undefined;
      const entry = files[name]!;
      return { isFile: () => entry.dir !== true, size: entry.size ?? (entry.content?.length ?? 0) };
    };
    const readFile = (p: string): string | undefined => {
      const name = Object.keys(files).find((f) => `/proj/${f}` === p);
      return name === undefined ? undefined : files[name]!.content;
    };
    return { readdir, stat, readFile };
  }

  test("R2-01: every `.env*` filename is scanned, not only `.env`/`bunfig.toml` gated ones", () => {
    const d = deps({
      ".env.local": { content: "A=1" },
      ".env.development": { content: "B=2" },
      ".env.production": { content: "C=3" },
      ".env.test": { content: "D=4" },
      ".env": { content: "E=5" },
      "notes.txt": { content: "F=6" }, // not a dotenv name — never scanned
    });
    const keys = collectCwdDotenvKeyNames("/proj", d.readdir, d.stat, d.readFile);
    expect(keys).toEqual(new Set(["A", "B", "C", "D", "E"]));
  });

  // R3-01 (review round 3, major): the previous version used `lstatSync`
  // (never follows a symlink) specifically to SKIP a symlinked `.env*` —
  // exactly backwards, since Bun's own loader follows it, and a git clone
  // preserves symlinks (`ln -s cfg.txt .env.local` needs no unusual syntax).
  // `stat` (this function's 3rd argument) now follows symlinks, matching Bun.
  test("R3-01: a `.env` that is a symlink IS followed, same as Bun's own loader", () => {
    const d = deps({ ".env": { content: "KERYX_HOME=/evil" } });
    // The injected `stat`/`readFile` here already behave as "resolved
    // through the symlink" (real `statSync`/`readFileSync` do this by
    // default) — this test documents the contract collectCwdDotenvKeyNames
    // relies on, pinned end-to-end against the real filesystem below in
    // "R3-01: real filesystem symlinks and parser-evasion probes".
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.stat, d.readFile)).toEqual(new Set(["KERYX_HOME"]));
  });

  test("a `.env` that is a directory is skipped, not read", () => {
    const d = deps({ ".env": { dir: true } });
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.stat, d.readFile)).toEqual(new Set());
  });

  // R3 regression (flow 319 CI): `isDotenvFileName` used to accept ANY
  // `.env.<anything>`, which also matched template files Bun's loader never
  // reads at all — stripping a real exported key just because a template
  // file happened to name it as a placeholder. Bun's own precedence list
  // (docs/guides/runtime/set-env.mdx, verified via ctx7
  // `/oven-sh/bun/bun-v1.4.2`) never mentions `.env.example`/`.env.sample`.
  test("R3: .env.example and .env.sample are template files, never scanned — a real exported key with the same name they document survives", () => {
    const d = deps({
      ".env.example": { content: "ANTHROPIC_API_KEY=your-key-here" },
      ".env.sample": { content: "ANTHROPIC_API_KEY=your-key-here" },
    });
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.stat, d.readFile)).toEqual(new Set());
  });

  // Bun's precedence list also loads `.env.<NODE_ENV>.local` — missing this
  // family would silently under-strip whenever NODE_ENV is production/dev/test.
  test("R3: the .local variant of each NODE_ENV-specific file is scanned too", () => {
    const d = deps({
      ".env.production.local": { content: "KERYX_HOME=/proj/.evil" },
      ".env.development.local": { content: "A=1" },
      ".env.test.local": { content: "B=2" },
    });
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.stat, d.readFile)).toEqual(new Set(["KERYX_HOME", "A", "B"]));
  });

  test("R3-01: a .env* file (or symlink target) larger than the read cap is skipped, not partially scanned", () => {
    const d = deps({ ".env": { content: "KERYX_HOME=/evil", size: 32 * 1024 * 1024 } });
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.stat, d.readFile)).toEqual(new Set());
  });
});

describe("buildSafeChildEnv", () => {
  function baseDeps(env: NodeJS.ProcessEnv, dotenvContent: string): Pick<SafeExecDeps, "env" | "cwd" | "readdir" | "stat" | "readFile"> {
    return {
      env,
      cwd: "/proj",
      readdir: () => [".env"],
      stat: () => ({ isFile: () => true, size: dotenvContent.length }),
      readFile: (p) => (p === "/proj/.env" ? dotenvContent : undefined),
    };
  }

  test("strips every key a cwd .env* file names, regardless of the CURRENT value", () => {
    const child = buildSafeChildEnv(baseDeps({ KERYX_HOME: "/evil", OTHER: "kept" }, "KERYX_HOME=whatever-this-says"));
    expect(child.KERYX_HOME).toBeUndefined();
    expect(child.OTHER).toBe("kept");
  });

  // R2-01: the old guard only stripped a key when ITS OWN parser's derived
  // value matched process.env exactly — this one strips by name alone, so a
  // value that arrived by shell expansion, or that the file's own syntax
  // disagreed with Bun about, is stripped exactly the same way.
  test("R2-01: KERYX_SAFE_EXEC set by a .env is stripped like any other dotenv-named key (there is no marker to spoof any more)", () => {
    const child = buildSafeChildEnv(baseDeps({ KERYX_SAFE_EXEC: "1" }, "KERYX_SAFE_EXEC=1"));
    expect(child.KERYX_SAFE_EXEC).toBeUndefined();
  });

  test("BUN_OPTIONS, NODE_OPTIONS, BUN_CONFIG_* and BUN_INSTALL_* are stripped UNCONDITIONALLY, even with no matching cwd dotenv key", () => {
    const child = buildSafeChildEnv(
      baseDeps(
        {
          BUN_OPTIONS: "--preload=./p.js",
          NODE_OPTIONS: "--require=./p.js",
          BUN_CONFIG_REGISTRY: "https://evil.example",
          BUN_INSTALL_CACHE_DIR: "/evil",
          KEPT: "yes",
        },
        "", // no cwd dotenv even mentions these — stripped anyway, see the doc comment on ALWAYS_STRIPPED_ENV_KEYS
      ),
    );
    expect(child.BUN_OPTIONS).toBeUndefined();
    expect(child.NODE_OPTIONS).toBeUndefined();
    expect(child.BUN_CONFIG_REGISTRY).toBeUndefined();
    expect(child.BUN_INSTALL_CACHE_DIR).toBeUndefined();
    expect(child.KEPT).toBe("yes");
  });

  test("a real shell export with a name no cwd dotenv file mentions survives untouched", () => {
    const child = buildSafeChildEnv(baseDeps({ REAL_VAR: "from-shell" }, "UNRELATED=1"));
    expect(child.REAL_VAR).toBe("from-shell");
  });
});

describe("ensureSafeBunExec", () => {
  function noSpawn(): never {
    throw new Error("spawn must not be called in this test");
  }

  function fakeChild(): SafeExecChild & { readonly killed: NodeJS.Signals[]; emit(event: "exit", code: number | null, signal: NodeJS.Signals | null): void } {
    const listeners: { exit: Array<(code: number | null, signal: NodeJS.Signals | null) => void>; error: Array<(error: Error) => void> } = {
      exit: [],
      error: [],
    };
    const killed: NodeJS.Signals[] = [];
    return {
      killed,
      kill(signal) {
        if (signal !== undefined) killed.push(signal);
        return true;
      },
      on(event, listener) {
        if (event === "exit") listeners.exit.push(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
        else listeners.error.push(listener as (error: Error) => void);
        return this;
      },
      emit(event, code, signal) {
        for (const listener of listeners.exit) listener(code, signal);
        void event;
      },
    };
  }

  // `exit` MUST always be overridden in a test that lets `ensureSafeBunExec`
  // reach its exit path: the real default calls `process.exit`, which does
  // not just fail the test — it kills the whole `bun test` WORKER PROCESS
  // immediately, before it ever prints a summary (every OTHER test in the
  // same file silently reports as if it never ran). Caught the hard way
  // while writing this file: omitting `exit` here reproduces as "bun test
  // prints only its banner line and exits 0" with zero indication of why.
  function noopSignalDeps(): Pick<SafeExecDeps, "onSignal" | "offSignal" | "kill" | "pid" | "exit"> {
    return { onSignal: () => {}, offSignal: () => {}, kill: () => {}, pid: 4242, exit: () => {} };
  }

  test("does nothing (no spawn, no filesystem access) when execArgv already carries --no-env-file and --config=", async () => {
    await ensureSafeBunExec({
      execArgv: ["--no-env-file", "--config=/dev/null"],
      readdir: () => {
        throw new Error("must not check the filesystem once execArgv is already safe");
      },
      spawn: noSpawn,
    });
  });

  test("also recognises the two-argument `--config /dev/null` form", async () => {
    await ensureSafeBunExec({ execArgv: ["--no-env-file", "--config", "/dev/null"], spawn: noSpawn });
  });

  // R2-01: there is no env marker any more — "already safe" comes from
  // execArgv alone. A `.env` setting a variable that LOOKS like the old
  // marker name has no special meaning any more; it is just another key to
  // strip if it also happens to match SAFE_BUN_SPAWN_ARGS-adjacent logic (it
  // does not — it is stripped as an ordinary dotenv-named key, see
  // buildSafeChildEnv's tests above).
  test("R2-01: an unsafe execArgv ALWAYS re-execs, even with no .env/bunfig.toml in cwd at all", async () => {
    const child = fakeChild();
    let spawnCalled = false;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      execPath: "/opt/bun/bun",
      scriptPath: "/proj/src/cli.ts",
      args: [],
      readdir: () => [], // nothing in cwd — must not gate the decision to re-exec
      spawn: (command, args, options) => {
        spawnCalled = true;
        expect(command).toBe("/opt/bun/bun");
        expect(args).toEqual(["--no-env-file", "--config=/dev/null", "/proj/src/cli.ts"]);
        void options;
        return child;
      },
      ...noopSignalDeps(),
    });
    child.emit("exit", 0, null);
    await done;
    expect(spawnCalled).toBe(true);
  });

  test("does nothing for a compiled binary (process.argv[1] is a /$bunfs/ path) — there is no runtime flag to re-exec it with", async () => {
    await ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      scriptPath: "/$bunfs/root/keryx",
      readdir: () => {
        throw new Error("must not check the filesystem for a compiled binary entry");
      },
      spawn: noSpawn,
    });
  });

  test("does nothing when there is no entry script at all (`bun -e`, a REPL)", async () => {
    await ensureSafeBunExec({ execArgv: [], scriptPath: "", spawn: noSpawn });
  });

  test("re-execs with the safe flags and the exact script/args, env stripped by the cwd .env's key names", async () => {
    const child = fakeChild();
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: { PATH: "/usr/bin", KERYX_HOME: "/proj/.evil" },
      execArgv: [],
      execPath: "/opt/bun/bun",
      scriptPath: "/proj/src/cli.ts",
      args: ["shell", "--provider", "fake"],
      readdir: () => [".env"],
      stat: () => ({ isFile: () => true, size: 64 }),
      readFile: (p) => (p === "/proj/.env" ? "KERYX_HOME=/proj/.evil\n" : undefined),
      spawn: (command, args, options) => {
        expect(command).toBe("/opt/bun/bun");
        expect(args).toEqual(["--no-env-file", "--config=/dev/null", "/proj/src/cli.ts", "shell", "--provider", "fake"]);
        spawnEnv = options.env;
        return child;
      },
      ...noopSignalDeps(),
    });
    child.emit("exit", 7, null);
    await done;
    expect(spawnEnv?.KERYX_HOME).toBeUndefined();
    expect(spawnEnv?.PATH).toBe("/usr/bin");
  });

  test("exits with the child's exit code", async () => {
    const child = fakeChild();
    let exitCode: number | undefined;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      readdir: () => [],
      spawn: () => child,
      ...noopSignalDeps(),
      exit: (code) => {
        exitCode = code;
      },
    });
    child.emit("exit", 7, null);
    await done;
    expect(exitCode).toBe(7);
  });

  // R2-01 orchestrator follow-up: re-exec must forward signals, or a caller
  // reading THIS process's exit status (a shell's `$?`, a test's
  // `proc.exited`) after e.g. `kill -TERM <pid>` never sees the child's own
  // graceful shutdown — see src/commands/serve.process.test.ts's AC10 drain
  // test, which spawns `bun src/cli.ts serve` (guard fires: this repo ships a
  // bunfig.toml) and asserts on the exit code the OUTER process reports.
  test("forwards SIGTERM (and the rest of FORWARDED_SIGNALS) to the child", async () => {
    const child = fakeChild();
    const registered = new Map<NodeJS.Signals, () => void>();
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      readdir: () => [],
      spawn: () => child,
      onSignal: (signal, handler) => registered.set(signal, handler),
      offSignal: () => {},
      kill: () => {},
      pid: 1,
      exit: () => {},
    });
    expect(registered.has("SIGTERM")).toBe(true);
    expect(registered.has("SIGINT")).toBe(true);
    registered.get("SIGTERM")!();
    expect(child.killed).toEqual(["SIGTERM"]);
    child.emit("exit", 0, null);
    await done;
  });

  // R3-02 (review round 3, minor, by-design output change): the previous
  // version of this test pinned "the re-raise happens and `exit` is NEVER
  // called" — but a re-raised signal is not guaranteed to actually terminate
  // THIS process (SIGUSR1 is Bun's inspector signal and does nothing by
  // default; anything this process itself handles or ignores has the same
  // problem), and when it does not, the old code fell through into whatever
  // called `ensureSafeBunExec` — `src/cli.ts`'s `main()` — in the very
  // process a cwd `.env`/`bunfig.toml` had already poisoned, running the
  // whole command a SECOND time, unguarded (adv3/g2.ts: "PARENT FELL THROUGH
  // to main body"). The guard now always calls `exit(128 + signalNumber)`
  // right after asking for the re-raise, so a caller reading THIS process's
  // exit status still sees the same 128+n encoding an unguarded run under
  // that signal would have produced, but a fall-through is no longer
  // possible even when the OS-level re-raise itself does not land.
  test("when the child dies FROM a signal (no exit code), that signal is re-raised AND this process exits with the 128+n encoding — never falls through", async () => {
    const child = fakeChild();
    let raised: { pid: number; signal: NodeJS.Signals } | undefined;
    let exitCode: number | undefined;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      readdir: () => [],
      spawn: () => child,
      onSignal: () => {},
      offSignal: () => {},
      kill: (pid, signal) => {
        raised = { pid, signal };
      },
      pid: 999,
      exit: (code) => {
        exitCode = code;
      },
    });
    child.emit("exit", null, "SIGTERM");
    await done;
    expect(raised).toEqual({ pid: 999, signal: "SIGTERM" });
    expect(exitCode).toBe(143); // 128 + SIGTERM(15)
  });

  // R3-02: the exact regression the reviewer found — SIGUSR1 is Bun's
  // inspector signal and does not terminate a process by default, so a naive
  // "re-raise and trust it" implementation falls through. Pins that this
  // process still exits deterministically (128 + SIGUSR1's signal number)
  // rather than continuing into the caller.
  test("R3-02: SIGUSR1 (a signal this process does not die from) still exits with 128+n rather than falling through", async () => {
    const child = fakeChild();
    let exitCode: number | undefined;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      readdir: () => [],
      spawn: () => child,
      onSignal: () => {},
      offSignal: () => {},
      kill: () => {
        // A real `process.kill(pid, "SIGUSR1")` does not terminate this
        // process by default — simulated here by simply doing nothing, which
        // is exactly the case the old code fell through on.
      },
      pid: 999,
      exit: (code) => {
        exitCode = code;
      },
    });
    child.emit("exit", null, "SIGUSR1");
    await done;
    // SIGUSR1's signal number is platform-dependent (10 on Linux, 30 on
    // Darwin) — read it from the same source the implementation uses rather
    // than hard-coding one platform's number.
    expect(exitCode).toBe(128 + constants.signals.SIGUSR1);
  });

  test("signal handlers are unregistered once the child has exited", async () => {
    const child = fakeChild();
    const offCalls: NodeJS.Signals[] = [];
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      readdir: () => [],
      spawn: () => child,
      onSignal: () => {},
      offSignal: (signal) => offCalls.push(signal),
      kill: () => {},
      pid: 1,
      exit: () => {},
    });
    child.emit("exit", 0, null);
    await done;
    expect(offCalls.length).toBeGreaterThan(0);
  });

  // R3 regression (flow 319 CI): the previous version spawned with ONLY
  // `SAFE_BUN_SPAWN_ARGS`, dropping every other flag the parent was launched
  // with — e.g. `src/tui/shell-fallback.test.ts`'s own `bun --preload <probe>
  // src/cli.ts …`, which relies on that `--preload` surviving into the child
  // to fake a TTY. This pins that the safe flags are ADDED, not substituted.
  test("R3: re-exec preserves the parent's OTHER execArgv flags (e.g. --preload) alongside the two safe flags", async () => {
    const child = fakeChild();
    let spawnArgs: string[] | undefined;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: ["--preload", "/tmp/probe.ts", "--smol"],
      execPath: "/opt/bun/bun",
      scriptPath: "/proj/src/cli.ts",
      args: ["shell"],
      readdir: () => [],
      spawn: (command, args) => {
        spawnArgs = [...args];
        return child;
      },
      ...noopSignalDeps(),
    });
    child.emit("exit", 0, null);
    await done;
    expect(spawnArgs).toEqual(["--no-env-file", "--config=/dev/null", "--preload", "/tmp/probe.ts", "--smol", "/proj/src/cli.ts", "shell"]);
  });

  test("R3: a parent execArgv flag identical to one of the safe flags is not duplicated", async () => {
    const child = fakeChild();
    let spawnArgs: string[] | undefined;
    // Not `hasSafeExecArgv`-true (missing --config) but already carries
    // --no-env-file, e.g. a `.bunfig`-level `env=false` plus a bare re-run.
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: ["--no-env-file", "--preload", "/tmp/probe.ts"],
      execPath: "/opt/bun/bun",
      scriptPath: "/proj/src/cli.ts",
      args: [],
      readdir: () => [],
      spawn: (command, args) => {
        spawnArgs = [...args];
        return child;
      },
      ...noopSignalDeps(),
    });
    child.emit("exit", 0, null);
    await done;
    expect(spawnArgs).toEqual(["--no-env-file", "--config=/dev/null", "--preload", "/tmp/probe.ts", "/proj/src/cli.ts"]);
  });

  test("R3: the re-exec'd child's env carries the wrapper's pid so the child can watch for it dying", async () => {
    const child = fakeChild();
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    const done = ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      readdir: () => [],
      spawn: (command, args, options) => {
        spawnEnv = options.env;
        return child;
      },
      ...noopSignalDeps(),
      pid: 12345,
    });
    child.emit("exit", 0, null);
    await done;
    expect(spawnEnv?.[REEXEC_PARENT_PID_ENV]).toBe("12345");
  });

  // R3 (orchestrator hypothesis 2a): a re-exec'd child must exit when its
  // wrapper dies, so a test that only ever held the WRAPPER's pid (SIGKILL,
  // SIGSTOP — neither of which the wrapper can forward once it is gone/
  // stopped) does not see the actual `keryx` process outlive it forever.
  describe("ppid watchdog (the already-safe / no-spawn path)", () => {
    function intervalDeps(): {
      deps: Pick<SafeExecDeps, "getPpid" | "setUnrefInterval" | "exit">;
      fire: () => void;
      cleared: () => boolean;
      exited: () => number | undefined;
      currentPpid: { value: number };
    } {
      const currentPpid = { value: 111 };
      let fn: (() => void) | undefined;
      let cleared = false;
      let exitCode: number | undefined;
      return {
        currentPpid,
        deps: {
          getPpid: () => currentPpid.value,
          setUnrefInterval: (f) => {
            fn = f;
            return { clear: () => (cleared = true) };
          },
          exit: (code) => {
            exitCode = code;
          },
        },
        fire: () => fn?.(),
        cleared: () => cleared,
        exited: () => exitCode,
      };
    }

    test("does nothing when the env carries no recorded parent pid (a normal, non-re-exec'd launch)", async () => {
      const { deps, fire } = intervalDeps();
      let intervalStarted = false;
      await ensureSafeBunExec({
        execArgv: ["--no-env-file", "--config=/dev/null"],
        env: {},
        spawn: noSpawn,
        getPpid: deps.getPpid,
        setUnrefInterval: (f, ms) => {
          intervalStarted = true;
          return deps.setUnrefInterval(f, ms);
        },
        exit: deps.exit,
      });
      expect(intervalStarted).toBe(false);
      fire(); // no-op: nothing was ever scheduled
    });

    test("exits(1) once this process's ppid no longer matches the recorded wrapper pid", async () => {
      const { deps, fire, exited, currentPpid } = intervalDeps();
      currentPpid.value = 555; // matches the recorded parent for now
      await ensureSafeBunExec({
        execArgv: ["--no-env-file", "--config=/dev/null"],
        env: { [REEXEC_PARENT_PID_ENV]: "555" },
        spawn: noSpawn,
        ...deps,
      });
      fire();
      expect(exited()).toBeUndefined(); // ppid still matches — no false positive
      currentPpid.value = 1; // wrapper died — reparented to init
      fire();
      expect(exited()).toBe(1);
    });

    test("ignores a malformed recorded parent pid rather than watching garbage", async () => {
      const { deps, fire, exited } = intervalDeps();
      let intervalStarted = false;
      await ensureSafeBunExec({
        execArgv: ["--no-env-file", "--config=/dev/null"],
        env: { [REEXEC_PARENT_PID_ENV]: "not-a-pid" },
        spawn: noSpawn,
        getPpid: deps.getPpid,
        setUnrefInterval: (f, ms) => {
          intervalStarted = true;
          return deps.setUnrefInterval(f, ms);
        },
        exit: deps.exit,
      });
      expect(intervalStarted).toBe(false);
      fire();
      expect(exited()).toBeUndefined();
    });
  });
});

describe("SAFE_BUN_SPAWN_ARGS", () => {
  test("is exactly the two shebang flags, in the order --no-env-file then --config=/dev/null", () => {
    expect(SAFE_BUN_SPAWN_ARGS).toEqual(["--no-env-file", "--config=/dev/null"]);
  });
});

// R3-01 (review round 3, major): one test per bypass the reviewer's probe
// matrix found (scratchpad/f319/adv3/m1.sh, m2.sh — "bun-loads=X / after-
// guard=X" meant the guard left a key Bun itself binds sitting in the
// child's env). Each of these pins `collectDotenvKeyNames` directly against
// the exact byte content the probe used, so a future edit that reopens one
// of these gaps fails here instead of needing another adversarial pass.
describe("R3-01: collectDotenvKeyNames catches every parser-evasion shape the review found", () => {
  test("an unterminated double-quoted value does not swallow the rest of the file — Bun falls back to unquoted-on-this-line, and so does this parser", () => {
    expect(collectDotenvKeyNames('A="foo\nKERYX_HOME=/det\n')).toEqual(new Set(["A", "KERYX_HOME"]));
  });

  test("an unterminated single-quoted value does not swallow the rest of the file", () => {
    expect(collectDotenvKeyNames("A='foo\nKERYX_HOME=/det\n")).toEqual(new Set(["A", "KERYX_HOME"]));
  });

  test("an unterminated backtick-quoted value does not swallow the rest of the file", () => {
    expect(collectDotenvKeyNames("A=`foo\nKERYX_HOME=/det\n")).toEqual(new Set(["A", "KERYX_HOME"]));
  });

  test("a space before the opening quote (`A= \"foo`) does not change the unterminated-quote fallback", () => {
    expect(collectDotenvKeyNames('A= "foo\nKERYX_HOME=/det\n')).toEqual(new Set(["A", "KERYX_HOME"]));
  });

  test("a lone CR (no following LF) is a line break too, same as Bun", () => {
    expect(collectDotenvKeyNames("A=1\rKERYX_HOME=/det\r")).toEqual(new Set(["A", "KERYX_HOME"]));
  });

  test("`export` followed by a TAB (not only a space) is recognised", () => {
    expect(collectDotenvKeyNames("export\tKERYX_HOME=/det\n")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("mixed-quote content inside an unterminated value (a stray \" inside a ' value) does not hide the next line's key", () => {
    expect(collectDotenvKeyNames('A=\'x"\nKERYX_HOME=/det\nB="\n')).toEqual(new Set(["A", "KERYX_HOME", "B"]));
  });

  test("a `=` inside an unterminated quoted value does not confuse the fallback", () => {
    expect(collectDotenvKeyNames('A="x=\nKERYX_HOME=/det\n')).toEqual(new Set(["A", "KERYX_HOME"]));
  });

  test("a BOM at the start of a key is skipped, same as Bun", () => {
    expect(collectDotenvKeyNames("﻿KERYX_HOME=/det\n")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("a leading tab before the key, and a tab around the separator, are skipped", () => {
    expect(collectDotenvKeyNames("\tKERYX_HOME\t=\t/det\n")).toEqual(new Set(["KERYX_HOME"]));
  });

  test("a properly terminated quoted value (closed later in the SAME line) is still value content, not a new key", () => {
    expect(collectDotenvKeyNames('A="line one" KERYX_HOME=/det\n')).toEqual(new Set(["A"]));
  });

  test("a matched quote's escaped closing character does not end the value early", () => {
    expect(collectDotenvKeyNames('A="x\\"y"\nKERYX_HOME=/det\n')).toEqual(new Set(["A", "KERYX_HOME"]));
  });
});

describe("R3-01: real filesystem symlinks and parser-evasion probes", () => {
  function realDeps(): { readdir: (p: string) => string[]; stat: (p: string) => { isFile(): boolean; size: number } | undefined; readFile: (p: string) => string | undefined } {
    return {
      readdir: (p) => {
        try {
          return readdirSync(p);
        } catch {
          return [];
        }
      },
      stat: (p) => {
        try {
          const s = statSync(p);
          return { isFile: () => s.isFile(), size: s.size };
        } catch {
          return undefined;
        }
      },
      readFile: (p) => {
        try {
          return readFileSync(p, "utf8");
        } catch {
          return undefined;
        }
      },
    };
  }

  test("R3-01: a real symlinked .env, .env.local and .env.development are all followed, same as Bun's own loader", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-safe-exec-symlink-"));
    try {
      for (const name of [".env", ".env.local", ".env.development"]) {
        const target = path.join(dir, `real-${name}.txt`);
        writeFileSync(target, "KERYX_HOME=/det\n");
        symlinkSync(target, path.join(dir, name));
      }
      const deps = realDeps();
      const keys = collectCwdDotenvKeyNames(dir, deps.readdir, deps.stat, deps.readFile);
      expect(keys).toEqual(new Set(["KERYX_HOME"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("R3-01: a symlink into a subdirectory is followed too", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-safe-exec-symlink-sub-"));
    try {
      const subdir = path.join(dir, "sub");
      mkdirSync(subdir);
      const target = path.join(subdir, "x");
      writeFileSync(target, "KERYX_HOME=/det\n");
      symlinkSync(target, path.join(dir, ".env"));
      const deps = realDeps();
      expect(collectCwdDotenvKeyNames(dir, deps.readdir, deps.stat, deps.readFile)).toEqual(new Set(["KERYX_HOME"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("R3-01: a hardlinked .env is read, same as a plain file (unchanged behaviour, not a regression)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-safe-exec-hardlink-"));
    try {
      const real = path.join(dir, "real.txt");
      writeFileSync(real, "KERYX_HOME=/det\n");
      linkSync(real, path.join(dir, ".env"));
      const deps = realDeps();
      expect(collectCwdDotenvKeyNames(dir, deps.readdir, deps.stat, deps.readFile)).toEqual(new Set(["KERYX_HOME"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
