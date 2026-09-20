import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { busLeasesFromClient, readlineAgentHelpText, runAgentRepl } from "./shell";
import type { AgentDeps } from "./agent";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import type { ShellSessionOpts } from "./shell-types";
import type { BusClient } from "../bus/client";
import { resolveBusRoot } from "../bus/paths";
import { createPauseLease } from "../bus/pause";
import { CI_ENV_VARS } from "../capability/external-agents";
import { loadShellPermissions } from "../lib/shell-permissions";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import type { ToolRisk } from "../harness/tool/types";
import type { JobRegistry } from "../harness/tool/builtin/background-job-registry";
import type { NormalizedEvent, ProviderDescription, ProviderPort } from "../harness/provider/types";

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
// Below: a scripted `ProviderPort` and a minimal `InteractiveTool`, so a
// "chat line" can actually reach a tool call and its approval prompt (the
// SAME technique `agent-permission-mode.test.ts` uses against `runAgentTurn`
// directly — reused here one layer up, against the readline REPL that
// constructs `agentIo.requestApproval` and decides what to persist).
// ---------------------------------------------------------------------------

const TOOL_CALL_DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

/** One round with a single tool call, then a final text round — mirrors `agent-permission-mode.test.ts`'s `callScript`. */
function toolCallProvider(tool: string, input: string): ProviderPort {
  const rounds: Partial<NormalizedEvent>[][] = [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName: tool },
      { kind: "tool_call_end", toolCallId: "c1", input },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "done" }, { kind: "model_end" }],
  ];
  let call = 0;
  return {
    describe: () => TOOL_CALL_DESCRIPTION,
    stream: (_request, opts) => {
      const events = rounds[call] ?? [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
        }
      })();
    },
  };
}

/**
 * A text-only, single-round provider that counts how many times `.stream()`
 * was called — i.e. how many turns actually reached the model. Mirrors
 * `toolCallProvider`'s event shape exactly (including `attemptId`): the
 * first hand-written attempt at this omitted it and the driver read that as
 * "never finishing", looping `.stream()` up to the 40-round cap instead of
 * completing in one call — the PROBE that caught it is worth keeping as a
 * comment, since it is not the kind of mistake source text could show.
 */
function textOnlyProvider(text: string): { provider: ProviderPort; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    provider: {
      describe: () => TOOL_CALL_DESCRIPTION,
      stream: (_request, opts) => {
        calls += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text } as NormalizedEvent;
          yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
        })();
      },
    },
  };
}

/** A no-op `shell_exec`-shaped tool: enough to let the approval gate run without touching a real shell. */
function fakeShellExecTool(risk: ToolRisk = "shell"): InteractiveTool {
  return {
    definition: {
      name: "shell_exec",
      description: "test tool",
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
      risk,
    },
    invoke: async () => ({ output: "ran", isError: false }),
  };
}

// ---------------------------------------------------------------------------
// Flow 275 T8/F3 (specification §4.3, §4.4) — held-turn wiring, the
// completion-wake held gate, and the busLeases join-success rebuild need a
// REAL joined `BusClient`: `isHeld()` reads `bus?.leaseView().held()`, a
// value only a genuine join ever sets, and the join itself is gated on
// `sessionsOn && live !== undefined` — a real, if hermetic, session. Unlike
// every other test in this file, the test needs to ACT (create/refresh/
// release a pause lease) WHILE the REPL is mid-session, between two lines —
// `repl()`'s fixed `linesFrom` array cannot do that. `runningRepl` below
// drives the SAME real `runAgentRepl` over a push-based queue instead, and
// exposes the `busBox` seam `ShellSessionOpts` already has in production (the
// CLI's own `/bus` handling needs the live client too) so the test can wait
// for the join and then act on the EXACT `BusClient` instance `isHeld()`
// reads — no new production seam, no fake bus.
// ---------------------------------------------------------------------------

const BUS_ENV_KEYS = ["KERYX_DATA_DIR", "KERYX_BUS", "KERYX_BUS_POLL_MS", ...CI_ENV_VARS];

