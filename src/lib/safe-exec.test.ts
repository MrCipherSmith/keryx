import { describe, expect, test } from "bun:test";
import {
  buildSafeChildEnv,
  collectCwdDotenvKeyNames,
  collectDotenvKeyNames,
  ensureSafeBunExec,
  SAFE_BUN_SPAWN_ARGS,
  type SafeExecChild,
  type SafeExecDeps,
} from "./safe-exec";

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
  function deps(files: Record<string, { content?: string; symlink?: boolean; dir?: boolean }>) {
    const readdir = (p: string): string[] => (p === "/proj" ? Object.keys(files).map((f) => f.split("/").pop()!) : []);
    const lstat = (p: string) => {
      const name = Object.keys(files).find((f) => `/proj/${f}` === p);
      if (name === undefined) return undefined;
      const entry = files[name]!;
      return { isFile: () => entry.dir !== true, isSymbolicLink: () => entry.symlink === true };
    };
    const readFile = (p: string): string | undefined => {
      const name = Object.keys(files).find((f) => `/proj/${f}` === p);
      return name === undefined ? undefined : files[name]!.content;
    };
    return { readdir, lstat, readFile };
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
    const keys = collectCwdDotenvKeyNames("/proj", d.readdir, d.lstat, d.readFile);
    expect(keys).toEqual(new Set(["A", "B", "C", "D", "E"]));
  });

  test("a `.env` that is a symlink is not followed — skipped, not read", () => {
    const d = deps({ ".env": { symlink: true, content: "SHOULD_NOT_APPEAR=1" } });
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.lstat, d.readFile)).toEqual(new Set());
  });

  test("a `.env` that is a directory is skipped, not read", () => {
    const d = deps({ ".env": { dir: true } });
    expect(collectCwdDotenvKeyNames("/proj", d.readdir, d.lstat, d.readFile)).toEqual(new Set());
  });
});

describe("buildSafeChildEnv", () => {
  function baseDeps(env: NodeJS.ProcessEnv, dotenvContent: string): Pick<SafeExecDeps, "env" | "cwd" | "readdir" | "lstat" | "readFile"> {
    return {
      env,
      cwd: "/proj",
      readdir: () => [".env"],
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
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
      lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
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

  test("when the child dies FROM a signal (no exit code), that same signal is re-raised on this process rather than picking an exit code", async () => {
    const child = fakeChild();
    let raised: { pid: number; signal: NodeJS.Signals } | undefined;
    let exitCalled = false;
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
      exit: () => {
        exitCalled = true;
      },
    });
    child.emit("exit", null, "SIGTERM");
    await done;
    expect(raised).toEqual({ pid: 999, signal: "SIGTERM" });
    expect(exitCalled).toBe(false);
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
});

describe("SAFE_BUN_SPAWN_ARGS", () => {
  test("is exactly the two shebang flags, in the order --no-env-file then --config=/dev/null", () => {
    expect(SAFE_BUN_SPAWN_ARGS).toEqual(["--no-env-file", "--config=/dev/null"]);
  });
});
