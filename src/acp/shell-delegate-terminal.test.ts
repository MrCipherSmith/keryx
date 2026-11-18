// `/delegate` when the client runs terminals (the desktop; D-14): after approval keryx answers the
// `openTerminal` effect with the registry's interactive argv instead of spawning a headless run, and
// the external runtime is on unless the user config says `false`. Without the capability the
// headless path of `shell-goal-delegate.test.ts` is unchanged.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveShellConfig } from "../lib/shell-config";
import type { CreateRunExternalOptions, RunExternalFn } from "../harness/run-external-factory";
import { ACP_CLIENT_METHODS } from "./protocol";
import { KERYX_ACP_EXTENSION_METHODS as M } from "./profile";
import { shellHarness, type ShellHarness } from "./shell-profile.test-helpers";

const TIMEOUT_MS = 30_000;
const open: ShellHarness[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.end();
});

type Terminal = { runId: string; agentId: string; title: string; argv: string[]; cwd: string };
type Meta = { effects?: string[]; refused?: boolean; terminal?: Terminal };

const TERMINAL_CAPS = { _meta: { keryx: { terminal: true } } };

function desktop(configDir: string, headless?: { calls: number }): ShellHarness {
  const makeRunExternal = (_options: CreateRunExternalOptions): RunExternalFn => async () => {
    if (headless !== undefined) headless.calls += 1;
    return { status: "Completed", output: "headless", isError: false };
  };
  const h = shellHarness({
    clientCapabilities: TERMINAL_CAPS,
    serverOptions: { shellConfigDir: configDir, externalGateEnv: {}, makeRunExternal },
  });
  open.push(h);
  return h;
}

const freshConfigDir = (): string => mkdtempSync(path.join(tmpdir(), "keryx-delegate-terminal-"));

async function delegate(h: ShellHarness, sessionId: string, args: string, decide?: "allow_once" | "reject_once"): Promise<{ text: string; meta: Meta }> {
  const id = h.request(M.command, { sessionId, name: "delegate", args });
  if (decide !== undefined) {
    const answered = h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission).length;
    const ask = await h.waitFor(
      (f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission && h.frames.filter((g) => g.method === ACP_CLIENT_METHODS.sessionRequestPermission).indexOf(f) >= answered,
    );
    h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: decide } } });
  }
  const reply = await h.waitFor((f) => f.id === id && f.method === undefined);
  const result = reply.result as { text: string; _meta?: { keryx?: Meta } };
  return { text: result.text, meta: result._meta?.keryx ?? {} };
}

