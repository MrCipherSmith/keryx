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
// SLATE-27 (flow 186, T6) extends ParsedGoalArgs with an optional
// `auto?: { rounds?: number }`, parsed from a trailing `--auto [N]`,
// composable with `--workspace` in either tail order. Parsing only — the
// continuation loop it will drive is later work in the same flow. See
// parseGoalArgs's own doc comment for why a non-integer `--auto` value is
// deliberately NOT a parse error (unlike a dangling `--workspace`).
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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentDeps, AgentIO } from "./agent";
// RED: `./goal-command` does not exist yet (T11 creates it).
import { DEFAULT_AUTO_GOAL_ROUNDS, parseGoalArgs, parseVerifierVerdict, runGoalCommand } from "./goal-command";
import type { GoalArgsError, GoalVerifierVerdict, ParsedGoalArgs } from "./goal-command";
import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
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

// --- parseGoalArgs: --auto (SLATE-27, flow 186, T6) -------------------------

test("parseGoalArgs: bare trailing --auto enables continuation with no explicit round-cap override", () => {
  const parsed = parseGoalArgs("do the thing --auto");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("do the thing");
    expect(parsed.auto).toEqual({});
  }
});

test("parseGoalArgs: --auto <N> with a valid positive integer sets the round-cap override", () => {
  const parsed = parseGoalArgs("do the thing --auto 5");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("do the thing");
    expect(parsed.auto).toEqual({ rounds: 5 });
  }
});

test("parseGoalArgs: --workspace <id> --auto <N> composes in this order", () => {
  const parsed = parseGoalArgs("do the thing --workspace w1 --auto 5");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("do the thing");
    expect(parsed.workspaceId).toBe("w1");
    expect(parsed.auto).toEqual({ rounds: 5 });
  }
});

test("parseGoalArgs: --auto <N> --workspace <id> composes in the REVERSE order too", () => {
  const parsed = parseGoalArgs("do the thing --auto 5 --workspace w1");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("do the thing");
    expect(parsed.workspaceId).toBe("w1");
    expect(parsed.auto).toEqual({ rounds: 5 });
  }
});

test("parseGoalArgs: bare --auto composes with --workspace in either order", () => {
  const workspaceThenAuto = parseGoalArgs("do the thing --workspace w1 --auto");
  expect(isError(workspaceThenAuto)).toBe(false);
  if (!isError(workspaceThenAuto)) {
    expect(workspaceThenAuto.text).toBe("do the thing");
    expect(workspaceThenAuto.workspaceId).toBe("w1");
    expect(workspaceThenAuto.auto).toEqual({});
  }

  const autoThenWorkspace = parseGoalArgs("do the thing --auto --workspace w1");
  expect(isError(autoThenWorkspace)).toBe(false);
  if (!isError(autoThenWorkspace)) {
    expect(autoThenWorkspace.text).toBe("do the thing");
    expect(autoThenWorkspace.workspaceId).toBe("w1");
    expect(autoThenWorkspace.auto).toEqual({});
  }
});

// AC1 (revised during T6): unlike --workspace, --auto's value is OPTIONAL, so
// there is no structurally-unambiguous "dangling flag" shape to hang a hard
// parse error on. "--auto <non-integer>" must NOT error — that would
// reintroduce review finding 5's exact corruption class for --auto instead
// of --workspace. It is simply not recognized as a flag at that position;
// the whole tail, "--auto" included, stays ordinary goal text.
test("parseGoalArgs: --auto followed by a non-integer word is NOT a parse error — it stays ordinary goal text (mirrors review finding 5, not a dangling-flag case)", () => {
  const parsed = parseGoalArgs("explain how --auto mode differs");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.text).toBe("explain how --auto mode differs");
    expect(parsed.auto).toBeUndefined();
  }
});

test.each(["0", "-5", "5.5", "05", "+5"])(
  "parseGoalArgs: --auto %s is not a valid positive-integer round cap — falls through as text, not an error",
  (value) => {
    const parsed = parseGoalArgs(`do the thing --auto ${value}`);
    expect(isError(parsed)).toBe(false);
    if (!isError(parsed)) {
      expect(parsed.text).toBe(`do the thing --auto ${value}`);
      expect(parsed.auto).toBeUndefined();
    }
  },
);

