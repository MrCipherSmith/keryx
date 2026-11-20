import { describe, expect, test } from "bun:test";
import type { AvailableCommand, PermissionRequest } from "../acp/types";
import { answerAgentRequest } from "./agentRequests";
import { runCommandLine, type RunDeps } from "./commandRunner";
import { DialogQueue } from "./dialogQueue";
import { initialState, reducer } from "./reducer";
import { SessionRegistry } from "./sessionRegistry";

const delegateAsk: PermissionRequest = {
  sessionId: "s1",
  toolCall: {
    toolCallId: "ext:1",
    title: "Run claude-cli on this task",
    kind: "execute",
    status: "pending",
    rawInput: { agent: "claude-cli", task: "fix it", sandbox: "operator" },
  },
  options: [
    { optionId: "allow_once", name: "Run it", kind: "allow_once" },
    { optionId: "reject_once", name: "Do not run", kind: "reject_once" },
  ],
} as unknown as PermissionRequest;

const commands: AvailableCommand[] = [
  { name: "delegate", description: "", _meta: { keryx: { surface: "text" } } } as unknown as AvailableCommand,
];

/** The window with keryx running `/delegate`: keryx asks for approval before it answers the command. */
function rig() {
  const reg = new SessionRegistry();
  reg.held.add("s1");
  const dialogs = new DialogQueue();
  let win = reducer({ ...initialState, phase: "ready" }, { t: "created", sessionId: "s1", show: true });
  let asked: Promise<unknown> | null = null;
  const deps: RunDeps = {
    client: {
      request: async <T,>() => {
        // keryx sends the permission request while `_keryx/command` is still unanswered.
        asked = answerAgentRequest("session/request_permission", delegateAsk, reg, dialogs);
        const outcome = (await asked) as { outcome: { outcome: string; optionId?: string } };
        return { text: outcome.outcome.optionId === "allow_once" ? "started" : "refused" } as unknown as T;
      },
    },
    sessionId: "s1",
    busy: false,
    commands,
    hasCommandMethod: true,
    queue: [],
    dispatch: (a) => {
      win = reducer(win, a);
    },
    sendPrompt: () => true,
    startTurn: () => true,
    newSession: () => {},
    interrupt: () => {},
    applyEffects: () => {},
    ui: { focusSessions() {}, mode() {}, model() {}, openProviders() {}, fillComposer() {} },
    trackCommand: (sid) => reg.beginCommand(sid),
  };
  return { reg, dialogs, deps, win: () => win, asked: () => asked };
}

describe("a permission request that arrives during a command", () => {
  test("reaches the dialog queue while the command is in flight, and the answer flows back", async () => {
    const r = rig();
    const run = runCommandLine("/delegate claude-cli fix it", r.deps);
    await Promise.resolve();
    await Promise.resolve();
    const { permissions } = r.dialogs.forSession("s1");
    expect(permissions).toHaveLength(1);
    expect(permissions[0]!.req.toolCall.title).toBe("Run claude-cli on this task");
    r.dialogs.answerPermission(permissions[0]!, { outcome: "selected", optionId: "allow_once" });
    expect(await run).toBe(true);
    const card = r.win().convs.s1!.items.find((i) => i.kind === "command");
    expect(card).toMatchObject({ text: "started", refused: false });
    // The command settled: a late request is refused again.
    expect(r.reg.admit({ sessionId: "s1" })).toBeNull();
  });

  test("is cancelled without a command or a turn (fail closed), and for an unheld session", async () => {
    const reg = new SessionRegistry();
    reg.held.add("s1");
    const dialogs = new DialogQueue();
    expect(await answerAgentRequest("session/request_permission", delegateAsk, reg, dialogs)).toEqual({ outcome: { outcome: "cancelled" } });
    const end = reg.beginCommand("other");
    expect(await answerAgentRequest("session/request_permission", { ...delegateAsk, sessionId: "other" }, reg, dialogs)).toEqual({
      outcome: { outcome: "cancelled" },
    });
    end();
    expect(dialogs.forSession("s1").permissions).toHaveLength(0);
  });

  test("ask_user during a command is admitted too", async () => {
    const reg = new SessionRegistry();
    reg.held.add("s1");
    const dialogs = new DialogQueue();
    reg.beginCommand("s1");
    const p = answerAgentRequest("_keryx/ask_user", { sessionId: "s1", question: "ok?" }, reg, dialogs);
    const { asks } = dialogs.forSession("s1");
    expect(asks).toHaveLength(1);
    dialogs.answerAsk(asks[0]!, { outcome: "cancelled" });
    expect(await p).toEqual({ outcome: "cancelled" });
  });
});

test("a typed review request is validated, admitted to its originating session and cannot execute a start", async () => {
  const { reg, dialogs } = rig();
  reg.held.add("s2");
  reg.showLocal("s2");
  reg.beginCommand("s1");
  const opened: unknown[] = [];
  const prepare = (sessionId: string, hints: object) => opened.push({ sessionId, ...hints });
  const send = (params: unknown) => answerAgentRequest("_keryx/prepare_review", params, reg, dialogs, prepare);
  expect(await send({ sessionId: "s2", target: "7" })).toEqual({ prepared: false });
  const refusal = (params: unknown) => send(params).catch((error: Error) => error.message);
  expect(await refusal({ sessionId: "s1", target: "7", start: true })).toContain("Only target and flowId");
  expect(await refusal({ sessionId: "s1", target: "https://evil.invalid/pr" })).toContain("pull request number");
  expect(await refusal({ sessionId: "s1", flowId: "../other" })).toContain("numeric Flow ID");
  expect(await send({ sessionId: "s1", target: "7", flowId: "505" })).toEqual({ prepared: true });
  expect(opened).toEqual([{ sessionId: "s1", target: "#7", flowId: "505" }]);
});