test("approved: answers openTerminal with the registry argv, the task as ONE element, and runs nothing headless", async () => {
  const headless = { calls: 0 };
  const h = desktop(freshConfigDir(), headless);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const task = 'fix "the" flaky $(test) && rm -rf / ; --help';
  const id = h.request(M.command, { sessionId, name: "delegate", args: `claude ${task}` });
  const ask = await h.waitFor((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission);
  const params = ask.params as unknown as { toolCall: { title: string; kind: string; rawInput: { interactive: boolean } }; options: { kind: string }[] };
  expect(params.toolCall.kind).toBe("execute");
  expect(params.toolCall.title).toContain("interactively in the terminal");
  expect(params.toolCall.title).toContain("keryx's sandbox does not apply");
  expect(params.toolCall.rawInput.interactive).toBe(true);
  expect(params.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  h.respond(ask.id, { result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  const reply = await h.waitFor((f) => f.id === id && f.method === undefined);
  const meta = (reply.result as { _meta: { keryx: Meta } })._meta.keryx;
  expect(meta.refused).toBeUndefined();
  expect(meta.effects).toEqual(["openTerminal"]);
  expect(meta.terminal?.agentId).toBe("claude-cli");
  expect(meta.terminal?.argv).toEqual(["claude", "--", task]);
  expect(meta.terminal?.cwd).toBe(h.projectDir);
  expect(meta.terminal?.runId.startsWith("ext:")).toBe(true);
  expect(meta.terminal?.title.startsWith("Claude · fix")).toBe(true);
  expect(headless.calls).toBe(0);
  expect(h.frames.some((f) => f.method === M.subagent)).toBe(false);
}, TIMEOUT_MS);

test("each agent gets its own interactive argv; codex and agy follow the registry", async () => {
  const dir = freshConfigDir();
  // agy needs the one-time vendor consent: record it so the gate lets it through.
  saveShellConfig({ externalAgents: { consent: { "antigravity-cli": { acceptedAt: "2026-11-18T00:00:00Z", keryxVersion: "0" } } } } as never, dir);
  const h = desktop(dir);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const codex = await delegate(h, sessionId, "codex list todos", "allow_once");
  expect(codex.meta.terminal?.argv).toEqual(["codex", "--", "list todos"]);
  const agy = await delegate(h, sessionId, "agy list todos", "allow_once");
  expect(agy.meta.terminal?.argv).toEqual(["agy", "-i", "list todos"]);
}, TIMEOUT_MS);

test("rejected is refused and opens nothing; an agent with no interactive form is refused without asking", async () => {
  const h = desktop(freshConfigDir());
  await h.initialize();
  const { sessionId } = await h.newSession();
  const rejected = await delegate(h, sessionId, "claude audit the parser", "reject_once");
  expect(rejected.meta.refused).toBe(true);
  expect(rejected.meta.effects).toBeUndefined();
  expect(rejected.meta.terminal).toBeUndefined();
  const asksBefore = h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission).length;
  const noForm = await delegate(h, sessionId, "gemini-acp audit the parser");
  expect(noForm.meta.refused).toBe(true);
  expect(noForm.text).toContain("no interactive form");
  expect(h.frames.filter((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission).length).toBe(asksBefore);
}, TIMEOUT_MS);

test("default-on: an unset externalAgents.enabled is allowed; an explicit false is refused with the gate's sentence, before any approval", async () => {
  const on = desktop(freshConfigDir());
  await on.initialize();
  const first = await on.newSession();
  expect((await delegate(on, first.sessionId, "claude audit", "allow_once")).meta.effects).toEqual(["openTerminal"]);

  const dir = freshConfigDir();
  saveShellConfig({ externalAgents: { enabled: false } } as never, dir);
  const off = desktop(dir);
  await off.initialize();
  const second = await off.newSession();
  const refused = await delegate(off, second.sessionId, "claude audit");
  expect(refused.meta.refused).toBe(true);
  expect(refused.text).toContain("the external agent runtime is disabled");
  expect(off.frames.some((f) => f.method === ACP_CLIENT_METHODS.sessionRequestPermission)).toBe(false);
}, TIMEOUT_MS);

test("the vendor consent gate still refuses an agent that needs it, with its sentence", async () => {
  const h = desktop(freshConfigDir());
  await h.initialize();
  const { sessionId } = await h.newSession();
  const reply = await delegate(h, sessionId, "agy audit");
  expect(reply.meta.refused).toBe(true);
  expect(reply.text).toContain("consent-required");
}, TIMEOUT_MS);

test("without the terminal capability (an editor) the headless path is unchanged", async () => {
  const headless = { calls: 0 };
  const makeRunExternal = (_o: CreateRunExternalOptions): RunExternalFn => async () => {
    headless.calls += 1;
    return { status: "Completed", output: "headless done", isError: false };
  };
  const h = shellHarness({ serverOptions: { makeRunExternal } });
  open.push(h);
  await h.initialize();
  const { sessionId } = await h.newSession();
  const reply = await delegate(h, sessionId, "claude audit the parser", "allow_once");
  expect(headless.calls).toBe(1);
  expect(reply.text).toContain("Completed: headless done");
  expect(reply.meta.effects ?? []).toEqual([]);
  expect(reply.meta.terminal).toBeUndefined();
}, TIMEOUT_MS);