test("parseGoalArgs: a second, earlier --auto is left embedded in the text — each flag is consumed at most once (mirrors a duplicate --workspace's existing behavior)", () => {
  const parsed = parseGoalArgs("do the thing --auto --auto 5");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    // The rightmost --auto is consumed (rounds: 5); the earlier, now-orphaned
    // --auto is not re-recognized and stays part of the text.
    expect(parsed.text).toBe("do the thing --auto");
    expect(parsed.auto).toEqual({ rounds: 5 });
  }
});

test("parseGoalArgs: --auto alone with no goal text is an error (text required), same as --workspace alone", () => {
  expect(isError(parseGoalArgs("--auto"))).toBe(true);
  expect(isError(parseGoalArgs("--auto 5"))).toBe(true);
});

test("parseGoalArgs: no --auto given leaves parsed.auto undefined (backward compatible with pre-SLATE-27 callers)", () => {
  const parsed = parseGoalArgs("do the thing --workspace w1");
  expect(isError(parsed)).toBe(false);
  if (!isError(parsed)) {
    expect(parsed.auto).toBeUndefined();
  }
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

// --- AC2: --auto auto-provisions a Task Manager flow (SLATE-27, flow 186, T7) ---

async function listFlowDirs(cwd: string): Promise<string[]> {
  try {
    return await readdir(path.join(cwd, ".metaproject", "flows"));
  } catch {
    return [];
  }
}

async function readFlowJson(cwd: string, dir: string): Promise<{ id: string; title: string; status: string }> {
  const raw = await readFile(path.join(cwd, ".metaproject", "flows", dir, "flow.json"), "utf8");
  return JSON.parse(raw) as { id: string; title: string; status: string };
}

test("AC2: /goal <text> --auto with no course.flowRef bound provisions a new Task Manager flow, freezes it, starts it, and binds slate.course.flowRef — before the turn runs", async () => {
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
    raw: "implement the login flow --auto",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  const slate = await readSlate(dir);
  expect(slate?.course.flowRef).toBeDefined();
  const flowId = slate?.course.flowRef as string;

  const dirs = await listFlowDirs(cwd);
  expect(dirs).toHaveLength(1);
  const flow = await readFlowJson(cwd, dirs[0] as string);
  expect(flow.id).toBe(flowId);
  expect(flow.title).toBe("implement the login flow");
  // freeze() + start() both ran — a flow that only got init() would still be "initializing".
  expect(flow.status).toBe("in-progress");

  const ac = await readFile(path.join(cwd, ".metaproject", "flows", dirs[0] as string, "acceptance-criteria.md"), "utf8");
  expect(ac).toContain('The stated goal — "implement the login flow" — is achieved');
  expect(ac).not.toContain("<replace with a hard, verifiable criterion");

  // The first turn ran with the parsed text (--auto stripped). The
  // provisioned flow's default 4-task scaffold never reaches "done" against
  // this fake provider, so T9's continuation loop runs to its full default
  // cap (DEFAULT_AUTO_GOAL_ROUNDS additional rounds) — round-cap enforcement
  // itself is covered by its own dedicated AC5 test below.
  expect(callCount()).toBe(DEFAULT_AUTO_GOAL_ROUNDS + 1);
  expect(history.some((m) => m.role === "user" && m.content === "implement the login flow")).toBe(true);
});

test("AC2: a course already bound to a flowRef is never re-provisioned by a second --auto", async () => {
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

  // First --auto call provisions a flow.
  await runGoalCommand({
    raw: "implement the login flow --auto",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });
  const firstFlowId = (await readSlate(dir))?.course.flowRef;
  expect(firstFlowId).toBeDefined();
  expect(await listFlowDirs(cwd)).toHaveLength(1);

  // A second --auto call on the SAME (already-bound) slate must not touch
  // the Task Manager again — mirrors SLATE-16 (AC-25)'s own "already bound,
  // never re-resolved" rule for workspaceId.
  await runGoalCommand({
    raw: "a completely different goal --auto",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-1",
  });

  expect((await readSlate(dir))?.course.flowRef).toBe(firstFlowId);
  expect(await listFlowDirs(cwd)).toHaveLength(1);
});

test("AC2: /goal without --auto never touches the Task Manager — no .metaproject/flows directory appears", async () => {
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

  await runGoalCommand({
    raw: "implement the login flow",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  expect((await readSlate(dir))?.course.flowRef).toBeUndefined();
  expect(await listFlowDirs(cwd)).toHaveLength(0);
});

// --- T9: the continuation loop (SLATE-27, flow 186) -------------------------

async function writeFlowStatus(cwd: string, dir: string, status: string): Promise<void> {
  const file = path.join(cwd, ".metaproject", "flows", dir, "flow.json");
  const flow = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  flow.status = status;
  await writeFile(file, `${JSON.stringify(flow, null, 2)}\n`, "utf8");
}

test("AC5: the loop stops at exactly the round cap when the bound flow never reaches done", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
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
    raw: "implement the login flow --auto 2",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // The scaffolded flow's default tasks never reach "done" — 1 first turn +
  // exactly the 2 rounds `--auto 2` asked for, never more.
  expect(callCount()).toBe(3);
  expect(slateSession.opened).toBe(true); // never closed — the course never finished
});

test("AC1/AC5: an explicit --auto <N> overrides the default round cap", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 1",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  expect(callCount()).toBe(2); // 1 first turn + the single overridden round
  // Review finding BOSS-001: the arm is consumed (cleared) once the loop
  // reads it, not left set after the call — otherwise it would silently
  // hijack the NEXT /goal call on this same, per-session slateSession.
  expect(slateSession.autoGoalRounds).toBeUndefined();
});

test("AC3: the loop stops as soon as the bound flow's status flips to done — observing slateSession.opened, not a second isCourseDone call", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
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
  const provider: AgentDeps["provider"] = {
    describe: () => description,
    stream: (_request, opts) => {
      calls += 1;
      const thisCall = calls;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        // Before the SECOND call's own response streams back, simulate a
        // concurrent process (e.g. `keryx flow complete`) finishing the
        // bound flow. That second call's OWN runAgentTurn/
        // closeSlateOnFlowDone check (running in ITS finally, right after
        // this generator completes) is what observes it — not a second
        // detector this loop invents. The loop must stop right after round
        // 2, never reaching round 3.
        if (thisCall === 2) {
          const slate = await readSlate(dir);
          const flowId = slate?.course.flowRef;
          if (flowId !== undefined) {
            const dirs = await listFlowDirs(cwd);
            const flowDir = dirs.find((d) => d.startsWith(`${flowId}-`));
            if (flowDir !== undefined) {
              await writeFlowStatus(cwd, flowDir, "done");
            }
          }
        }
        yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "ok" } as NormalizedEvent;
        yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 5",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // Round 1 (first turn) flips the flow to "done" as a side effect. Round 2
  // runs (the loop had already committed to it before the flip), and ITS
  // OWN runAgentTurn/closeSlateOnFlowDone check (not a second detector this
  // loop invents) sees the now-"done" course and closes the slate — so the
  // loop stops after round 2, well short of the --auto 5 cap.
  expect(calls).toBe(2);
  expect(slateSession.opened).toBe(false);
});

test("AC7: a fresh SlateSessionRef (simulating a fork/resume) never inherits an armed --auto loop from another session object", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const sourceSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider: provider1 } = textOnlyProvider("still working");
  const deps1: AgentDeps = {
    provider: provider1,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io: io1 } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 2",
    cwd,
    io: io1,
    deps: deps1,
    history: [],
    slateSession: sourceSession,
    mintAttemptId: () => "attempt-0",
  });
  // Consumed by the loop, not left set after the call (BOSS-001) — see the
  // dedicated same-session-second-call test below for the failure mode this
  // specifically guards against.
  expect(sourceSession.autoGoalRounds).toBeUndefined();

  // A forked/resumed session against the SAME dir gets its OWN, fresh
  // SlateSessionRef — exactly how `keryx sessions fork`/`/resume` construct
  // one (a brand-new object, never a copy of the source's in-memory state).
  const forkedSession: SlateSessionRef = { dir, cwd, opened: false };
  expect(forkedSession.autoGoalRounds).toBeUndefined();

  const { provider: provider2, callCount: callCount2 } = textOnlyProvider("still working");
  const deps2: AgentDeps = {
    provider: provider2,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io: io2 } = collectingIo();

  // Plain /goal, no --auto, on the forked session: must run exactly ONE
  // turn — no silently-inherited continuation loop.
  await runGoalCommand({
    raw: "a different goal entirely",
    cwd,
    io: io2,
    deps: deps2,
    history: [],
    slateSession: forkedSession,
    mintAttemptId: () => "attempt-1",
  });

  expect(callCount2()).toBe(1);
  expect(forkedSession.autoGoalRounds).toBeUndefined();
});

