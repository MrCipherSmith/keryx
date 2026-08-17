// RED tests for SLATE-15's `/goal` command core (flow 161, T10 — AC1/AC2).
//
// Pins `src/commands/goal-command.ts` (does NOT exist yet; T11 creates it).
// Every test below fails at IMPORT time until then — the expected RED
// failure for the WHOLE file (mirrors harness.test.ts's own documented
// pattern), not a per-test bug.
//
// WHY a new shared module instead of testing `shell.ts`/`tui-shell.ts`
// directly: `runAgentRepl` (shell.ts) is explicitly "NOT unit-tested" per its
// own doc comment, and the TUI's `/goal` handler would be another giant
// inline closure with no injection seam (the SAME shape `applyRuntimeSwitchToSlate`
// in tui-shell.ts was extracted to solve for `/model`'s SLATE-2a wiring — see
// that function's doc comment). `runGoalCommand` is the same kind of
// extracted, independently-testable seam for `/goal`'s actual behavior;
// BOTH surfaces call it (proven separately by the source-text-audit tests in
// shell.test.ts / tui-shell.test.ts), so testing it once here covers the
// real AC1/AC2 logic, and the per-surface tests only need to prove the
// wiring, not re-prove the behavior.
//
// PINNED API (T11 implements exactly this surface — see subagent-result):
//   export interface ParsedGoalArgs { text: string; workspaceId?: string }
//   export interface GoalArgsError { error: string }
//   export function parseGoalArgs(rest: string): ParsedGoalArgs | GoalArgsError;
//
//   export interface RunGoalCommandParams {
//     raw: string;               // text after the "/goal" token (readline: `rest`; TUI: line.slice(command.name.length).trim())
//     cwd: string;               // project cwd — passed to resolveWorkspaceForActor AND ensureSlateOpened
//     io: AgentIO;
//     deps: AgentDeps;
//     history: NormalizedMessage[];
//     slateSession: SlateSessionRef | undefined;
//     mintAttemptId: () => string;
//   }
//   export async function runGoalCommand(params: RunGoalCommandParams): Promise<void>;
//
// Ordering (AC1): parse → if `--workspace <id>` given, validate FIRST via
// `resolveWorkspaceForActor(cwd, id)` (src/sac/workspace-service.ts, SLATE-15's
// shared fail-closed helper) — on `!ok`, `io.onSystem` a clear rejection and
// RETURN, without ever calling `ensureSlateOpened` or `runAgentTurn`. On
// success (or no `--workspace` given): `ensureSlateOpened(slateSession, ...)`
// (when `slateSession` is defined), then — ONLY if `--workspace` was given
// and valid — a locked `writeSlate` setting `slate.workspaceId`, THEN
// `runAgentTurn(io, deps, history, text, {slateSession})`.
//
// AC2: omitting `--workspace` must NEVER create a workspace — `runGoalCommand`
// never imports/calls `WorkspaceService.create` (only `resolveWorkspaceForActor`,
// which internally only ever calls `.show()`) — proven below by a real
// filesystem check (no `.metaproject/workspaces/` entries appear).

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDeps, AgentIO } from "./agent";
// RED: `./goal-command` does not exist yet (T11 creates it).
import { parseGoalArgs, runGoalCommand } from "./goal-command";
import type { GoalArgsError, ParsedGoalArgs } from "./goal-command";
import type { SlateSessionRef } from "../session/slate-lifecycle";
import { readSlate } from "../session/slate";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "../sac/workspace-service";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription } from "../harness/provider/types";

// --- parseGoalArgs (pure) ---------------------------------------------------

function isError(value: ParsedGoalArgs | GoalArgsError): value is GoalArgsError {
  return "error" in value;
}

test("parseGoalArgs: bare text, no --workspace", () => {
  const parsed = parseGoalArgs("do the thing");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("do the thing");
    expect(parsed.workspaceId).toBeUndefined();
  }
});

test("parseGoalArgs: text followed by --workspace <id>", () => {
  const parsed = parseGoalArgs("do the thing --workspace w1");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("do the thing");
    expect(parsed.workspaceId).toBe("w1");
  }
});

