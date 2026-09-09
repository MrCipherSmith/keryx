// retired-spellings-ok: file — the contract test for the rename — it asserts the retired spellings still work, so it must invoke them
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { CLI_ROUTES } from "../cli";
import { acquireCwd, releaseCwd } from "../lib/test-cwd";
import { initCommand } from "./init";

// Flow 243: `keryx mcp` is renamed so the verb can later mean "MCP servers keryx
// connects to" instead of "keryx is an MCP server".
//
//   keryx mcp serve                       → keryx serve-mcp
//   keryx mcp install   --runtime <ed>    → keryx integrate <ed>
//   keryx mcp uninstall --runtime <ed>    → keryx integrate --remove <ed>
//
// Nothing is removed: the old spellings keep working and each gains ONE line
// naming its replacement.
//
// Everything here drives the WORKING TREE — `CLI_ROUTES` and the command
// functions are imported and called in-process. Nothing shells out to the
// `keryx` on PATH: that is an installed build without this change, so a test
// that ran it would report on someone else's code (memory:
// `stale-installed-keryx-binary`). It is also why the serve probe below uses an
// input that fails before any transport is opened, rather than starting a server.

const MINIMAL_INIT = [
  "--yes",
  "--no-gdgraph",
  "--no-gdctx",
  "--no-gdwiki",
  "--no-gdskills",
  "--no-health",
  "--no-testing",
  "--no-memory",
  "--no-tasks",
  "--no-security",
];

// Where each runtime's client config lands, relative to the project root.
// `generic` writes no file at all (it prints a snippet to paste), and `all`
// expands to the three file-backed project-local runtimes — vscode is opt-in.
const CONFIG_FILES: Record<string, string[]> = {
  cursor: [".cursor/mcp.json"],
  claude: [".mcp.json"],
  opencode: ["opencode.json"],
  vscode: [".vscode/mcp.json"],
  generic: [],
  all: [".cursor/mcp.json", ".mcp.json", "opencode.json"],
};

const RUNTIMES = Object.keys(CONFIG_FILES);

// Every config path any runtime can touch — used to return the workspace to a
// pre-install state between the two spellings so their writes are comparable.
const EVERY_CONFIG_FILE = [".cursor/mcp.json", ".mcp.json", "opencode.json", ".vscode/mcp.json"];

let root: string;
let quietLog: typeof console.log;
let quietError: typeof console.error;

beforeEach(async () => {
  // realpath: the config records an absolute `--cwd`, so a `/tmp` that is a
  // symlink would make the two spellings write different bytes for a reason
  // that has nothing to do with the rename.
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-mcp-naming-")));
  quietLog = console.log;
  quietError = console.error;
  console.log = () => {};
  console.error = () => {};
  await acquireCwd(root);
  await initCommand(MINIMAL_INIT);
});

afterEach(async () => {
  console.log = quietLog;
  console.error = quietError;
  releaseCwd();
  process.exitCode = 0;
  await rm(root, { recursive: true, force: true });
});

interface Run {
  /** Every printed line, both streams, split on newlines so a multi-line snippet counts as many lines. */
  lines: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
}

// Run a top-level verb the way the CLI runs it: look it up in the dispatch
// table and hand it the arguments after the verb. Going through CLI_ROUTES
// rather than importing a handler is deliberate — a handler that exists but is
// not wired to a verb is not a command anyone can type.
async function runVerb(verb: string, args: string[]): Promise<Run> {
  // Named as its own assertion so an unwired verb reports "expected keys to
  // contain 'integrate'" instead of "undefined is not a function".
  expect(Object.keys(CLI_ROUTES)).toContain(verb);
  const route = CLI_ROUTES[verb];
  return capture(() => route!(args));
}