test("BOSS-001: a second /goal call on the SAME session object, without --auto, never inherits the previous call's --auto arm", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  // ONE SlateSessionRef reused across two calls — exactly how shell.ts/
  // tui-shell.ts construct it: once per session, not once per /goal call.
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider: provider1 } = textOnlyProvider("still working");
  const deps1: AgentDeps = {
    provider: provider1,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io: io1 } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 5",
    cwd,
    io: io1,
    deps: deps1,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });
  expect(slateSession.autoGoalRounds).toBeUndefined(); // consumed already

  const { provider: provider2, callCount: callCount2 } = textOnlyProvider("still working");
  const deps2: AgentDeps = {
    provider: provider2,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io: io2, system: system2 } = collectingIo();

  // A plain /goal, no --auto, on the SAME session object right after an
  // --auto run. Before the BOSS-001 fix, the stale armed budget would have
  // silently driven a continuation loop (and a verifier dispatch) for a
  // command that never asked for --auto at all.
  await runGoalCommand({
    raw: "a completely unrelated second goal",
    cwd,
    io: io2,
    deps: deps2,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-1",
  });

  expect(callCount2()).toBe(1);
  expect(system2.some((line) => line.includes("--auto"))).toBe(false);
});

test("BOSS-002: a slate I/O failure during the verifier's reopen degrades — no crash, the extra round is simply skipped", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
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
  const provider: AgentDeps["provider"] = {
    describe: () => description,
    stream: (_request, opts) => {
      calls += 1;
      const thisCall = calls;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        if (thisCall === 1) {
          // Finish the bound flow — this round's OWN runAgentTurn/
          // closeSlateOnFlowDone check (right after this generator
          // completes) closes the slate normally. The session dir itself
          // is corrupted separately, from the fake spawn_subagent tool
          // below — AFTER that close, right before the verifier's reopen
          // attempt — so this first close still succeeds cleanly.
          const slate = await readSlate(dir);
          const flowId = slate?.course.flowRef;
          if (flowId !== undefined) {
            const dirs = await listFlowDirs(cwd);
            const flowDir = dirs.find((d) => d.startsWith(`${flowId}-`));
            if (flowDir !== undefined) {
              await writeFlowStatus(cwd, flowDir, "done");
            }
          }
        }
        yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "ok" } as NormalizedEvent;
        yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const spawnSubagent = fakeSpawnSubagentTool(async () => {
    // Injected right after round 1's own close already succeeded (this
    // fake tool is only ever invoked as the T10 verifier, after the
    // rounds loop has already exited), and right before the reopen it
    // triggers below: replace the session dir itself with a plain FILE —
    // `ensureSlateOpened`/`writeSlate`'s own directory operations then hit
    // ENOTDIR, a real, portable (non-permission-based) I/O failure.
    await rm(dir, { recursive: true, force: true });
    await writeFile(dir, "not a directory", "utf8");
    return { output: '{"achieved": false, "gaps": ["still missing something"]}', isError: false };
  });
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [spawnSubagent],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();

  await expect(
    runGoalCommand({
      raw: "implement the login flow --auto 5",
      cwd,
      io,
      deps,
      history: [],
      slateSession,
      mintAttemptId: () => "attempt-0",
    }),
  ).resolves.toBeUndefined(); // never rejects, even though the reopen below fails

  // Sanity: the course really did close after round 1, the verifier really
  // did reject it, AND the reopen genuinely failed (not a false-positive
  // pass because the reopen quietly succeeded) — the failure message and
  // the gaps message both landed.
  expect(system.some((line) => line.includes("still missing something"))).toBe(true);
  expect(system.some((line) => line.includes("could not reopen the slate"))).toBe(true);
});

