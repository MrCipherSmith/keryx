import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readlineAgentHelpText, runAgentRepl } from "./shell";
import type { AgentDeps } from "./agent";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { ShellSessionOpts } from "./shell-types";

// Flow 277 (shell god-file split, P2). Behavioural tests for `runAgentRepl` —
// the readline agent loop in `shell.ts`.
//
// Until flow 277 this function was unexported and wrote straight to
// `process.stdout`, so nothing could drive it. Its own doc comment said "NOT
// unit-tested", and a dozen `describe` blocks in `shell.test.ts` cited exactly
// that when they asserted over this file's source TEXT instead — against a
// window (`slice(indexOf("async function runAgentRepl("), indexOf("if
// (agentMode) {"))`) that runs 1,080 lines past the end of the function and
// swallows most of `shellCommand`. See
// `docs/requirements/keryx-shell-split/source-text-audit-inventory.md`.
//
// The two seams that made this file possible are an `export` keyword and
// `rich.write`; neither changes what production does.

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-repl-"));
  cwd = path.join(root, "repo");
  Bun.spawnSync(["mkdir", "-p", cwd]);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A `MetaprojectPort` that answers everything inertly (mirrors `agent-approval-context.test.ts`). */
function fakePort(overrides: Partial<MetaprojectPort> = {}): MetaprojectPort {
  return {
    searchCode: async ({ pattern }) => ({ pattern, output: "", isError: false }),
    graphAffected: async ({ target }) => ({ target, affected: [] }),
    graphQuery: async ({ query }) => (query === "orphans" ? { query, orphans: [] } : { query, cycles: [] }),
    memorySearch: async ({ query }) => ({ query, hits: [] }),
    readWiki: async ({ path: p }) => ({ path: p, content: "", isError: false }),
    describeContext: async () => ({ root: cwd, graphNodes: 0, graphEdges: 0, hasWikiIndex: false }),
    ...overrides,
  };
}

/**
 * Minimal `AgentDeps`. Every test here types a slash command and then `/exit`,
 * so the turn driver is never reached and the provider is never called — a
 * provider that throws would prove it, and `no model call` below does.
 */
function fakeDeps(overrides: Record<string, unknown> = {}): AgentDeps {
  return {
    providerId: "scripted",
    modelId: "m",
    systemInstruction: "sys",
    provider: {
      complete: () => {
        throw new Error("the provider must not be reached by a slash command");
      },
    },
    ...overrides,
  } as unknown as AgentDeps;
}

async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

/**
 * Drives the real REPL over `lines` and returns everything it rendered.
 *
 * `configDir` ALWAYS defaults to a directory inside this test's temp root,
 * never to `undefined`. `undefined` means "the operator's real config dir"
 * (`keryxConfigDir()` -> `~/.local/share/keryx/auth.json`), and `/reasoning`
 * persists through `saveShellConfig`, so a test that omitted it would read —
 * and write — the machine's own settings. That is not hypothetical: the first
 * draft of these tests reported `Reasoning effort: high (global)` because it
 * was resolving against shared state.
 */
async function repl(
  lines: string[],
  opts: {
    deps?: AgentDeps;
    port?: MetaprojectPort;
    session?: Partial<ShellSessionOpts>;
    configDir?: string;
  } = {},
): Promise<string> {
  const out: string[] = [];
  await runAgentRepl(
    linesFrom(...lines),
    { printPrompt: () => {}, safeBoundary: undefined, write: (s) => out.push(s) },
    opts.deps ?? fakeDeps(),
    opts.port ?? fakePort(),
    // `enabled: false` skips session persistence — the documented test default
    // on `ShellSessionOpts`.
    { cwd, enabled: false, ...opts.session },
    undefined,
    undefined,
    undefined,
    opts.configDir ?? path.join(root, "config"),
  );
  return out.join("");
}

// ---------------------------------------------------------------------------
// /goal — replaces the SLATE-15 source-text audit in `shell.test.ts`
//
// What that audit actually protected: `/goal` typed at the readline agent
// prompt reaches `runGoalCommand` with this session's `rest`, `cwd` and `io`,
// rather than falling through to "Unknown command". It checked that by looking
// for the substrings `rest`, `sessionCwd`, `agentIo`, `history`,
// `slateSession` and `mintTimestampAttemptId` within 500 characters of
// `command === "/goal"` — which any of those words would satisfy from a
// comment, and which says nothing about the branch being reachable.
// ---------------------------------------------------------------------------