function git(dir: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "keryx test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "keryx test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${new TextDecoder().decode(proc.stderr)}`);
  }
}

/** Polls until `check()` is true. Never a fixed sleep — the join/refresh timing is real I/O. */
async function waitUntil(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A `lines: AsyncIterable<string>` the test can keep pushing to WHILE `runAgentRepl` is reading it. */
function lineQueue(): { lines: AsyncIterable<string>; push: (line: string) => void } {
  const pending: string[] = [];
  let wake: (() => void) | undefined;
  return {
    push: (line: string) => {
      pending.push(line);
      const w = wake;
      wake = undefined;
      w?.();
    },
    lines: (async function* (): AsyncGenerator<string> {
      for (;;) {
        while (pending.length > 0) {
          yield pending.shift() as string;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })(),
  };
}

/**
 * A `JobRegistry` whose `.onCompletion` callback the test can fire directly —
 * no real background process needed.
 *
 * Each `fire()` arms exactly ONE completion; `drainUndelivered()` hands it
 * out once and reports `[]` until the NEXT `fire()` — mirroring the real
 * registry's own documented contract ("marks observed IN THE SAME
 * synchronous step, so a concurrent or replayed drain returns nothing
 * twice"). The first version of this fake always returned the same
 * completion regardless of drain count, and it produced a real bug worth
 * keeping the story of: `runAgentTurnCore`'s per-round drain (`agent.ts:
 * 2715`) found "new" work at the end of every round IT caused, so a SINGLE
 * `fire()` call fed a self-sustaining loop of task-notification rounds that
 * never terminated on its own — only an operator line's line winning a race
 * against it stopped the spam. Proof that this fake's contract matters, not
 * just its call signature.
 */
function fakeJobRegistry(): { registry: JobRegistry; fire: () => void } {
  let onCompletion: (() => void) | undefined;
  let pending = false;
  let jobCounter = 0;
  return {
    registry: {
      onCompletion: (cb: () => void) => {
        onCompletion = cb;
      },
      drainUndelivered: () => {
        if (!pending) return [];
        pending = false;
        jobCounter += 1;
        return [
          {
            jobId: `job-${jobCounter}`,
            status: "completed" as const,
            startedAt: "2026-01-01T00:00:00.000Z",
            endedAt: "2026-01-01T00:00:01.000Z",
            durationMs: 1000,
            output: "done",
          },
        ];
      },
    } as unknown as JobRegistry,
    fire: () => {
      pending = true;
      onCompletion?.();
    },
  };
}

/** Drives the real REPL over a queue the test can keep pushing to, with a REAL bus join (`sessionOpts.enabled: true`). */
function runningRepl(opts: { deps: AgentDeps; configDir?: string }): {
  push: (line: string) => void;
  output: () => string;
  busBox: { current: BusClient | undefined };
  done: Promise<void>;
} {
  const q = lineQueue();
  const out: string[] = [];
  const busBox: { current: BusClient | undefined } = { current: undefined };
  const done = runAgentRepl(
    q.lines,
    { printPrompt: () => {}, safeBoundary: undefined, write: (s) => out.push(s) },
    opts.deps,
    fakePort(),
    { cwd, enabled: true, busBox },
    undefined,
    undefined,
    undefined,
    opts.configDir ?? path.join(root, "config"),
  );
  return { push: q.push, output: () => out.join(""), busBox, done };
}

describe("flow 275 T8/F3 — held-turn wiring, the completion-wake held gate, and busLeases (was three source-text audits)", () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of BUS_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.KERYX_DATA_DIR = path.join(root, "data");
    delete process.env.KERYX_BUS;
    delete process.env.KERYX_BUS_POLL_MS;
    for (const key of CI_ENV_VARS) delete process.env[key];
    writeFileSync(path.join(cwd, "README.md"), "x\n", "utf8");
    git(cwd, "init", "-q", "-b", "main");
    git(cwd, "add", ".");
    git(cwd, "commit", "-q", "-m", "initial");
  });

  afterEach(() => {
    for (const key of BUS_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** A "turns" or "git-publish" pause lease held by a fabricated peer, targeting @all (so it applies to whatever instance joins). */
  async function holdLease(
    scope: "turns" | "git-publish",
    reason: string,
  ): Promise<{ leaseId: string; busRoot: string }> {
    const { root: busRoot } = await resolveBusRoot(cwd);
    const lease = await createPauseLease(busRoot, {
      holder: { instanceId: randomUUID(), name: "peer", origin: "cli" },
      toLabel: "@all",
      scope,
      reason,
    });
    return { leaseId: lease.leaseId, busRoot };
  }

  test("busLeasesFromClient adapts a full PauseLease down to {name, reason} — the adapter itself needs no REPL at all", () => {
    // Replaces the first assertion of the old "busLeases wiring" source-text
    // audit outright: the adapter has been exported all along
    // (`shell.ts:289`), so the "does it exist with this shape" question is
    // answerable by calling it, not by reading its source.
    const fakeBus = {
      leaseView: () => ({
        appliesToMe: (scope: string) => scope === "git-publish",
        appliesToMeLease: (scope: string) =>
          scope === "git-publish"
            ? { holder: { name: "alice" }, reason: "cutting the release" }
            : undefined,
      }),
    } as unknown as BusClient;
    const adapted = busLeasesFromClient(fakeBus);
    expect(adapted.appliesToMe("git-publish")).toBe(true);
    expect(adapted.appliesToMe("turns")).toBe(false);
    expect(adapted.heldBy?.("git-publish")).toEqual({ name: "alice", reason: "cutting the release" });
  });

  test("a real bus join threads busLeases onto deps: a git-publish lease from ANOTHER peer reaches the approval prompt", async () => {
    // Replaces the second half of the old audit — "the join-success rebuild
    // folds busLeases: busLeasesFromClient(joined) onto deps" — which could
    // only be read as source text before (`runAgentRepl` builds `bus` from a
    // real `joinBus()` call with no injection point). Proven here through a
    // REAL join: a lease created by a DIFFERENT instance, over the SAME bus
    // root the join resolves to, must change what the operator sees when
    // asked to approve a `git push` — proof that `deps.busLeases` was wired
    // from the live `BusClient`, not left unset (the pre-flow-275 default).
    const session = runningRepl({
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [fakeShellExecTool()],
        provider: toolCallProvider("shell_exec", JSON.stringify({ command: "git push origin main" })),
      } as unknown as AgentDeps,
    });
    await waitUntil(() => session.busBox.current !== undefined, "the bus join to settle");
    await holdLease("git-publish", "cutting a release");
    await session.busBox.current?.leaseView().refresh();

    session.push("please push my changes");
    await waitUntil(
      () => /a git-publish lease applies/.test(session.output()),
      `the publish-lease hint in the approval prompt\n${session.output()}`,
    );
    // Distinguishes "the hint is real" from "any prompt would do": a plain,
    // non-publish command approved the same way never shows this hint (see
    // the boundary test below, which proves the negative directly).
    expect(session.output()).toContain("Run: git push origin main");
    session.push("n"); // deny, so the turn ends cleanly
    session.push("/exit");
    await session.done;
  });

  test("BOUNDARY — the same approval prompt, no lease: no publish-lease hint", async () => {
    const session = runningRepl({
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [fakeShellExecTool()],
        provider: toolCallProvider("shell_exec", JSON.stringify({ command: "git push origin main" })),
      } as unknown as AgentDeps,
    });
    await waitUntil(() => session.busBox.current !== undefined, "the bus join to settle");
    // No lease created this time — same command, same bus, no peer holding it.
    session.push("please push my changes");
    await waitUntil(
      () => session.output().includes("Run: git push origin main"),
      `the approval prompt\n${session.output()}`,
    );
    expect(session.output()).not.toContain("a git-publish lease applies");
    session.push("n");
    session.push("/exit");
    await session.done;
  });

  test("F3 — a task-completion wake is gated by isHeld() BEFORE the auto-wake cap: no turn starts, and the budget is not spent", async () => {
    // Replaces "flow 275 F3 — completion-wake held gate". `deps.jobRegistry`
    // is a plain injected field (like `busLeases`), so the completion source
    // needs no real background process — only `isHeld()` needs to be real,
    // which is why this shares the bus-join harness above instead of using
    // the plain `repl()` helper.
    const jobs = fakeJobRegistry();
    const model = textOnlyProvider("done");
    const session = runningRepl({
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [],
        jobRegistry: jobs.registry,
        provider: model.provider,
      } as unknown as AgentDeps,
    });
    await waitUntil(() => session.busBox.current !== undefined, "the bus join to settle");
    await holdLease("turns", "reviewing the merge");
    await session.busBox.current?.leaseView().refresh();

    // Fire repeatedly (a no-op once nobody is listening) until the loop is
    // actually sitting at its completion race — there is a real window,
    // after the join settles and before the loop's first read, where firing
    // once would be lost. Once the notice appears, stop: firing again would
    // just be a second, indistinguishable no-op.
    await waitUntil(() => {
      jobs.fire();
      return session.output().includes("The finished task will be reported once the lease ends");
    }, `the held-completion notice\n${session.output()}`);
    // Give a (wrongly-started) turn a further window to appear before
    // asserting its absence — the notice alone only proves the branch was
    // reached, not that it stopped there.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(model.calls()).toBe(0);

    session.push("/exit");
    await session.done;
  });

  test("BOUNDARY — once released, the SAME completion wakes a turn (proves the gate, not a permanently-disabled wake)", async () => {
    const jobs = fakeJobRegistry();
    const model = textOnlyProvider("done");
    const session = runningRepl({
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [],
        jobRegistry: jobs.registry,
        provider: model.provider,
      } as unknown as AgentDeps,
    });
    await waitUntil(() => session.busBox.current !== undefined, "the bus join to settle");
    // No lease this time — a completion with nobody held wakes a turn. Fire
    // repeatedly for the same reason as the held test above: the loop may
    // not yet be at its completion race the first time this runs. `>= 1`,
    // not `=== 1`: the driver may take a harmless extra round even for a
    // text-only reply (unrelated to held-gating, which is what this proves),
    // and asserting the exact count would just make the test fragile against
    // that.
    await waitUntil(() => {
      jobs.fire();
      return model.calls() >= 1;
    }, `a turn to start\n${session.output()}`);

    session.push("/exit");
    await session.done;
  });
});

describe("flow 265 AC7/AC8 — readline wakes on a task completion (was a source-text audit)", () => {
  // Unlike the describe above, none of these need a real bus — `KERYX_BUS=off`
  // so `isHeld()` is unconditionally false and the completion race is the
  // only mechanism under test. `runningRepl`'s push-based queue is still
  // needed: firing a completion between two pushed lines is exactly the
  // "between two lines" timing the plain `repl()` helper cannot do.
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv = {};
    for (const key of BUS_ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.KERYX_DATA_DIR = path.join(root, "data");
    process.env.KERYX_BUS = "off";
    delete process.env.KERYX_BUS_POLL_MS;
    for (const key of CI_ENV_VARS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of BUS_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  /** Echoes back the last history message's content — lets a test tell an operator's turn apart from a task-notification's. */
  function echoProvider(): { provider: ProviderPort; texts: () => string[] } {
    const texts: string[] = [];
    return {
      texts: () => texts,
      provider: {
        describe: () => TOOL_CALL_DESCRIPTION,
        stream: (request, opts) => {
          const last = request.messages.at(-1);
          texts.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
          return (async function* (): AsyncGenerator<NormalizedEvent> {
            yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "ok" } as NormalizedEvent;
            yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
          })();
        },
      },
    };
  }

  test("a finished background task wakes an IDLE repl with no keystroke, and the turn is marked as a task-notification, not an operator line", async () => {
    // Replaces the "gets a completion subscription" and "races the next
    // input line against the next completion" rows: the OLD audit could only
    // see `.onCompletion(` and `Promise.race` as substrings. This drives a
    // real idle wait — no line is ever pushed — and proves the wake happens
    // anyway, through the SAME turn machinery an operator line uses, but
    // with the model-visible content `buildTaskNotification` produces
    // (`task_id="..."`), never the empty string a task-notification turn
    // is actually run with.
    const jobs = fakeJobRegistry();
    const model = echoProvider();
    const session = runningRepl({
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [],
        jobRegistry: jobs.registry,
        provider: model.provider,
      } as unknown as AgentDeps,
    });
    await waitUntil(() => session.output().includes("bus: off"), "session setup to finish");

    // Check-THEN-fire, not fire-then-check: with an in-process fake provider
    // that resolves in the same tick, firing again on the very poll that
    // just observed success would start a SECOND, unwanted notification
    // turn before "hello there" ever got a chance to run — which is exactly
    // the failure this comment is warning the next editor away from
    // reintroducing.
    await waitUntil(() => {
      if (model.texts().length >= 1) return true;
      jobs.fire();
      return false;
    }, `the idle wake to reach the model\n${session.output()}`);
    expect(model.texts()[0]).toContain('task_id="job-1"');

    // BOUNDARY — an operator line's own turn carries the TYPED text, not a
    // notification: proves the two paths are distinguishable, not that
    // "some text" always contains a task id.
    session.push("hello there");
    await waitUntil(() => model.texts().length >= 2, `the operator's own turn\n${session.output()}`);
    expect(model.texts()[1]).toBe("hello there");

    session.push("/exit");
    await session.done;
  });

  test("consecutive auto-wakes are capped, and an operator line resets the counter", async () => {
    // Replaces "consecutive auto-wakes are capped and the counter is reset
    // by operator input" — the old audit could only see `resolveMaxAutoWake`
    // and a `= 0` reset as substrings, which cannot tell "resets" from
    // "assigns 0 once at declaration". `KERYX_SHELL_MAX_AUTO_WAKE=1` (a real,
    // already-injectable env var — not a new seam) keeps this deterministic
    // and fast instead of driving the default cap of 5.
    const savedCap = process.env.KERYX_SHELL_MAX_AUTO_WAKE;
    process.env.KERYX_SHELL_MAX_AUTO_WAKE = "1";
    try {
      const jobs = fakeJobRegistry();
      const model = textOnlyProvider("ok");
      const session = runningRepl({
        deps: {
          providerId: "s",
          modelId: "m",
          systemInstruction: "sys",
          idSeq: () => randomUUID(),
          tools: [],
          jobRegistry: jobs.registry,
          provider: model.provider,
        } as unknown as AgentDeps,
      });
      await waitUntil(() => session.output().includes("bus: off"), "session setup to finish");

      // First completion: wakes (cap is 1, so this is allowed).
      await waitUntil(() => {
        jobs.fire();
        return model.calls() >= 1;
      }, `the first auto-wake\n${session.output()}`);
      // Second completion, right after: the cap is now spent.
      await waitUntil(() => {
        jobs.fire();
        return session.output().includes("automatic wakes are capped");
      }, `the cap notice\n${session.output()}`);
      const callsAtCap = model.calls();

      // An operator line resets the counter — proven by a FURTHER completion
      // being allowed through afterwards, not merely by the reset assignment
      // existing somewhere in the source.
      session.push("hi");
      await waitUntil(() => model.calls() > callsAtCap, `the operator's own turn\n${session.output()}`);
      const callsAfterOperatorTurn = model.calls();
      await waitUntil(() => {
        jobs.fire();
        return model.calls() > callsAfterOperatorTurn;
      }, `a completion to wake again after the reset\n${session.output()}`);

      session.push("/exit");
      await session.done;
    } finally {
      if (savedCap === undefined) delete process.env.KERYX_SHELL_MAX_AUTO_WAKE;
      else process.env.KERYX_SHELL_MAX_AUTO_WAKE = savedCap;
    }
  });
});