test("T9: a continuation round's message names the bound flow's remaining tasks", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider } = textOnlyProvider("still working");
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
    raw: "implement the login flow --auto 1",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  const continuationMessages = history.filter(
    (m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("Continue working toward"),
  );
  expect(continuationMessages).toHaveLength(1);
  const text = continuationMessages[0]?.content as string;
  expect(text).toContain("round 2 of 2");
  expect(text).toContain("T1: Collect remaining context");
});

// --- T10: verifier pass before the final stop (SLATE-27, flow 186, AC4) ----

function fakeSpawnSubagentTool(
  invoke: (input: Record<string, unknown>) => Promise<{ output: string; isError: boolean }>,
): InteractiveTool {
  return {
    definition: { name: "spawn_subagent", description: "verify", inputSchema: {}, risk: "delegate" },
    invoke,
  };
}

test("parseVerifierVerdict: extracts a well-formed JSON verdict, tolerating surrounding prose", () => {
  expect(parseVerifierVerdict('{"achieved": true, "gaps": []}')).toEqual({ achieved: true, gaps: [] });
  expect(
    parseVerifierVerdict('Sure, here it is:\n{"achieved": false, "gaps": ["tests missing", "docs stale"]}\nDone.'),
  ).toEqual({ achieved: false, gaps: ["tests missing", "docs stale"] });
});