async function capture(run: () => Promise<void> | void): Promise<Run> {
  const lines: string[] = [];
  let stdout = "";
  let stderr = "";
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    stdout += `${text}\n`;
    lines.push(...text.split("\n"));
  };
  console.error = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    stderr += `${text}\n`;
    lines.push(...text.split("\n"));
  };
  process.exitCode = 0;
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { lines, stdout, stderr, exitCode };
}

// File contents keyed by relative path; `null` records "this file does not
// exist", which is itself part of the observed behaviour (generic writes none,
// --dry-run writes none).
async function snapshot(files: string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const rel of files) {
    out[rel] = await readFile(path.join(root, rel), "utf8").catch(() => null);
  }
  return out;
}

async function clearConfigs(): Promise<void> {
  for (const rel of EVERY_CONFIG_FILE) {
    await rm(path.join(root, rel), { force: true });
  }
}

// A line that exists only to announce the rename. Excluded before comparing the
// two spellings' output, because the notice is the one difference that is
// supposed to be there.
function isNotice(line: string): boolean {
  return /deprecat/i.test(line) || /keryx (serve-mcp|integrate)/.test(line);
}

function noticesNaming(run: Run, replacement: string): string[] {
  return run.lines.filter((line) => line.includes(replacement));
}

// The single JSON object a runtime prints when it writes no file. Comparing
// this is how "byte-for-byte the same config" is checked for `generic`, which
// has no file to compare.
function snippet(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  expect(start).toBeGreaterThanOrEqual(0);
  return text.slice(start, end + 1);
}

// The working-tree entry point. Spawning THIS is not the same as running the
// `keryx` on PATH: that one is an installed build without this rename, so it
// would answer for code nobody is changing. `src/sac/fwk-parity.test.ts` drives
// the MCP server the same way.
const cliEntry = path.join(import.meta.dir, "..", "cli.ts");

interface StdioSession {
  tools: string[];
  stderr: string;
}

