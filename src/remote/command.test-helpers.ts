// A bridge on a fake client, for the command tests of flow 387. No network, no serve.

import type { InboundMeta, RemoteClientOptions, StartResult } from "./client";
import type { CommandOutcome } from "./command-router";
import type { MessageState } from "./protocol";
import { RemoteBridge, type RemoteBridgeHost, type RemoteClientLike } from "./shell-bridge";

export const META: InboundMeta = { updateId: 1, threadId: 7, fromId: 9, receivedAt: 0 };
// Shaped like a provider key; the redactor must not let it through.
export const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp";

export interface ChoiceCall {
  text: string;
  rows: string[][];
  timeoutMs: number;
  /** Answer it: the flat index of the pressed button, or undefined for no answer. */
  answer(index: number | undefined): void;
}

export interface CommandClient extends RemoteClientLike {
  options: RemoteClientOptions;
  replies: string[];
  choices: ChoiceCall[];
  /** Every state the shell reported, as [update id, state], in order. */
  reported: Array<[number, MessageState]>;
}

export interface CommandHarnessOptions {
  busy?: boolean;
  runCommand?: (line: string) => Promise<CommandOutcome>;
  busyRefusal?: (line: string) => string | undefined;
  runningNoticeMs?: number;
  commandLimitMs?: number;
  listModels?: RemoteBridgeHost["listModels"];
  switchModel?: RemoteBridgeHost["switchModel"];
  listProviders?: RemoteBridgeHost["listProviders"];
  listSessions?: RemoteBridgeHost["listSessions"];
  resumeSession?: RemoteBridgeHost["resumeSession"];
  choiceTimeoutMs?: number;
  /** The run limit serve delivered, in milliseconds; 0 (the default) is no limit. */
  runTimeoutMs?: number;
  /** When set, serve refuses every question with this reason (the 429 and 409 answers); the fake then offers `askChoice`. */
  refuseChoice?: string;
  /** Answer for `askApproval` (flow 396). Absent: the fake has no such method, as an old client. */
  askApproval?: NonNullable<RemoteClientLike["askApproval"]>;
}

export function commandHarness(opts: CommandHarnessOptions = {}) {
  const calls: string[] = [];
  const ran: string[] = [];
  const state = { busy: opts.busy ?? false, now: 1_000_000 };
  const host: RemoteBridgeHost = {
    sessionId: () => "sess-1",
    project: () => "/proj",
    isBusy: () => state.busy,
    runLine: (t) => calls.push(`run:${t}`),
    enqueue: (t) => calls.push(`queue:${t}`),
    notice: (t) => calls.push(`notice:${t}`),
    cancelTurn: () => calls.push("cancel"),
    recordOn: (n) => calls.push(`on:${n}`),
    recordOff: () => calls.push("off"),
    runCommand:
      opts.runCommand === undefined
        ? async (line) => {
            ran.push(line);
            return { output: `ran ${line}`, ok: true };
          }
        : async (line) => {
            ran.push(line);
            return (opts.runCommand as (line: string) => Promise<CommandOutcome>)(line);
          },
    ...(opts.busyRefusal !== undefined ? { busyRefusal: opts.busyRefusal } : {}),
    ...(opts.listModels !== undefined ? { listModels: opts.listModels } : {}),
    ...(opts.switchModel !== undefined ? { switchModel: opts.switchModel } : {}),
    ...(opts.listProviders !== undefined ? { listProviders: opts.listProviders } : {}),
    ...(opts.listSessions !== undefined ? { listSessions: opts.listSessions } : {}),
    ...(opts.resumeSession !== undefined ? { resumeSession: opts.resumeSession } : {}),
  };
  let client!: CommandClient;
  const bridge = new RemoteBridge({
    host,
    now: () => state.now,
    approvalTimeoutMs: 50,
    ...(opts.runningNoticeMs !== undefined ? { commandRunningNoticeMs: opts.runningNoticeMs } : {}),
    ...(opts.commandLimitMs !== undefined ? { commandLimitMs: opts.commandLimitMs } : {}),
    ...(opts.choiceTimeoutMs !== undefined ? { choiceTimeoutMs: opts.choiceTimeoutMs } : {}),
    makeClient: (options: RemoteClientOptions) => {
      const startResult: StartResult = { ok: true, name: "topic-a", threadId: 7, runTimeoutMs: 0 };
      const fake = {
        options,
        replies: [] as string[],
        choices: [] as ChoiceCall[],
        reported: [] as Array<[number, MessageState]>,
        get connected() {
          return true;
        },
        get name() {
          return "topic-a";
        },
        get runTimeoutMs() {
          return opts.runTimeoutMs ?? 0;
        },
        get lastHeartbeatAt() {
          return undefined;
        },
        start: async () => startResult,
        close: async () => undefined,
        reply: async (text: string) => {
          fake.replies.push(text);
          return true;
        },
        requestApproval: async () => "deny" as const,
        ...(opts.askApproval !== undefined ? { askApproval: opts.askApproval } : {}),
        reportState: async (updateId: number, state: MessageState) => {
          fake.reported.push([updateId, state]);
        },
        ...(opts.refuseChoice !== undefined ? { askChoice: async () => ({ index: undefined, refusal: opts.refuseChoice as string }) } : {}),
        requestChoice: (text: string, rows: string[][], timeoutMs: number) =>
          new Promise<number | undefined>((resolve) => {
            fake.choices.push({ text, rows, timeoutMs, answer: resolve });
          }),
      };
      client = fake as unknown as CommandClient;
      return client;
    },
  });
  return {
    bridge,
    calls,
    ran,
    state,
    client: () => client,
    /** Send one line the way the client would deliver it from the topic. */
    say: (line: string) => client.options.onLine(line, META),
  };
}

/** Wait until `check` holds, up to about a second. */
export async function waitFor(check: () => boolean, what = "condition"): Promise<void> {
  const until = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() > until) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