test("parseVerifierVerdict: returns undefined for anything unparseable — never throws", () => {
  expect(parseVerifierVerdict("not json at all")).toBeUndefined();
  expect(parseVerifierVerdict("")).toBeUndefined();
  expect(parseVerifierVerdict('{"gaps": ["x"]}')).toBeUndefined(); // missing "achieved"
  expect(parseVerifierVerdict('{"achieved": "yes"}')).toBeUndefined(); // not a boolean
  expect(parseVerifierVerdict("{not: valid json}")).toBeUndefined();
});

test("parseVerifierVerdict: non-string entries in gaps are dropped, not left to corrupt the array", () => {
  const verdict: GoalVerifierVerdict | undefined = parseVerifierVerdict('{"achieved": false, "gaps": ["real", 5, null]}');
  expect(verdict).toEqual({ achieved: false, gaps: ["real"] });
});

test("AC4: a verifier that reports achieved:true adds no extra round and no gaps message", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
  const spawnSubagent = fakeSpawnSubagentTool(async () => ({
    output: '{"achieved": true, "gaps": []}',
    isError: false,
  }));
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [spawnSubagent],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 1",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // 1 first turn + 1 ordinary round (the --auto 1 cap) — the verifier agreed
  // the goal was achieved, so no extra round was added.
  expect(callCount()).toBe(2);
  expect(system.some((line) => line.includes("not fully achieved"))).toBe(false);
});

test("AC4: a verifier that reports achieved:false with round budget already exhausted surfaces gaps and stops anyway", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
  const spawnSubagent = fakeSpawnSubagentTool(async () => ({
    output: '{"achieved": false, "gaps": ["the login form has no validation"]}',
    isError: false,
  }));
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [spawnSubagent],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 1",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // No budget left for a verifier-triggered round (plan step 5: "if budget
  // is exhausted, surface the gaps and stop anyway").
  expect(callCount()).toBe(2);
  expect(system.some((line) => line.includes("the login form has no validation"))).toBe(true);
});

