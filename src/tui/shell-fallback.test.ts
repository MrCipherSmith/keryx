// Flow 113 — T2 / open item O-4: the readline fallback, proven instead of believed.
//
// PRD F5/G5 claims `keryx shell` falls back to the readline shell with plain
// output when there is no TTY, when the optional TUI dependency is absent, and
// when the renderer fails to initialise. `src/commands/shell-launch.test.ts`
// pins the DECISION (`chooseShellSurface`); nothing pinned the layer below it —
// the guards inside the launch functions, the end-to-end fall-through, or the
// escape-free half of the claim.
//
// Everything here runs in a child `bun` process, for two reasons:
//   1. the triggers are module-level (an unresolvable optional dependency, a
//      renderer constructor that throws). A child process can override the
//      module with a Bun runtime plugin from `--preload` without poisoning the
//      module registry the rest of `bun test` shares.
//   2. `process.stdout.isTTY` and `NO_COLOR`/`FORCE_COLOR` are process-global.
//
// The child's plugin also RECORDS whether the optional dependency was ever
// imported and whether a renderer mount was ever attempted. That is what makes
// these tests falsifiable: a guard that stops returning `false` early is
// observable as `imported`/`mountAttempted` flipping to `true`, not merely as a
// different return value (the failing paths all end in `return false` anyway,
// so the return value alone cannot tell a working guard from a removed one).
//
// The optional dependency is named only inside generated child-process source
// and never imported here; the guard in `src/capability/no-optional-imports` is
// a regex over file TEXT, so the forbidden static form must not appear even in
// a comment.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..");
const CLI = join(SRC_ROOT, "cli.ts");

/**
 * Preloaded into every child. Overrides the optional TUI package with a probe:
 *
 * - `KERYX_FLOW113_MODULE=missing` — the module throws on load, i.e. exactly
 *   what an absent optional dependency looks like to `await import(...)`.
 * - `KERYX_FLOW113_MODULE=spy` — the module loads and its renderer constructor
 *   throws, i.e. renderer initialisation failing.
 *
 * Either way it records that it was reached, and `KERYX_FLOW113_TTY` pins
 * `process.stdout.isTTY` so the child does not inherit the runner's terminal.
 */
const PRELOAD_SOURCE = `
import { plugin } from "bun";
import { writeFileSync } from "node:fs";

const probe = { imported: false, mountAttempted: false };
const mode = process.env.KERYX_FLOW113_MODULE ?? "spy";

Object.defineProperty(process.stdout, "isTTY", {
  value: process.env.KERYX_FLOW113_TTY === "1",
  configurable: true,
});

plugin({
  name: "flow113-optional-tui-probe",
  setup(build) {
    build.module("@opentui/core", () => {
      probe.imported = true;
      if (mode === "missing") {
        throw new Error("Cannot find module '@opentui/core'");
      }
      return {
        loader: "object",
        exports: {
          createCliRenderer: () => {
            probe.mountAttempted = true;
            throw new Error("renderer init failed (flow 113 probe)");
          },
        },
      };
    });
  },
});

process.on("exit", () => {
  writeFileSync(process.env.KERYX_FLOW113_PROBE, JSON.stringify(probe));
});
`;

/**
 * Calls one launch function directly and records what it returned — or, if the
 * contract "never throws" is broken, what escaped.
 */
const LAUNCH_SOURCE = `
const target = process.env.KERYX_FLOW113_TARGET;
const initial = { provider: "fake", model: "fake-echo" };
const unreachable = (what) => () => {
  throw new Error(what + " must not run: the launch should have declined first");
};

let returned = null;
let threw = null;
try {
  if (target === "agent") {
    const { launchTuiAgentShell } = await import(${JSON.stringify(join(SRC_ROOT, "tui", "tui-shell.ts"))});
    returned = await launchTuiAgentShell({
      detected: [],
      initial,
      makeAgentDeps: unreachable("makeAgentDeps"),
    });
  } else {
    const { launchTuiChatShell } = await import(${JSON.stringify(join(SRC_ROOT, "tui", "chat-shell.ts"))});
    returned = await launchTuiChatShell({
      detected: [],
      initial,
      makeShellDeps: unreachable("makeShellDeps"),
      runShell: unreachable("runShell"),
    });
  }
} catch (error) {
  threw = error instanceof Error ? error.message : String(error);
}
await Bun.write(process.env.KERYX_FLOW113_OUT, JSON.stringify({ returned, threw }));
`;