// Start the CLI as a real stdio MCP server and complete one session against it.
// Needed for the invocations that cannot be probed in-process: a serve that
// actually starts never returns, so it can only be observed from the outside.
// It also settles a question the in-process probe cannot: stdout is the
// JSON-RPC channel, so a notice printed there would corrupt the protocol — a
// session that completes proves the notice went to stderr.
async function serveOverStdio(args: string[]): Promise<StdioSession> {
  const clientModule = await import("@modelcontextprotocol/sdk/client/index.js").catch(() => null);
  const stdioModule = await import("@modelcontextprotocol/sdk/client/stdio.js").catch(() => null);
  // Asserted rather than skipped: the SDK is a declared dependency of this
  // repository, so its absence is a broken checkout, not a supported
  // configuration in which this acceptance criterion may go unchecked.
  expect(clientModule).not.toBeNull();
  expect(stdioModule).not.toBeNull();

  const transport = new stdioModule!.StdioClientTransport({
    command: process.execPath,
    args: [cliEntry, ...args],
    cwd: root,
    stderr: "pipe",
  });
  const client = new clientModule!.Client({ name: "keryx-mcp-naming", version: "1" }, { capabilities: {} });
  await client.connect(transport);

  const chunks: string[] = [];
  // Attached after connect because the child does not exist before it. Data
  // printed at startup is still delivered — a piped stream buffers until read.
  transport.stderr?.on("data", (chunk: unknown) => {
    chunks.push(String(chunk));
  });
  let tools: string[] = [];
  try {
    const listed = await client.listTools();
    tools = listed.tools.map((tool) => tool.name).sort();
  } finally {
    await client.close();
    // Read to the end of the child's stderr before judging how many lines it
    // printed — counting a truncated stream would make the count meaningless.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { tools, stderr: chunks.join("") };
}

// `serve --http` in a workspace that has not enabled the HTTP capability fails
// inside the same code path a real serve takes — after the context and server
// are built, before any transport is opened. That makes it the one serve
// invocation that is deterministic, offline, and cannot hang a test run on
// stdin, so it is how "reaches the path `mcp serve` reached" is observed.
const HTTP_OPT_IN_REFUSAL = "HTTP/SSE transport requires capabilities.http.enabled=true";

// ---------------------------------------------------------------------------
// AC1 — `keryx serve-mcp`
// ---------------------------------------------------------------------------

test("AC1: `serve-mcp` is a verb in the CLI dispatch table", async () => {
  // The dispatch table is the only honest answer to "what can a user type".
  // A `serveMcpCommand` that exists but is not in this table is unreachable.
  expect(Object.keys(CLI_ROUTES)).toContain("serve-mcp");
  expect(typeof CLI_ROUTES["serve-mcp"]).toBe("function");
});

test("AC1: `serve-mcp` reaches the same code path `mcp serve` reached", async () => {
  const viaNew = await runVerb("serve-mcp", ["--http", "--cwd", root]);
  const viaOld = await runVerb("mcp", ["serve", "--http", "--cwd", root]);

  // Same refusal, from the same place in serve: the new verb is the old path,
  // not a re-implementation that happens to print something similar.
  expect(viaNew.stderr).toContain(HTTP_OPT_IN_REFUSAL);
  expect(viaNew.exitCode).toBe(viaOld.exitCode);
  expect(viaNew.lines.filter((l) => !isNotice(l))).toEqual(
    viaOld.lines.filter((l) => !isNotice(l)),
  );

  // The replacement itself must not nag. A notice on the new spelling would
  // train people to ignore notices on the old one.
  expect(viaNew.lines.filter(isNotice)).toEqual([]);
});

// ---------------------------------------------------------------------------
// AC2 — `keryx integrate <editor>`
// ---------------------------------------------------------------------------

test("AC2: `integrate` is a verb in the CLI dispatch table", async () => {
  expect(Object.keys(CLI_ROUTES)).toContain("integrate");
  expect(typeof CLI_ROUTES["integrate"]).toBe("function");
});

for (const runtime of RUNTIMES) {
  test(`AC2: integrate ${runtime} writes what mcp install --runtime ${runtime} wrote, byte for byte`, async () => {
    const viaOld = await runVerb("mcp", ["install", "--runtime", runtime]);
    const beforeRename = await snapshot(EVERY_CONFIG_FILE);

    // Same root, sequentially: the config embeds this project's absolute path,
    // so comparing two different temp roots would differ on the path alone and
    // prove nothing about the rename.
    await clearConfigs();
    const viaNew = await runVerb("integrate", [runtime]);
    const afterRename = await snapshot(EVERY_CONFIG_FILE);

    expect(afterRename).toEqual(beforeRename);

    if (CONFIG_FILES[runtime]!.length > 0) {
      // Guard against a green comparison of two absent files: this runtime is
      // supposed to have written something.
      for (const rel of CONFIG_FILES[runtime]!) {
        expect(afterRename[rel]).toBeTruthy();
        expect(afterRename[rel]).toContain("keryx");
      }
    } else {
      // `generic` has no file, so the pasteable snippet IS the config.
      expect(snippet(viaNew.stdout)).toBe(snippet(viaOld.stdout));
    }
  });
}

test("AC2: integrate --dry-run prints the plan and writes nothing", async () => {
  const run = await runVerb("integrate", ["cursor", "--dry-run"]);

  // Same contract the old `--dry-run` had: a user inspecting the plan must not
  // discover afterwards that it was applied.
  expect(await snapshot(EVERY_CONFIG_FILE)).toEqual({
    ".cursor/mcp.json": null,
    ".mcp.json": null,
    "opencode.json": null,
    ".vscode/mcp.json": null,
  });

  const manifest = JSON.parse(
    await readFile(path.join(root, ".metaproject", "metaproject.json"), "utf8"),
  ) as { modules: Record<string, { enabled?: boolean }> };
  expect(manifest.modules.mcp).toBeUndefined();

  // "Writes nothing" is only useful if it still shows what it would write.
  expect(run.stdout).toContain(".cursor/mcp.json");
  expect(run.exitCode).toBe(0);
});

test("AC2: integrate rejects an unknown editor the way the old spelling did", async () => {
  const viaOld = await runVerb("mcp", ["install", "--runtime", "bogus"]);
  const viaNew = await runVerb("integrate", ["bogus"]);

  // A typo'd editor name must stay a non-zero failure — scripts branch on this.
  expect(viaOld.exitCode).toBe(1);
  expect(viaNew.exitCode).toBe(1);
  expect(viaNew.stderr).toContain("bogus");
});

// ---------------------------------------------------------------------------
// AC3 — `keryx integrate --remove <editor>`
// ---------------------------------------------------------------------------

for (const runtime of RUNTIMES) {
  test(`AC3: integrate --remove ${runtime} removes what mcp uninstall --runtime ${runtime} removed`, async () => {
    await runVerb("mcp", ["install", "--runtime", runtime]);
    await runVerb("mcp", ["uninstall", "--runtime", runtime]);
    const beforeRename = await snapshot(EVERY_CONFIG_FILE);

    await clearConfigs();
    await runVerb("mcp", ["install", "--runtime", runtime]);
    const installed = await snapshot(EVERY_CONFIG_FILE);
    const removal = await runVerb("integrate", ["--remove", runtime]);
    const afterRename = await snapshot(EVERY_CONFIG_FILE);

    expect(afterRename).toEqual(beforeRename);

    if (CONFIG_FILES[runtime]!.length === 0) {
      // `generic` owns no file, so file equality alone would be two absences
      // agreeing. What is observable is that the removal still addresses the
      // runtime by name and still succeeds.
      expect(removal.stdout).toContain(runtime);
      expect(removal.exitCode).toBe(0);
    }

    for (const rel of CONFIG_FILES[runtime]!) {
      // Not vacuous: the entry was there before the removal and is gone after,
      // and unrelated content in the file survived.
      expect(installed[rel]).toContain("keryx");
      const remaining = JSON.parse(afterRename[rel] ?? "{}") as {
        mcpServers?: Record<string, unknown>;
        mcp?: Record<string, unknown>;
        servers?: Record<string, unknown>;
      };
      const managed =
        remaining.mcpServers?.["keryx"] ?? remaining.mcp?.["keryx"] ?? remaining.servers?.["keryx"];
      expect(managed).toBeUndefined();
    }
  });
}

test("AC3: integrate --remove leaves other servers in the file alone", async () => {
  await mkdir(path.join(root, ".cursor"), { recursive: true });
  await runVerb("mcp", ["install", "--runtime", "cursor"]);
  const withNeighbour = JSON.parse(
    await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
  ) as { mcpServers: Record<string, unknown> };
  withNeighbour.mcpServers["context7"] = { command: "npx", args: ["-y", "context7"] };
  await Bun.write(
    path.join(root, ".cursor", "mcp.json"),
    `${JSON.stringify(withNeighbour, null, 2)}\n`,
  );

  await runVerb("integrate", ["--remove", "cursor"]);

  const config = JSON.parse(
    await readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
  ) as { mcpServers: Record<string, unknown> };
  // Removing our entry must never be an excuse to rewrite the user's file.
  expect(config.mcpServers["keryx"]).toBeUndefined();
  expect(config.mcpServers["context7"]).toEqual({ command: "npx", args: ["-y", "context7"] });
});

// ---------------------------------------------------------------------------
// AC4 — the old spellings keep working, and say so exactly once
// ---------------------------------------------------------------------------

test("AC4: `mcp serve` still serves and names `keryx serve-mcp` on exactly one line", async () => {
  const run = await runVerb("mcp", ["serve", "--http", "--cwd", root]);

  expect(run.stderr).toContain(HTTP_OPT_IN_REFUSAL);
  // Exit code unchanged: a script that treated 1 as "serve refused" still does.
  expect(run.exitCode).toBe(1);

  const notices = noticesNaming(run, "keryx serve-mcp");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatch(/deprecat/i);
});

test(
  "AC4: bare `keryx mcp` still serves, and says `keryx serve-mcp` once on stderr",
  async () => {
    // Bare `mcp` takes no flags today — `mcp --http` is already "Unknown mcp
    // command" — so the only way it reaches serve is with no arguments at all,
    // and a serve that starts never returns. Hence the real transport.
    await runVerb("mcp", ["install", "--runtime", "cursor"]);
    const session = await serveOverStdio(["mcp"]);

    // Still serves: a live session that lists tools is the alias doing what it
    // did. It also proves the notice did not land on stdout, which is the
    // JSON-RPC channel — a notice there would break every client.
    expect(session.tools.length).toBeGreaterThan(0);

    const notices = session.stderr.split("\n").filter((line) => line.includes("keryx serve-mcp"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/deprecat/i);
  },
  30_000,
);

test(
  "AC1: `serve-mcp` serves the same tools `mcp serve` served",
  async () => {
    // Fails here first while the verb is unwired, so the red reads as "the verb
    // does not exist" rather than as a transport error from a child that exited.
    expect(Object.keys(CLI_ROUTES)).toContain("serve-mcp");
    await runVerb("mcp", ["install", "--runtime", "cursor"]);

    const viaOld = await serveOverStdio(["mcp", "serve", "--cwd", root]);
    const viaNew = await serveOverStdio(["serve-mcp", "--cwd", root]);

    // The end-to-end statement of AC1: not merely that the verb is routed, but
    // that a real client gets the same server from the new spelling.
    expect(viaNew.tools.length).toBeGreaterThan(0);
    expect(viaNew.tools).toEqual(viaOld.tools);
    // And the new spelling is quiet: nothing to deprecate about it.
    expect(viaNew.stderr).not.toMatch(/deprecat/i);
  },
  30_000,
);

test("AC4: `mcp install --runtime all` still installs and names `keryx integrate` ONCE across three writes", async () => {
  const run = await runVerb("mcp", ["install", "--runtime", "all"]);

  for (const rel of CONFIG_FILES.all!) {
    expect(await readFile(path.join(root, rel), "utf8")).toContain("keryx");
  }
  expect(run.exitCode).toBe(0);

  // The point of the count. `all` performs three writes; a notice printed per
  // write is three notices, and a reader who sees the same line three times in
  // one command learns to skip it — which is how deprecation notices stop
  // working at all.
  const notices = noticesNaming(run, "keryx integrate");
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatch(/deprecat/i);
});

test("AC4: `mcp uninstall --runtime all` still uninstalls and names `keryx integrate --remove` once", async () => {
  await runVerb("mcp", ["install", "--runtime", "all"]);
  const run = await runVerb("mcp", ["uninstall", "--runtime", "all"]);

  for (const rel of CONFIG_FILES.all!) {
    const config = JSON.parse(await readFile(path.join(root, rel), "utf8")) as {
      mcpServers?: Record<string, unknown>;
      mcp?: Record<string, unknown>;
    };
    expect(config.mcpServers?.["keryx"] ?? config.mcp?.["keryx"]).toBeUndefined();
  }
  expect(run.exitCode).toBe(0);

  const notices = noticesNaming(run, "keryx integrate");
  expect(notices).toHaveLength(1);
  // Naming `keryx integrate` alone would send a user removing a server to the
  // command that adds one.
  expect(notices[0]).toContain("--remove");
});

test("AC4: `mcp install --runtime bogus` still exits 1", async () => {
  const run = await runVerb("mcp", ["install", "--runtime", "bogus"]);

  // The deprecation shim must not swallow or invent an exit code: this is the
  // failure a wrapper script already branches on.
  expect(run.exitCode).toBe(1);
  expect(run.stderr).toContain("bogus");
});