describe("flow 173 AC7 — runAgentRepl sweeps background jobs on real session exit, not /new|/clear (was a source-text audit)", () => {
  // The old audit counted occurrences of the literal
  // `"await deps.sweepBackgroundJobs?.();"` in a WIDE slice of source text
  // (`runAgentRepl`'s start to `if (agentMode) {` — 1,080 lines past the
  // function's real end, per the inventory) and asserted it appeared exactly
  // twice, in windows anchored on other literals. None of that can tell
  // whether the hook fires FOR REAL on EOF/`/exit`, or whether `/new`
  // wrongly sweeps a job that (AC9) must survive it. This calls the real
  // hook, three ways, and checks nothing else needed converting: the
  // `agentModeBranch`-scoped rows in the same audit (declaring the registry,
  // threading it into `buildInteractiveAgentTools`, building the
  // `sweepBackgroundJobs` field) are `shellCommand`'s CLI setup code, OUTSIDE
  // `runAgentRepl` (they run BEFORE its call, not reachable through `repl()`
  // at all) — left as source text, out of `runAgentRepl`'s reach.
  test("EOF sweeps background jobs", async () => {
    let swept = 0;
    await repl([], { deps: fakeDeps({ sweepBackgroundJobs: async () => { swept += 1; } }) });
    expect(swept).toBe(1);
  });

  test("/exit sweeps background jobs", async () => {
    let swept = 0;
    await repl(["/exit"], { deps: fakeDeps({ sweepBackgroundJobs: async () => { swept += 1; } }) });
    expect(swept).toBe(1);
  });

  test("BOUNDARY — /new does NOT sweep (AC9: a background job survives /new, only real exit sweeps it)", async () => {
    let swept = 0;
    await repl(["/new", "/exit"], { deps: fakeDeps({ sweepBackgroundJobs: async () => { swept += 1; } }) });
    // Exactly one sweep — from the trailing /exit, not from /new.
    expect(swept).toBe(1);
  });
});