let workspace: string;
let preload: string;
let launcher: string;
let home: string;
let cwd: string;

beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "keryx-flow113-"));
  preload = join(workspace, "preload.ts");
  launcher = join(workspace, "launch.ts");
  home = join(workspace, "home");
  cwd = join(workspace, "cwd");
  await Bun.write(join(home, ".keep"), "");
  await Bun.write(join(cwd, ".keep"), "");
  await writeFile(preload, PRELOAD_SOURCE, "utf8");
  await writeFile(launcher, LAUNCH_SOURCE, "utf8");
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

interface Probe {
  /** The optional TUI package was loaded (the no-TTY guard did NOT stop first). */
  imported: boolean;
  /** A renderer construction was attempted (both guards were passed). */
  mountAttempted: boolean;
}

interface ChildRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  probe: Probe;
}

let runId = 0;

/** Run `bun --preload <probe> <argv…>` and collect its bytes plus the probe. */
async function runChild(opts: {
  argv: string[];
  env?: Record<string, string>;
  stdin?: string;
  extraFiles?: string[];
}): Promise<ChildRun & { files: Record<string, string> }> {
  runId += 1;
  const probeFile = join(workspace, `probe-${runId}.json`);
  const files: Record<string, string> = {};
  const proc = Bun.spawn(["bun", "--preload", preload, ...opts.argv], {
    cwd,
    stdin: new Blob([opts.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      KERYX_FLOW113_PROBE: probeFile,
      KERYX_FLOW113_TTY: "0",
      KERYX_FLOW113_MODULE: "spy",
      ...opts.env,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const probe = JSON.parse(await readFile(probeFile, "utf8")) as Probe;
  for (const file of opts.extraFiles ?? []) {
    files[file] = await readFile(file, "utf8");
  }
  return { exitCode, stdout, stderr, probe, files };
}

/** Drive one launch function in a child and read back what it returned. */
async function launch(opts: {
  target: "agent" | "chat";
  tty: boolean;
  module: "spy" | "missing";
}): Promise<{ returned: unknown; threw: string | null; probe: Probe; stderr: string }> {
  const outFile = join(workspace, `launch-${opts.target}-${runId + 1}.json`);
  const run = await runChild({
    argv: [launcher],
    env: {
      KERYX_FLOW113_TARGET: opts.target,
      KERYX_FLOW113_TTY: opts.tty ? "1" : "0",
      KERYX_FLOW113_MODULE: opts.module,
      KERYX_FLOW113_OUT: outFile,
    },
    extraFiles: [outFile],
  });
  const payload = JSON.parse(run.files[outFile] ?? "{}") as { returned: unknown; threw: string | null };
  return { ...payload, probe: run.probe, stderr: run.stderr };
}

// --- AC1: the no-TTY guard in each launch function --------------------------
//
// `returned === false` alone would ALSO hold with the guard deleted (the
// renderer would then fail and the catch would return `false` too), so the
// assertion that carries the weight is `imported === false`: the guard declines
// before the optional dependency is even loaded.

test("AC1: launchTuiAgentShell declines without a TTY, before loading the optional dep", async () => {
  const result = await launch({ target: "agent", tty: false, module: "spy" });
  expect(result.threw).toBeNull();
  expect(result.returned).toBe(false);
  expect(result.probe.imported).toBe(false);
  expect(result.probe.mountAttempted).toBe(false);
});

test("AC1: launchTuiChatShell declines without a TTY, before loading the optional dep", async () => {
  const result = await launch({ target: "chat", tty: false, module: "spy" });
  expect(result.threw).toBeNull();
  expect(result.returned).toBe(false);
  expect(result.probe.imported).toBe(false);
  expect(result.probe.mountAttempted).toBe(false);
});

// --- AC3: the optional dependency is absent ---------------------------------

test("AC3: an unresolvable optional dependency makes the agent launch decline, not throw", async () => {
  const result = await launch({ target: "agent", tty: true, module: "missing" });
  expect(result.threw).toBeNull(); // the contract is "never throws"
  expect(result.returned).toBe(false);
  expect(result.probe.imported).toBe(true); // the guard was reached …
  expect(result.probe.mountAttempted).toBe(false); // … and stopped at the import
});

test("AC3: an unresolvable optional dependency makes the chat launch decline, not throw", async () => {
  const result = await launch({ target: "chat", tty: true, module: "missing" });
  expect(result.threw).toBeNull();
  expect(result.returned).toBe(false);
  expect(result.probe.imported).toBe(true);
  expect(result.probe.mountAttempted).toBe(false);
});

// --- AC4: renderer initialisation throws ------------------------------------

test("AC4: a throwing renderer constructor makes the agent launch decline, not propagate", async () => {
  const result = await launch({ target: "agent", tty: true, module: "spy" });
  expect(result.threw).toBeNull();
  expect(result.returned).toBe(false);
  expect(result.probe.mountAttempted).toBe(true); // the throw really happened
});

test("AC4: a throwing renderer constructor makes the chat launch decline, not propagate", async () => {
  const result = await launch({ target: "chat", tty: true, module: "spy" });
  expect(result.threw).toBeNull();
  expect(result.returned).toBe(false);
  expect(result.probe.mountAttempted).toBe(true);
});

// --- AC2 / AC5: `keryx shell` end to end ------------------------------------

const SHELL_ARGS = [CLI, "shell", "--provider", "fake", "--model", "fake-echo", "--chat"];
/** One turn, so the transcript covers a system notice as well as the header. */
const ONE_TURN = "hello\n";
/** The FakeProvider quotes a per-request digest that varies with the clock. */
const normalize = (out: string): string => out.replace(/[0-9a-f]{64}/g, "<request-hash>");

async function runShellCommand(env: Record<string, string>): Promise<ChildRun> {
  return await runChild({ argv: SHELL_ARGS, stdin: ONE_TURN, env });
}

// The no-TTY chain has TWO layers — `chooseShellSurface` and the guard inside
// each launch function — and either one alone suffices. So this test only turns
// red when BOTH are removed; deleting `chooseShellSurface`'s `isTty` term on its
// own is caught by `src/commands/shell-launch.test.ts`, and deleting a launch
// guard on its own by the AC1 tests above. That is what the three of them
// together pin: the chain, and each link.
test("AC2: with no TTY, `keryx shell` runs the readline shell and mounts no renderer", async () => {
  const run = await runShellCommand({ KERYX_FLOW113_TTY: "0" });

  expect(run.exitCode).toBe(0);
  // The observable effect: the readline shell's own header and prompt, which
  // only `createRichIo`/`printHeader` on the fall-through path emit.
  expect(run.stdout).toContain("keryx — fake/fake-echo");
  expect(run.stdout).toContain("Type a message, or /help for commands.");
  // … and the TUI was never even loaded, let alone mounted.
  expect(run.probe.imported).toBe(false);
  expect(run.probe.mountAttempted).toBe(false);
});

test("AC5: the readline fallback's bytes carry no ANSI escapes under NO_COLOR", async () => {
  const noTty = await runShellCommand({ KERYX_FLOW113_TTY: "0", NO_COLOR: "1" });
  // A TTY with `--no-tui`: colour is genuinely AVAILABLE here, so an escape-free
  // result is a property of NO_COLOR rather than of the sink. Without this run
  // the assertion would hold trivially — a non-TTY sink is never coloured.
  const ttyPlain = await runChild({
    argv: [...SHELL_ARGS, "--no-tui"],
    stdin: ONE_TURN,
    env: { KERYX_FLOW113_TTY: "1", NO_COLOR: "1" },
  });

  for (const run of [noTty, ttyPlain]) {
    expect(run.exitCode).toBe(0);
    expect(run.stdout).not.toContain("\x1b[");
    expect(run.stdout).not.toContain("\x1b");
    expect(run.stdout).toContain("keryx — fake/fake-echo"); // it really did run
  }

  // The PRD's actual wording — "byte-identical plain output" — modulo the one
  // value that cannot be identical (the per-request digest).
  expect(normalize(noTty.stdout)).toBe(normalize(ttyPlain.stdout));
});

test("AC5: the same run WITH colour does emit escapes (the assertion can fail)", async () => {
  const coloured = await runChild({
    argv: [...SHELL_ARGS, "--no-tui"],
    stdin: ONE_TURN,
    env: { KERYX_FLOW113_TTY: "1", FORCE_COLOR: "1" },
  });

  expect(coloured.exitCode).toBe(0);
  expect(coloured.stdout).toContain("\x1b[");
  expect(coloured.stdout).toContain("\x1b[36m"); // cyan: the header marker
  expect(coloured.stdout).toContain("\x1b[2m"); // dim: the subtitle
  // The very same shell, the very same input: only the environment differs, so
  // the escape-free assertions above are a property of NO_COLOR and not of this
  // code path being incapable of colour in the first place.
  expect(coloured.stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")).toContain("keryx");
});