// Review finding 5: `--workspace` used to be recognized via `tokens.indexOf`
// at ANY position in the goal text — including leading and mid-sentence, as
// the two tests below originally asserted. That is a genuine bug: there is
// no content-based way to tell "a real --workspace flag" apart from "the
// goal's own prose happens to contain the literal token --workspace"
// (see parseGoalArgs's own doc comment for the concrete false-positive this
// caused: "/goal document how --workspace flag works" silently lost the
// word "flag" to `workspaceId`). The fix narrows recognition to ONLY the
// trailing position (`... --workspace <id>` as the last two tokens),
// matching ordinary CLI flag convention. That is a deliberate, documented
// behavior change — not a pre-existing bug in these tests — so the two
// tests below are UPDATED (not silently weakened) to assert the new, safer
// contract: leading/mid-sentence `--workspace` is no longer treated as a
// flag at all, and the entire input is preserved as goal text instead.

test("parseGoalArgs: --workspace <id> BEFORE the text is no longer treated as a flag (review finding 5) — the whole string is goal text", () => {
  const parsed = parseGoalArgs("--workspace w1 do the thing");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("--workspace w1 do the thing");
    expect(parsed.workspaceId).toBeUndefined();
  }
});

test("parseGoalArgs: --workspace embedded mid-sentence (not trailing) is no longer treated as a flag (review finding 5) — the whole string is goal text", () => {
  const parsed = parseGoalArgs("implement the login flow --workspace w-42 for the app");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("implement the login flow --workspace w-42 for the app");
    expect(parsed.workspaceId).toBeUndefined();
  }
});

test("review finding 5: ordinary goal text that happens to contain the literal word '--workspace' mid-sentence is preserved verbatim, with no workspaceId extracted", () => {
  const parsed = parseGoalArgs("document how --workspace flag works");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("document how --workspace flag works");
    expect(parsed.workspaceId).toBeUndefined();
  }
});

test("review finding 5: a genuine trailing --workspace <id> still works correctly, including with multi-word goal text", () => {
  const parsed = parseGoalArgs("implement the login flow --workspace w-42");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("implement the login flow");
    expect(parsed.workspaceId).toBe("w-42");
  }
});

test("parseGoalArgs: empty / whitespace-only input is an error (text required)", () => {
  expect(isError(parseGoalArgs(""))).toBe(true);
  expect(isError(parseGoalArgs("   "))).toBe(true);
});

test("parseGoalArgs: --workspace with no value is an error", () => {
  const parsed = parseGoalArgs("do the thing --workspace");
  expect(isError(parsed)).toBe(true);
});

test("parseGoalArgs: --workspace given but no goal text is an error (text required)", () => {
  const parsed = parseGoalArgs("--workspace w1");
  expect(isError(parsed)).toBe(true);
});

// --- runGoalCommand (integration) ------------------------------------------

async function tempCwd(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-goal-cwd-"));
}

async function tempSessionDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "keryx-goal-session-"));
}

const STRICT_GUARD = {
  mode: "strict" as const,
  availability: "available" as const,
  decision: "pass" as const,
  policyRevision: "local-offline-v1",
};