describe("SLATE-3a — the readline turn loop resets the subagent budget at the start of every turn (was a source-text audit)", () => {
  // The old audit's `toContain("deps.resetSubagentBudget?.();")` check could
  // not tell "called once at setup" from "called at the start of EVERY
  // turn" — the whole point of a per-turn reset. Two real turns, a spy that
  // records how many times it ran BEFORE each one, answers that directly.
  test("resetSubagentBudget runs before each of two consecutive turns, not just the first", async () => {
    let resets = 0;
    const resetsBeforeCall: number[] = [];
    const model = textOnlyProvider("ok");
    const wrappedProvider: typeof model.provider = {
      describe: model.provider.describe,
      stream: (request, opts) => {
        resetsBeforeCall.push(resets);
        return model.provider.stream(request, opts);
      },
    };
    await repl(["first message", "second message", "/exit"], {
      deps: fakeDeps({
        provider: wrappedProvider,
        tools: [],
        idSeq: () => randomUUID(),
        resetSubagentBudget: () => {
          resets += 1;
        },
      }),
    });
    expect(model.calls()).toBe(2);
    // Each turn's own `.stream()` call saw a resets count ONE HIGHER than
    // the previous turn's — proof the reset ran freshly before each turn,
    // not once ever.
    expect(resetsBeforeCall).toEqual([1, 2]);
  });
});