describe("/goal reaches runGoalCommand (SLATE-15, was a source-text audit)", () => {
  test("a bare /goal is handled by the goal command, not by the unknown-command fallback", async () => {
    const output = await repl(["/goal", "/exit"]);
    // `runGoalCommand` prefixes every refusal it prints with `/goal: `
    // (`goal-command.ts:683`). Reaching that text proves the branch ran AND
    // that `rest` and `io` were threaded: the message is produced by parsing
    // `rest` and printed through the `io` this REPL passed in.
    expect(output).toContain("/goal:");
    expect(output).not.toContain("Unknown command");
  });

  test("BOUNDARY — an actually unknown slash command still falls through", async () => {
    // Without this, a `/goal` branch that had been deleted could still pass
    // the test above if the fallback happened to print something containing
    // `/goal:`.
    const output = await repl(["/definitely-not-a-command", "/exit"]);
    expect(output).toContain("Unknown command");
  });

  test("the argument is threaded through, not dropped — two arguments, two different refusals", async () => {
    // The substring audit could not tell "`rest` is passed" from "`rest` is
    // mentioned". This can: `parseGoalArgs` produces a DIFFERENT message for
    // each of these (`goal-command.ts:154` vs `:186`), so getting both proves
    // the typed text reached the parser rather than an empty string doing so
    // twice.
    const empty = await repl(["/goal", "/exit"]);
    const danglingFlag = await repl(["/goal do the thing --workspace", "/exit"]);

    expect(empty).toContain("a goal <text> is required");
    expect(danglingFlag).toContain("--workspace requires a value");
    expect(danglingFlag).not.toContain("a goal <text> is required");
  });

  test("no model call is made for a slash command", async () => {
    // The provider in `fakeDeps` throws if it is ever reached. A `/goal` that
    // fell through to the turn driver would surface that here.
    const output = await repl(["/goal", "/exit"]);
    expect(output).not.toContain("the provider must not be reached");
  });
});

// ---------------------------------------------------------------------------
// /plan — replaces the flow 265 source-text audit in `shell.test.ts`.
//
// That audit looked for `let readOnly = false;`, `agentIo.readOnly = () =>
// readOnly;` and the literals `"on"` / `readOnly = true;` inside a 900-character
// window after `command === "/plan"`. None of that can tell whether the toggle
// actually holds its state across two lines, which is the whole point of a
// toggle. These tests read the state back.
// ---------------------------------------------------------------------------

describe("/plan toggles read-only mode (flow 265, was a source-text audit)", () => {
  test("starts off, and says so", async () => {
    expect(await repl(["/plan", "/exit"])).toContain("Read-only mode: off");
  });

  test("/plan on turns it on, and the state survives to the NEXT line", async () => {
    // The audit could see `readOnly = true;` in the source. It could not see
    // whether the assignment outlived the line that made it — a `/plan` branch
    // that set a local and dropped it would have passed.
    const output = await repl(["/plan on", "/plan", "/exit"]);
    expect(output).toContain("Read-only mode: on");
    expect(output).not.toContain("Read-only mode: off");
  });

  test("/plan off turns it back off", async () => {
    const output = await repl(["/plan on", "/plan off", "/plan", "/exit"]);
    expect(output).toContain("Read-only mode: off");
  });

  test("an unrecognised argument gets usage AND leaves the state alone", async () => {
    // Two facts in one run, because the interesting failure is a `/plan
    // bogus` that prints usage and silently resets the toggle.
    const output = await repl(["/plan on", "/plan bogus", "/plan", "/exit"]);
    expect(output).toContain("Usage: /plan [on|off]");
    expect(output).not.toContain("Read-only mode: off");
  });

  test("BOUNDARY — the two states really are distinguishable", async () => {
    // Without this, a `/plan` that always printed "Read-only mode: on" would
    // satisfy the on-test, and one that always printed "off" would satisfy
    // the off-test. Neither can satisfy both.
    const on = await repl(["/plan on", "/plan", "/exit"]);
    const off = await repl(["/plan off", "/plan", "/exit"]);
    expect(on).not.toEqual(off);
  });

  test("/plan does not gate itself behind a confirmation prompt, unlike /mode auto", async () => {
    // The audit asserted this by comparing SOURCE OFFSETS of `command ===
    // "/mode"` and `command === "/plan"` and checking the window held no
    // `readLine()`. What it was really protecting: `/plan on` must not eat the
    // following input line as a yes/no answer. So — feed a following line and
    // check it was still executed as a command.
    const output = await repl(["/plan on", "/plan", "/exit"]);
    expect(output).toContain("Read-only mode: on");
  });
});