/** Records call count and always throws — proves runAgentTurn/the provider was NEVER reached. */
function throwingProvider(): { provider: AgentDeps["provider"]; callCount: () => number } {
  let calls = 0;
  const description: ProviderDescription = {
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
  return {
    callCount: () => calls,
    provider: {
      describe: () => description,
      stream: () => {
        calls += 1;
        throw new Error("runGoalCommand must not reach the provider on a rejected /goal");
      },
    },
  };
}

function textOnlyProvider(text: string): { provider: AgentDeps["provider"]; callCount: () => number } {
  let calls = 0;
  const description: ProviderDescription = {
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
  return {
    callCount: () => calls,
    provider: {
      describe: () => description,
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

function collectingIo(): { io: AgentIO; system: string[] } {
  const system: string[] = [];
  return { system, io: { write: () => {}, onSystem: (s) => system.push(s) } };
}

let idCounter = 0;
function fixedIdSeq(): () => string {
  idCounter = 0;
  return () => `id-${idCounter++}`;
}

test("AC1: /goal --workspace <invalid id> rejects fail-closed — no slate is ever created, the turn never runs, and the rejection is explicit", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = throwingProvider();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runGoalCommand({
    raw: "do the thing --workspace bogus-not-a-real-workspace",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // Fail closed: an explicit rejection was printed, mentioning the bad id.
  expect(system.some((line) => line.includes("bogus-not-a-real-workspace"))).toBe(true);
  // No slate was EVER opened/created for this attempt.
  expect(slateSession.opened).toBe(false);
  expect(await readSlate(dir)).toBeUndefined();
  // The turn never ran — the provider was never reached.
  expect(callCount()).toBe(0);
  // Nothing else was pushed into history either.
  expect(history.length).toBe(0);
});

test("SLATE-16 supersedes AC2: /goal with no --workspace now resolves-or-creates via the injected resolver and binds the result; the turn actually runs", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("On it.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];
  const resolveCalls: Array<{ cwd: string; topicHint: string; provider?: string; model?: string }> = [];

  await runGoalCommand({
    raw: "implement the thing",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
    resolveWorkspace: async (input) => {
      resolveCalls.push(input);
      return { ok: true, workspaceId: "workspace-resolved", action: "created" };
    },
  });

  expect(slateSession.opened).toBe(true);
  const slate = await readSlate(dir);
  expect(slate).toBeDefined();
  expect(slate?.workspaceId).toBe("workspace-resolved");
  expect(resolveCalls).toEqual([{ cwd, topicHint: "implement the thing", provider: "scripted", model: "m" }]);

  // The turn actually ran with the parsed text as the userLine.
  expect(callCount()).toBe(1);
  expect(history.some((m) => m.role === "user" && m.content === "implement the thing")).toBe(true);
});

test("SLATE-16: a resolver that fails/is ambiguous never blocks /goal — the turn still runs and workspaceId stays unset", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("On it.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runGoalCommand({
    raw: "implement the thing",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
    resolveWorkspace: async () => ({ ok: false, reason: "ambiguous" }),
  });

  expect(slateSession.opened).toBe(true);
  const slate = await readSlate(dir);
  expect(slate?.workspaceId).toBeUndefined();
  expect(callCount()).toBe(1);
});

test("SLATE-16 (AC-25): a second /goal with no --workspace on an already-bound slate is never re-resolved", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider } = textOnlyProvider("On it.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();
  let resolveCalls = 0;
  const resolveWorkspace = async () => {
    resolveCalls += 1;
    return { ok: true as const, workspaceId: "workspace-resolved", action: "created" as const };
  };

  await runGoalCommand({ raw: "first goal", cwd, io, deps, history: [], slateSession, mintAttemptId: () => "attempt-0", resolveWorkspace });
  expect(resolveCalls).toBe(1);

  await runGoalCommand({ raw: "second, unrelated goal", cwd, io, deps, history: [], slateSession, mintAttemptId: () => "attempt-1", resolveWorkspace });
  expect(resolveCalls).toBe(1);
  const slate = await readSlate(dir);
  expect(slate?.workspaceId).toBe("workspace-resolved");
});

test("AC1 success path: /goal --workspace <real, visible id> opens the slate AND binds slate.workspaceId to it; the turn runs", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };

  // Create a REAL, visible workspace under this same cwd, with the SAME local
  // actor `resolveWorkspaceForActor` (used internally by `runGoalCommand`)
  // resolves to — so it is genuinely visible, not a foreign-owner fixture.
  const owner = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: STRICT_GUARD,
  });
  const created = await owner.create({
    request: undefined,
    requestCorrelationId: "goal-command-fixture-0001",
    id: "workspace-goal-fixture",
    title: "Goal Fixture",
  });

  // T11 fix (documented deviation — see subagent-result): the ORIGINAL fixture
  // text here was "Bound and running." — coincidentally, "running" is a
  // reserved marker token in `commands/agent.ts`'s `modelClaimedAction`
  // (pre-existing SA-01 toolless-reprompt heuristic, unrelated to SLATE-15).
  // Since `raw`'s goal text ("implement the thing") trips `isActionRequest`,
  // and the assistant's own reply happened to contain "running", the EXISTING
  // (unmodified) reprompt logic in `runAgentTurnCore` fired a second
  // `provider.stream` round — genuinely correct behavior for that heuristic,
  // but an accidental collision with this fixture's wording, unrelated to
  // what THIS test is actually pinning (that /goal binds workspaceId and runs
  // the turn once). Renamed to text with no reprompt-marker tokens so the
  // turn completes in exactly one round, matching this test's own
  // `callCount()).toBe(1)` assertion below.
  const { provider, callCount } = textOnlyProvider("Workspace bound.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runGoalCommand({
    raw: `implement the thing --workspace ${created.id}`,
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  expect(slateSession.opened).toBe(true);
  const slate = await readSlate(dir);
  expect(slate).toBeDefined();
  expect(slate?.workspaceId).toBe(created.id);
  expect(callCount()).toBe(1);
  expect(history.some((m) => m.role === "user" && m.content === "implement the thing")).toBe(true);
});