test("AC4: a verifier that reports achieved:false with round budget remaining runs exactly one more round, reopening and rebinding the same flow if it had already closed", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
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
  const provider: AgentDeps["provider"] = {
    describe: () => description,
    stream: (_request, opts) => {
      calls += 1;
      const thisCall = calls;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        // The FIRST turn finishes the bound flow as a side effect — by the
        // time this function reaches the verifier, the course is already
        // closed (slateSession.opened === false) with the FULL --auto 5
        // round budget still untouched.
        if (thisCall === 1) {
          const slate = await readSlate(dir);
          const flowId = slate?.course.flowRef;
          if (flowId !== undefined) {
            const dirs = await listFlowDirs(cwd);
            const flowDir = dirs.find((d) => d.startsWith(`${flowId}-`));
            if (flowDir !== undefined) {
              await writeFlowStatus(cwd, flowDir, "done");
            }
          }
        }
        yield { sequence: 0, attemptId: opts.attemptId, kind: "text_delta", text: "ok" } as NormalizedEvent;
        yield { sequence: 1, attemptId: opts.attemptId, kind: "model_end" } as NormalizedEvent;
      })();
    },
  };
  const spawnSubagent = fakeSpawnSubagentTool(async () => ({
    output: '{"achieved": false, "gaps": ["missed the edge case"]}',
    isError: false,
  }));
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [spawnSubagent],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runGoalCommand({
    raw: "implement the login flow --auto 5",
    cwd,
    io,
    deps,
    history,
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  // The rounds loop never ran (opened was already false when it started),
  // the verifier rejected the outcome, and — with 5 full rounds still in
  // budget — the loop reopened the slate and ran exactly ONE more turn.
  expect(calls).toBe(2);
  expect(system.some((line) => line.includes("missed the edge case"))).toBe(true);

  // Still exactly one flow — the reopen rebinds the SAME flow rather than
  // re-provisioning a new one. (The reopened slate closes again by the end
  // of this test, since the fake provider never resets the flow's "done"
  // status — asserting the LIVE post-run slate would be flaky for that
  // reason; the continuation message built during the extra round, before
  // that second close, is the reliable place to observe the rebind.)
  const dirsAfter = await listFlowDirs(cwd);
  expect(dirsAfter).toHaveLength(1);
  const flowId = (dirsAfter[0] as string).split("-")[0];

  const continuationMessages = history.filter(
    (m) => m.role === "user" && typeof m.content === "string" && (m.content as string).startsWith("Continue working toward"),
  );
  expect(continuationMessages).toHaveLength(1);
  expect(continuationMessages[0]?.content).toContain(`Flow ${flowId} tasks remaining`);
});

test("AC4: an unreachable/erroring verifier degrades silently — no crash, no extra round, no gaps message", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
  const spawnSubagent = fakeSpawnSubagentTool(async () => {
    throw new Error("subagent dispatch failed");
  });
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [spawnSubagent],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();

  await expect(
    runGoalCommand({
      raw: "implement the login flow --auto 1",
      cwd,
      io,
      deps,
      history: [],
      slateSession,
      mintAttemptId: () => "attempt-0",
    }),
  ).resolves.toBeUndefined();

  expect(callCount()).toBe(2);
  expect(system.some((line) => line.includes("not fully achieved"))).toBe(false);
});

test("AC4: a verifier whose output does not parse as a verdict degrades the same way an unreachable one does", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
  const spawnSubagent = fakeSpawnSubagentTool(async () => ({ output: "I looked into it, seems fine.", isError: false }));
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [spawnSubagent],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 1",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  expect(callCount()).toBe(2);
  expect(system.some((line) => line.includes("not fully achieved"))).toBe(false);
});

test("AC4: /goal --auto with no spawn_subagent tool wired in behaves exactly as if the verifier were unreachable", async () => {
  const cwd = await tempCwd();
  const dir = await tempSessionDir();
  const slateSession: SlateSessionRef = { dir, cwd, opened: false };
  const { provider, callCount } = textOnlyProvider("still working");
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [], // no spawn_subagent
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
  const { io, system } = collectingIo();

  await runGoalCommand({
    raw: "implement the login flow --auto 1",
    cwd,
    io,
    deps,
    history: [],
    slateSession,
    mintAttemptId: () => "attempt-0",
  });

  expect(callCount()).toBe(2);
  expect(system.some((line) => line.includes("not fully achieved"))).toBe(false);
});
