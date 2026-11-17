// Shared by `shell-profile.test.ts` and `shell-profile-modes.test.ts`: an
// in-process `keryx acp --profile shell` connection driven by a scripted
// provider, plus the few frame readers both files need.

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PermissionMode } from "../commands/permission-mode";
import { loadAcpFixtureProvider, type AcpFixtureEvent } from "./fixture-provider";
import { ACP_AGENT_METHODS, ACP_CLIENT_METHODS, ACP_PROTOCOL_VERSION } from "./protocol";
import type { AcpServerOptions } from "./server";
import { harness, type Frame } from "./server-harness.test-helpers";

export type Round = readonly AcpFixtureEvent[];

export function toolRound(id: string, toolName: string, input: unknown, usage?: { inputTokens: number; outputTokens: number }): Round {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName },
    { kind: "tool_call_end", toolCallId: id, input: JSON.stringify(input) },
    ...(usage !== undefined ? [{ kind: "usage_update" as const, usage }] : []),
    { kind: "model_end" },
  ];
}

export function textRound(text: string, usage?: { inputTokens: number; outputTokens: number }): Round {
  return [
    { kind: "text_delta", text },
    ...(usage !== undefined ? [{ kind: "usage_update" as const, usage }] : []),
    { kind: "model_end" },
  ];
}

export interface ShellHarnessOptions {
  readonly rounds?: readonly Round[];
  readonly profile?: "editor" | "shell";
  readonly storedMode?: PermissionMode;
  readonly clientCapabilities?: Record<string, unknown>;
  /** Extra `runAcpServer` options (seams), applied over the defaults above. */
  readonly serverOptions?: Partial<AcpServerOptions>;
}

export type ShellHarness = ReturnType<typeof harness> & {
  readonly initialize: () => Promise<Frame>;
  readonly newSession: () => Promise<{ sessionId: string; result: Record<string, unknown> }>;
  /** Sends a prompt and returns its id; the caller answers asks and waits for the reply. */
  readonly prompt: (sessionId: string, text: string) => number;
};

/** An in-process connection in the `shell` profile (or `editor`, for contrast), with no keryx MCP config. */
export function shellHarness(options: ShellHarnessOptions = {}): ShellHarness {
  const fixtureFile = path.join(tmpdir(), `keryx-acp-shell-fixture-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(fixtureFile, JSON.stringify({ turns: options.rounds ?? [] }), "utf8");
  const h = harness({
    provider: loadAcpFixtureProvider(fixtureFile),
    profile: options.profile ?? "shell",
    permissionModeDefault: () => options.storedMode,
    keryxMcp: () => undefined,
    ...options.serverOptions,
  });
  const initialize = async (): Promise<Frame> => {
    const id = h.request(ACP_AGENT_METHODS.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: options.clientCapabilities ?? {},
    });
    return h.waitFor((f) => f.id === id);
  };
  const newSession = async (): Promise<{ sessionId: string; result: Record<string, unknown> }> => {
    const id = h.request(ACP_AGENT_METHODS.sessionNew, { cwd: h.projectDir, mcpServers: [] });
    const reply = await h.waitFor((f) => f.id === id);
    if (reply.result === undefined) throw new Error(`session/new failed: ${JSON.stringify(reply.error)}`);
    return { sessionId: reply.result["sessionId"] as string, result: reply.result };
  };
  const prompt = (sessionId: string, text: string): number =>
    h.request(ACP_AGENT_METHODS.sessionPrompt, { sessionId, prompt: [{ type: "text", text }] });
  return { ...h, initialize, newSession, prompt };
}

export type Update = {
  sessionUpdate?: string;
  toolCallId?: string;
  name?: string;
  status?: string;
  rawOutput?: unknown;
  content?: { text?: string };
  _meta?: { keryx?: Record<string, unknown> };
  [key: string]: unknown;
};

export const updateOf = (frame: Frame): Update => ((frame.params as { update?: Update } | undefined)?.update ?? {}) as Update;

export const isUpdate = (kind: string) => (frame: Frame): boolean =>
  frame.method === ACP_CLIENT_METHODS.sessionUpdate && updateOf(frame).sessionUpdate === kind;

/** Every `session/update` of one kind seen so far. */
export function updates(frames: readonly Frame[], kind: string): Update[] {
  return frames.filter(isUpdate(kind)).map(updateOf);
}

/** Tool-call announcements and closing updates for one tool name. */
export function callsOf(frames: readonly Frame[], name: string): { announced: Update[]; updates: Update[] } {
  const announced = updates(frames, "tool_call").filter((u) => u.name === name);
  const ids = new Set(announced.map((u) => u.toolCallId));
  return { announced, updates: updates(frames, "tool_call_update").filter((u) => ids.has(u.toolCallId)) };
}

/** Runs one prompt to its reply, answering each `session/request_permission` with `decide`. */
export async function driveTurn(
  h: ShellHarness,
  sessionId: string,
  text: string,
  decide: (ask: Frame) => string = () => "allow_once",
): Promise<{ reply: Frame; asks: Frame[] }> {
  // Only this turn's frames: an earlier turn's asks are already answered.
  const start = h.frames.length;
  const promptId = h.prompt(sessionId, text);
  const answered = new Set<unknown>();
  const asks: Frame[] = [];
  for (;;) {
    const next = await h.waitFor(
      (f) =>
        (f.id === promptId && f.method === undefined) ||
        (f.method === ACP_CLIENT_METHODS.sessionRequestPermission && !answered.has(f.id) && h.frames.indexOf(f) >= start),
    );
    if (next.method === undefined) return { reply: next, asks };
    answered.add(next.id);
    asks.push(next);
    h.respond(next.id, { result: { outcome: { outcome: "selected", optionId: decide(next) } } });
  }
}