test("review finding: /goal text that happens to contain a close-phrase substring does not undo the open+bind it just did", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };

  const owner = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: STRICT_GUARD,
  });
  const created = await owner.create({
    request: undefined,
    requestCorrelationId: "goal-command-close-phrase-fixture-0001",
    id: "workspace-goal-close-fixture",
    title: "Goal Close-Phrase Fixture",
  });

  const { provider, callCount } = textOnlyProvider("Documentation refreshed.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];

  // "wrap up" is a CLOSE_PHRASES entry (slate-lifecycle.ts) — before the
  // fix, runAgentTurnCore's own isClosePhrase(userLine) check archived the
  // slate /goal had just opened and bound, moments after runGoalCommand's
  // own explicit open+bind above returned.
  await runGoalCommand({
    raw: `wrap up documentation --workspace ${created.id}`,
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // Not archived: the slate /goal opened is still the live one, still bound.
  expect(slateSession.opened).toBe(true);
  const slate = await readSlate(dir);
  expect(slate).toBeDefined();
  expect(slate?.workspaceId).toBe(created.id);
  // The turn still ran.
  expect(callCount()).toBe(1);
});

test("a /goal with no slateSession (sessions disabled) still validates --workspace fail-closed and never opens a slate", async () => {
  const cwd = await tempCwd();
  const { provider, callCount } = throwingProvider();
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runGoalCommand({
    raw: "do the thing --workspace bogus-not-a-real-workspace",
    cwd,
    io,
    deps,
    history,
    slateSession: undefined,
    mintAttemptId: () => "attempt-0",
  });

  expect(system.some((line) => line.includes("bogus-not-a-real-workspace"))).toBe(true);
  expect(callCount()).toBe(0);
  expect(history.length).toBe(0);
});

// --- Review finding 2: /goal must trigger the SLATE-2a Anchors auto-inject ---
//
// `runGoalCommand` calls `ensureSlateOpened` itself (bypassing
// `isActionRequest`'s heuristic by design), so `runAgentTurnCore`'s own
// `!wasOpened && ref.opened` fresh-open detection never fires for a
// `/goal`-started turn (the flag is already `true` by the time it checks).
// This mirrors `agent.test.ts`'s own "ensureSlateOpened's fresh open injects
// exactly ONE Anchors-block message" test (SLATE-2a), applied to `/goal`'s
// own open trigger instead of the heuristic one.

test("review finding 2 (AC4): runGoalCommand injects exactly one Anchors-block message reflecting the freshly-opened slate", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("On it.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runGoalCommand({
    raw: "implement the thing",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  expect(slateSession.opened).toBe(true);
  const anchors = (await readSlate(dir))?.anchors;
  expect(anchors).toBeDefined();
  const anchorsMsgs = history.filter(
    (m) => m.role === "user" && m.provenance === "project" && m.content !== "implement the thing",
  );
  expect(anchorsMsgs.length).toBe(1);
  expect(anchorsMsgs[0]?.content).toContain(anchors!.root);
  expect(callCount()).toBe(1);
});

// --- Review finding 3: no try/catch around ensureSlateOpened/writeSlate ----
//
// A corrupted `slate.json` (JSON.parse SyntaxError) or an EACCES must never
// crash/reject `runGoalCommand` — mirrors `agent.test.ts`'s own corrupted-
// slate.json resilience test for `runAgentTurn`'s open/close triggers.
// Chosen degrade-gracefully behavior (documented at the call site too): skip
// slate lifecycle bookkeeping for this attempt entirely and let the goal's
// actual turn still run, since a lost Anchors injection/workspace bind is
// recoverable but crashing mid-`/goal` is not.

test("review finding 3: runGoalCommand resolves (not rejects) when slate.json at the session dir is corrupted, and the turn still runs", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  await writeFile(path.join(dir, "slate.json"), "{ not valid json", "utf8");
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("On it.");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();
  const history: NormalizedMessage[] = [];

  await expect(
    runGoalCommand({
      raw: "implement the thing",
      cwd,
      io,
      deps,
      history,
      slateSession,
      mintAttemptId: () => "attempt-0",
    }),
  ).resolves.toBeUndefined();

  expect(system.some((line) => line.includes("slate bookkeeping failed"))).toBe(true);
  // The goal's actual turn still ran despite the slate bookkeeping failure.
  expect(callCount()).toBe(1);
  expect(history.some((m) => m.role === "user" && m.content === "implement the thing")).toBe(true);
});
