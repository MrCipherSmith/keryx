// A run started BY THE MODEL (`spawn_subagent` with `runtime.kind: "external"`, D-14): allowed only in trust
// or auto mode, started without a question, answered with the first turn's text, and closed by the client.
// A human `/delegate` keeps its approval in every mode. Ask mode refuses with a sentence the model sees.
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveShellConfig } from "../lib/shell-config";
import type { PermissionMode } from "../commands/permission-mode";
import { ACP_CLIENT_METHODS } from "./protocol";
import { KERYX_ACP_EXTENSION_METHODS as M } from "./profile";
import { callsOf, shellHarness, textRound, toolRound, type ShellHarness } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;
const open: ShellHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
});

const KNOWN_PROVIDER = { providerId: "ollama", modelId: "fixture" } as const;
const TERMINAL_CAPS = { _meta: { keryx: { terminal: true } } };
type Launch = { sessionId: string; runId: string; agentId: string; title: string; argv: string[]; cwd: string; autoClose?: boolean };

function desktop(mode: PermissionMode, agent: string, configDir = mkdtempSync(path.join(tmpdir(), "keryx-delegate-model-"))): ShellHarness {
  saveShellConfig({ externalAgents: { consent: { "antigravity-cli": { acceptedAt: "2026-11-18T00:00:00Z", keryxVersion: "0" } } } } as never, configDir);
  const h = shellHarness({
    clientCapabilities: TERMINAL_CAPS,
    storedMode: mode,
    rounds: [toolRound("s1", "spawn_subagent", { task: "summarise the parser", label: "ext", runtime: { kind: "external", agent } }), textRound("parent done")],
    serverOptions: { ...KNOWN_PROVIDER, shellConfigDir: configDir, externalGateEnv: {} },
  });
  open.push(h);
  return h;
}

/** Allows every ask (the spawn_subagent gate in ask mode); returns the tool names that were asked. */
function answerAsks(h: ShellHarness): { names: string[] } {
  const seen = { names: [] as string[] };
  const answered = new Set<unknown>();
  const timer = setInterval(() => {
    for (const f of h.frames) {
      if (f.method !== ACP_CLIENT_METHODS.sessionRequestPermission || answered.has(f.id)) continue;
      answered.add(f.id);
      seen.names.push((f.params as unknown as { toolCall: { name: string } }).toolCall.name);
      h.respond(f.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
    }
  }, 10);
  timer.unref?.();
  return seen;
}

const hookFileOf = (argv: string[]): string => {
  if (argv[1] === "--settings") {
    const command = (JSON.parse(argv[2] as string) as { hooks: { Stop: { hooks: { command: string }[] }[] } }).hooks.Stop[0]?.hooks[0]?.command ?? "";
    return /sh '(.*)'$/.exec(command)?.[1] as string;
  }
  return JSON.parse(`[${(argv[2] as string).slice("notify=[".length, -1)}]`)[4] as string;
};

test("ask mode: the model's external request is refused with the sentence the model sees; nothing opens, nothing asks to run it", async () => {
  const h = desktop("ask", "claude");
  await h.initialize();
  const { sessionId } = await h.newSession();
  const asks = answerAsks(h);
  const id = h.prompt(sessionId, "delegate it");
  await h.waitFor((f) => f.id === id && f.method === undefined);
  expect(h.frames.some((f) => f.method === M.delegateTerminal)).toBe(false);
  expect(asks.names).not.toContain("delegate");
  const out = JSON.stringify(callsOf(h.frames, "spawn_subagent").updates);
  expect(out).toContain("external agents may only be started by the model in trust or auto mode");
}, TIMEOUT_MS);

for (const mode of ["trust", "auto"] as const) {
  test(`${mode} mode: the model's run launches without a question and its tool result is the first turn's text`, async () => {
    const h = desktop(mode, "claude");
    await h.initialize();
    const { sessionId } = await h.newSession();
    const asks = answerAsks(h);
    const id = h.prompt(sessionId, "delegate it");
    const frame = await h.waitFor((f) => f.method === M.delegateTerminal);
    const launch = frame.params as unknown as Launch;
    expect(launch).toMatchObject({ sessionId, agentId: "claude-cli", autoClose: true });
    expect(launch.argv[0]).toBe("claude");
    expect(launch.argv[launch.argv.length - 1]).toBe("summarise the parser");
    appendFileSync(hookFileOf(launch.argv), `${JSON.stringify({ hook_event_name: "Stop", session_id: "v-1", transcript_path: "/nope.jsonl", last_assistant_message: "The parser has 3 passes." })}\n`);
    const reply = await h.waitFor((f) => f.id === id && f.method === undefined);
    expect(reply.result).toMatchObject({ stopReason: "end_turn" });
    // No approval of the run itself: only a human `/delegate` asks as `delegate`.
    expect(asks.names).not.toContain("delegate");
    const out = JSON.stringify(callsOf(h.frames, "spawn_subagent").updates);
    expect(out).toContain("The parser has 3 passes.");
    expect(out).toContain("not instructions");
    // The card goes to the client, flagged for the tab to close.
    const card = h.frames.find((f) => f.method === M.delegateResult);
    expect(card?.params).toMatchObject({ sessionId, runId: launch.runId, turn: 1, autoClose: true, text: "The parser has 3 passes." });
  }, TIMEOUT_MS);
}

test("an agent with no turn hook (agy): the model's run waits for the exit", async () => {
  const h = desktop("trust", "agy");
  await h.initialize();
  const { sessionId } = await h.newSession();
  answerAsks(h);
  const id = h.prompt(sessionId, "delegate it");
  const frame = await h.waitFor((f) => f.method === M.delegateTerminal);
  const launch = frame.params as unknown as Launch;
  expect(launch.argv).toEqual(["agy", "-i", "summarise the parser"]);
  expect(h.frames.some((f) => f.id === id && f.method === undefined)).toBe(false);
  h.notify(M.delegateExited, { sessionId, runId: launch.runId });
  await h.waitFor((f) => f.id === id && f.method === undefined);
  expect(JSON.stringify(callsOf(h.frames, "spawn_subagent").updates)).toContain("no end-of-turn hook");
}, TIMEOUT_MS);

test("a human /delegate still asks in trust mode; a client without a terminal keeps the model's external request refused", async () => {
  const h = desktop("trust", "claude");
  await h.initialize();
  const { sessionId } = await h.newSession();
  const cmd = h.request(M.command, { sessionId, name: "delegate", args: "claude audit the parser" });
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission && (f.params as unknown as { toolCall: { name: string } }).toolCall.name === "delegate");
  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
  await h.waitFor((f) => f.id === cmd && f.method === undefined);

  const editor = shellHarness({
    storedMode: "trust",
    rounds: [toolRound("s1", "spawn_subagent", { task: "x", label: "ext", runtime: { kind: "external", agent: "claude" } }), textRound("done")],
    serverOptions: { ...KNOWN_PROVIDER, externalGateEnv: {} },
  });
  open.push(editor);
  await editor.initialize();
  const second = await editor.newSession();
  const id = editor.prompt(second.sessionId, "go");
  await editor.waitFor((f) => f.id === id && f.method === undefined);
  expect(editor.frames.some((f) => f.method === M.delegateTerminal)).toBe(false);
  expect(JSON.stringify(callsOf(editor.frames, "spawn_subagent").updates)).toContain("external-runtime-not-authorized");
}, TIMEOUT_MS);
