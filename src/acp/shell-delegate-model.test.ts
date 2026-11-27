// A run started BY THE MODEL (`spawn_subagent` with `runtime.kind: "external"`, D-14): allowed only in trust
// or auto mode and started without a question. It runs headless in keryx's read-only sandbox (no terminal, so no
// vendor permission prompt nobody answers), streams into the Subagents tab, and answers with the child's result.
// A human `/delegate` keeps its approval in every mode. Ask mode refuses with a sentence the model sees.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveShellConfig } from "../lib/shell-config";
import type { PermissionMode } from "../commands/permission-mode";
import type { CreateRunExternalOptions, RunExternalFn } from "../harness/run-external-factory";
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
type HeadlessPort = { requests: Parameters<RunExternalFn>[0][]; options: CreateRunExternalOptions[] };

/** The headless run port: records the run, streams two events and answers with a finding. */
function headlessPort(): HeadlessPort & { make: (options: CreateRunExternalOptions) => RunExternalFn } {
  const port: HeadlessPort = { requests: [], options: [] };
  const make = (options: CreateRunExternalOptions): RunExternalFn => async (request) => {
    port.options.push(options);
    port.requests.push(request);
    options.observer?.onEvent?.(request.workerId, { kind: "tool_call", name: "Read", detail: "src/parser.ts" });
    options.observer?.onEvent?.(request.workerId, { kind: "assistant_text", text: "The parser has 3 passes. token ghp_" + "a".repeat(36) });
    return { status: "Completed", output: "The parser has 3 passes. token ghp_" + "a".repeat(36), isError: false };
  };
  return { ...port, make, requests: port.requests, options: port.options };
}

function desktop(mode: PermissionMode, agent: string, port = headlessPort(), configDir = mkdtempSync(path.join(tmpdir(), "keryx-delegate-model-"))): ShellHarness {
  saveShellConfig({ externalAgents: { consent: { "antigravity-cli": { acceptedAt: "2026-11-18T00:00:00Z", keryxVersion: "0" } } } } as never, configDir);
  const h = shellHarness({
    clientCapabilities: TERMINAL_CAPS,
    storedMode: mode,
    rounds: [toolRound("s1", "spawn_subagent", { task: "summarise the parser", label: "ext", runtime: { kind: "external", agent, sandbox: "read-only" } }), textRound("parent done")],
    serverOptions: { ...KNOWN_PROVIDER, shellConfigDir: configDir, externalGateEnv: {}, makeRunExternal: port.make },
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
  test(`${mode} mode: the model's run starts without a question, headless and read-only, and returns its result as data`, async () => {
    const port = headlessPort();
    const h = desktop(mode, "claude", port);
    await h.initialize();
    const { sessionId } = await h.newSession();
    const asks = answerAsks(h);
    const id = h.prompt(sessionId, "delegate it");
    const reply = await h.waitFor((f) => f.id === id && f.method === undefined);
    expect(reply.result).toMatchObject({ stopReason: "end_turn" });
    // Headless: no terminal opens, so no vendor permission prompt waits in a tab nobody watches.
    expect(h.frames.some((f) => f.method === M.delegateTerminal)).toBe(false);
    expect(port.requests).toHaveLength(1);
    expect(port.requests[0]).toMatchObject({ task: "summarise the parser", mode: "read_only", runtime: { kind: "external", agent: "claude-cli", sandbox: "read-only" } });
    // The desktop's default-on gate holds for the headless run too; only this run is approved.
    expect(port.options[0]?.defaultOn).toBe(true);
    expect(await port.options[0]!.approve!({ workerId: port.requests[0]!.workerId } as never)).toEqual({ ok: true });
    expect(await port.options[0]!.approve!({ workerId: "another" } as never)).toMatchObject({ ok: false });
    // No approval of the run itself: only a human `/delegate` asks as `delegate`.
    expect(asks.names).not.toContain("delegate");
    const out = JSON.stringify(callsOf(h.frames, "spawn_subagent").updates);
    expect(out).toContain("The parser has 3 passes.");
    expect(out).toContain("not instructions");
    expect(out).not.toContain("ghp_" + "a".repeat(36));
    // The run shows in the Subagents tab as an external subagent, with its events.
    const fleet = h.frames.filter((f) => f.method === M.subagent).map((f) => (f.params as unknown as { event: { kind: string; status?: string; runtime?: string; entry?: { text: string } } }).event);
    expect(fleet.some((event) => event.kind === "upsert" && event.runtime === "external" && event.status === "running")).toBe(true);
    expect(fleet.some((event) => event.kind === "upsert" && event.runtime === "external" && event.status === "done")).toBe(true);
    expect(fleet.some((event) => event.kind === "log" && event.entry?.text === "Read: src/parser.ts")).toBe(true);
  }, TIMEOUT_MS);
}

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