describe("flow 275 T8 — no always-allow offer under a publishLease (was a source-text audit)", () => {
  // The old audit read the source for `!evaled.publishLease` inside the
  // `rememberable` expression and `publishLease: evaled.publishLease` inside
  // the `rememberExactShellGrant` call. Neither literal proves the STORE was
  // ever protected — only that some code mentions the flag. These tests
  // answer "always" to a real approval prompt and read the actual permission
  // file back: `dir` is `rememberExactShellGrant`'s own new seam (this
  // dispatch), threaded from `runAgentRepl`'s `configDir` — undefined in
  // production today, so this is zero behaviour change for a real operator.
  test("answering 'always' under an active publish lease persists NOTHING", async () => {
    const configDir = path.join(root, "cfg-publish-lease");
    const output = await repl(["please push my changes", "always", "/exit"], {
      configDir,
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [fakeShellExecTool()],
        provider: toolCallProvider("shell_exec", JSON.stringify({ command: "git push origin main" })),
        busLeases: {
          appliesToMe: (scope: string) => scope === "git-publish",
          heldBy: (scope: string) =>
            scope === "git-publish" ? { name: "peer", reason: "cutting a release" } : undefined,
        },
      } as unknown as AgentDeps,
    });
    // Under a publish lease, `rememberable` is false, so the prompt is
    // plain [y/N] — "always" does not even parse as the always-answer, and
    // is treated as a plain (non-"y") denial.
    expect(output).toContain("[y/N] ");
    expect(output).not.toContain("[y/N/A=always]");
    // "will not be remembered" is the HINT (`formatShellApprovalHints`) —
    // expected here, and not what this test is about. "approved ·
    // remembered" is the STORE actually being written to, which is what must
    // never happen under a publish lease.
    expect(output).not.toContain("approved · remembered");
    expect(loadShellPermissions(configDir).allow).toEqual([]);
  });

  test("BOUNDARY — the SAME answer, SAME command, no lease: it persists a grant", async () => {
    const configDir = path.join(root, "cfg-no-lease");
    const output = await repl(["please push my changes", "always", "/exit"], {
      configDir,
      deps: {
        providerId: "s",
        modelId: "m",
        systemInstruction: "sys",
        idSeq: () => randomUUID(),
        tools: [fakeShellExecTool()],
        provider: toolCallProvider("shell_exec", JSON.stringify({ command: "git push origin main" })),
        // no busLeases at all — the pre-flow-275 default.
      } as unknown as AgentDeps,
    });
    expect(output).toContain("[y/N/A=always]");
    expect(output).toContain("remembered");
    expect(loadShellPermissions(configDir).allow.length).toBeGreaterThan(0);
  });
});

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