// ---------------------------------------------------------------------------
// /reasoning — replaces the flow 268 T16 and T26 source-text audits.
//
// T16 checked for the literals `describeReasoningEffortSource(`,
// `isReasoningEffortLevel(wanted)`, `deps.reasoningEffort = wanted` and
// `saveShellConfig({ reasoningEffort: wanted }, configDir)` inside a
// 2,400-character window. T26 checked that `configDir` appeared at every
// `loadShellConfig`/`saveShellConfig` call in that window — the bug being that
// a session started with a non-default cache dir would persist reasoning
// effort to a DIFFERENT file than the rest of the session reads, so
// `/reasoning` silently does nothing from the operator's point of view.
//
// Both are now checked where it counts: the file on disk.
// ---------------------------------------------------------------------------

describe("/reasoning (flow 268 T16/T26, was a source-text audit)", () => {
  test("with no argument it reports the effort AND where that effort came from", async () => {
    const output = await repl(["/reasoning", "/exit"]);
    expect(output).toContain("Reasoning effort: off (default)");
  });

  test("the reported SOURCE changes once the session overrides it", async () => {
    // `describeReasoningEffortSource` is the thing the audit pinned by name.
    // Its actual job is to distinguish where the value came from, so the test
    // is two runs that must disagree on exactly that.
    const before = await repl(["/reasoning", "/exit"]);
    const after = await repl(["/reasoning high", "/reasoning", "/exit"]);
    expect(before).toContain("(default)");
    expect(after).toContain("Reasoning effort: high (session)");
    expect(after).not.toContain("(default)");
  });

  test("an invalid level is refused BY NAME and changes nothing", async () => {
    const output = await repl(["/reasoning nonsense", "/reasoning", "/exit"]);
    expect(output).toContain("Unknown reasoning effort 'nonsense'");
    // The refusal must not have half-applied: the effort is still the default.
    expect(output).toContain("Reasoning effort: off (default)");
  });

  test("BOUNDARY — a valid level and an invalid one take different paths", async () => {
    const valid = await repl(["/reasoning high", "/exit"]);
    const invalid = await repl(["/reasoning nonsense", "/exit"]);
    expect(valid).toContain("Reasoning effort: high");
    expect(invalid).not.toContain("Reasoning effort: high");
  });

  test("T26 — the level is persisted into the configDir THIS session was given", async () => {
    // The whole point of T26. `saveShellConfig` writes `auth.json` in the
    // directory it is handed; handing it the wrong one is invisible in the
    // source but obvious here.
    const configDir = path.join(root, "cfg");
    await repl(["/reasoning high", "/exit"], { configDir });

    const persisted = JSON.parse(readFileSync(path.join(configDir, "auth.json"), "utf8")) as {
      reasoningEffort?: string;
    };
    expect(persisted.reasoningEffort).toBe("high");
  });

  test("T26 BOUNDARY — and nothing is written there when no level is set", async () => {
    // Without this, a `saveShellConfig` that wrote `high` unconditionally —
    // or a test pointed at a directory something else populates — would pass
    // the test above.
    const configDir = path.join(root, "cfg-untouched");
    await repl(["/reasoning", "/exit"], { configDir });

    const file = path.join(configDir, "auth.json");
    const persisted = existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as { reasoningEffort?: string })
      : {};
    expect(persisted.reasoningEffort).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The advertised command list.
//
// Several audits reached into the source for `const READLINE_AGENT_COMMANDS:
// readonly string[] = [` and sliced to the next `];` to check a command was
// listed. `readlineAgentHelpText()` renders that same array and has been
// exported all along, so this needs no seam — only for someone to call it.
// ---------------------------------------------------------------------------

describe("the readline agent REPL advertises its own commands (was a source-text audit)", () => {
  const help = readlineAgentHelpText();

  for (const command of ["/goal", "/plan", "/reasoning"]) {
    test(`${command} is advertised`, () => {
      expect(help).toContain(command);
    });
  }

  test("BOUNDARY — and a command that does not exist is not advertised", () => {
    // Without this, help text that listed every conceivable slash command
    // (or a `toContain` against something too short, like "/") would pass
    // the three tests above.
    expect(help).not.toContain("/definitely-not-a-command");
  });

  test("/help prints that list at the prompt", () => {
    // The list is only worth pinning because the user can reach it. This is
    // the part no source-text audit checked at all.
    return repl(["/help", "/exit"]).then((output) => {
      expect(output).toContain("/goal");
    });
  });
});
