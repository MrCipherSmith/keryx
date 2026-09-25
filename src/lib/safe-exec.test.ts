import { describe, expect, test } from "bun:test";
import { collectDotenvValues, ensureSafeBunExec, parseDotenvText, SAFE_EXEC_MARKER } from "./safe-exec";

describe("parseDotenvText", () => {
  test("parses KEY=VALUE lines, ignoring blanks and comments", () => {
    const parsed = parseDotenvText(["FOO=bar", "", "# a comment", "BAZ=qux"].join("\n"));
    expect(parsed).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("strips matching quotes and an `export ` prefix", () => {
    const parsed = parseDotenvText(['A="quoted"', "B='single'", "export C=plain"].join("\n"));
    expect(parsed).toEqual({ A: "quoted", B: "single", C: "plain" });
  });
});

describe("collectDotenvValues", () => {
  function makeReadFile(files: Record<string, string>): (p: string) => string | undefined {
    return (p: string) => files[p];
  }

  test("merges .env then .env.<NODE_ENV> then .env.local then .env.<NODE_ENV>.local, later wins", () => {
    const files = {
      "/proj/.env": "FOO=base\nONLY_BASE=1",
      "/proj/.env.production": "FOO=prod",
      "/proj/.env.local": "FOO=local",
      "/proj/.env.production.local": "FOO=prod-local",
    };
    const values = collectDotenvValues("/proj", { NODE_ENV: "production" }, makeReadFile(files));
    expect(values.FOO).toBe("prod-local");
    expect(values.ONLY_BASE).toBe("1");
  });

  test("skips .env.local when NODE_ENV is test, matching Bun", () => {
    const files = { "/proj/.env": "FOO=base", "/proj/.env.local": "FOO=local", "/proj/.env.test": "FOO=test-file" };
    const values = collectDotenvValues("/proj", { NODE_ENV: "test" }, makeReadFile(files));
    expect(values.FOO).toBe("test-file");
  });

  test("only reads .env when NODE_ENV is unset", () => {
    const files = { "/proj/.env": "FOO=base", "/proj/.env.production": "FOO=prod" };
    const values = collectDotenvValues("/proj", {}, makeReadFile(files));
    expect(values.FOO).toBe("base");
  });
});

describe("ensureSafeBunExec", () => {
  function noSpawn(): never {
    throw new Error("spawnSync must not be called in this test");
  }
  function noExit(): never {
    throw new Error("exit must not be called in this test");
  }

  test("does nothing when execArgv already carries --no-env-file and --config", () => {
    ensureSafeBunExec({
      execArgv: ["--no-env-file", "--config=/dev/null"],
      existsSync: () => {
        throw new Error("must not check the filesystem once execArgv is already safe");
      },
      spawnSync: noSpawn,
      exit: noExit,
    });
  });

  test("does nothing when KERYX_SAFE_EXEC=1 is already set, even with unsafe execArgv", () => {
    ensureSafeBunExec({
      env: { [SAFE_EXEC_MARKER]: "1" },
      execArgv: [],
      existsSync: () => {
        throw new Error("must not check the filesystem once the marker is set");
      },
      spawnSync: noSpawn,
      exit: noExit,
    });
  });

  test("does nothing for a compiled binary (process.argv[1] is a /$bunfs/ path) — there is no runtime flag to re-exec it with", () => {
    ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      scriptPath: "/$bunfs/root/keryx",
      existsSync: () => {
        throw new Error("must not check the filesystem for a compiled binary entry");
      },
      spawnSync: noSpawn,
      exit: noExit,
    });
  });

  test("does nothing when neither .env nor bunfig.toml exists in cwd (two existsSync calls)", () => {
    let calls = 0;
    ensureSafeBunExec({
      cwd: "/proj",
      env: {},
      execArgv: [],
      existsSync: (_p: string) => {
        calls += 1;
        return false;
      },
      spawnSync: noSpawn,
      exit: noExit,
    });
    expect(calls).toBe(2);
  });

  // `exit` is typed `never`-returning (it really does terminate the process
  // in production) — every fake here throws to honour that contract, so each
  // call under test is wrapped in `expect(...).toThrow()` rather than
  // expecting `ensureSafeBunExec` to return normally.
  const EXIT_SENTINEL = "safe-exec-test-exit";

  test("re-execs with the safe flags and the exact script/args when a cwd .env is present", () => {
    let spawnCall: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } | undefined;
    let exitCode: number | undefined;
    expect(() =>
      ensureSafeBunExec({
        cwd: "/proj",
        env: { PATH: "/usr/bin" },
        execArgv: [],
        execPath: "/opt/bun/bun",
        scriptPath: "/proj/src/cli.ts",
        args: ["shell", "--provider", "fake"],
        existsSync: (p: string) => p === "/proj/.env",
        readFile: (p: string) => (p === "/proj/.env" ? "KERYX_HOME=/proj/.evil\n" : undefined),
        spawnSync: (command, args, options) => {
          spawnCall = { command, args, env: options.env };
          return { status: 7 } as never;
        },
        exit: ((code: number) => {
          exitCode = code;
          throw new Error(EXIT_SENTINEL);
        }) as never,
      }),
    ).toThrow(EXIT_SENTINEL);
    expect(spawnCall?.command).toBe("/opt/bun/bun");
    expect(spawnCall?.args).toEqual(["--no-env-file", "--config=/dev/null", "/proj/src/cli.ts", "shell", "--provider", "fake"]);
    expect(spawnCall?.env[SAFE_EXEC_MARKER]).toBe("1");
    expect(exitCode).toBe(7);
  });

  test("strips a dotenv-sourced value from the child env, but keeps a real shell export with a different value", () => {
    let spawnEnv: NodeJS.ProcessEnv | undefined;
    expect(() =>
      ensureSafeBunExec({
        cwd: "/proj",
        // KERYX_HOME's CURRENT value equals what the .env file would set
        // (it was loaded from there) — must be stripped. REAL_VAR's current
        // value differs from the file (a genuine shell export shadowing the
        // file) — must survive.
        env: { KERYX_HOME: "/proj/.evil", REAL_VAR: "from-shell" },
        execArgv: [],
        existsSync: (p: string) => p === "/proj/.env",
        readFile: (p: string) => (p === "/proj/.env" ? "KERYX_HOME=/proj/.evil\nREAL_VAR=from-dotenv\n" : undefined),
        spawnSync: (_command, _args, options) => {
          spawnEnv = options.env;
          return { status: 0 } as never;
        },
        exit: (() => {
          throw new Error(EXIT_SENTINEL);
        }) as never,
      }),
    ).toThrow(EXIT_SENTINEL);
    expect(spawnEnv?.KERYX_HOME).toBeUndefined();
    expect(spawnEnv?.REAL_VAR).toBe("from-shell");
  });

  test("re-execs on a bunfig.toml alone (no .env)", () => {
    let called = false;
    expect(() =>
      ensureSafeBunExec({
        cwd: "/proj",
        env: {},
        execArgv: [],
        existsSync: (p: string) => p === "/proj/bunfig.toml",
        spawnSync: (_c, _a, _o) => {
          called = true;
          return { status: 0 } as never;
        },
        exit: (() => {
          throw new Error(EXIT_SENTINEL);
        }) as never,
      }),
    ).toThrow(EXIT_SENTINEL);
    expect(called).toBe(true);
  });
});
