import assert from "node:assert/strict";
import { registerDom, unregisterDom } from "./dom";

registerDom();
const React = await import("react");
const { createRoot } = await import("react-dom/client");
const { emit } = await import("@tauri-apps/api/event");
const { mockIPC, mockWindows, clearMocks } = await import("@tauri-apps/api/mocks");

const cwd = "/fixture/issue";
const sessionId = "issue-session";
let turns = 0;
let turnId: number;
const answers: string[][] = [];
const inbound = (message: object) => emit("acp://message", JSON.stringify({jsonrpc: "2.0", ...message}));
const ask = (index: number) => inbound({
  method: "_keryx/ask_user", id: "restored-" + index,
  params: {sessionId, question: "Pending question " + index, options: [{label: "Yes"}]},
});
mockWindows("issue-restore");
mockIPC(async (cmd, args) => {
  if (cmd === "acp_start") return { keryxPath: "/fixture/keryx" };
  if (cmd === "version_check") return {ok:true};
  if (cmd !== "acp_send") return null;
  const {method, params, id, result} = JSON.parse(String((args as {message:string}).message));
  if (method === "session/prompt") {
    assert.deepEqual(params._meta, {keryx:{resumeIssueQuestions:true}});
    assert.equal(params.sessionId, sessionId);
    turns++;
    turnId = id;
    await ask(1);
  } else if (!method && String(id).startsWith("restored-")) {
    assert.equal(result.outcome, "answered");
    answers.push(result.answers);
    if (answers.length === 1) await ask(2);
    else await inbound({ id:turnId, result:{stopReason:"end_turn"} });
  } else if (id != null) {
    const answer = method === "initialize" ? { agentInfo:{version:"1.0.0"}, _meta:{keryx:{profile:"shell",liveSessions:true,issuePreparation:true}} }
      : method === "session/list" ? {sessions:[{sessionId,cwd,title:"Issue session",_meta:{keryx:{messageCount:2,hasIssue:true}}}]}
      : method === "session/load" ? {_meta:{keryx:{pendingIssueQuestions:true}}} : {};
    await inbound({id,result:answer});
  }
  return null;
}, {shouldMockEvents:true});

const { useAcpSession } = await import("../session/useAcpSession");
const { AskUserDialog } = await import("../session/Approvals");

function Workspace() {
  const session = useAcpSession(cwd);
  const question = session.asks[0];
  return <><button onClick={() => void session.openIssueSession(sessionId, undefined, true)}>Reopen</button>
    {question && <AskUserDialog key={question.id} pending={question} onAnswer={session.answerAsk} />}
    <output>{session.state.busy ? "busy" : "idle"}</output></>;
}
const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150 && !check(); i++) await React.act(async () => { await new Promise(r => setTimeout(r, 10)); });
  assert.ok(check());
}
try {
  await React.act(async () => root.render(<Workspace />));
  for (const number of [1,2]) {
    await waitFor(() => document.querySelector(".ask-question")?.textContent?.includes("Pending question " + number) === true);
    assert.equal(host.querySelector("output")?.textContent, "busy");
    // Reopening an already held session cannot submit a duplicate resume turn.
    await React.act(() => host.querySelector("button")!.click());
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await React.act(() => dialog.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
    await React.act(() => dialog.querySelector<HTMLButtonElement>(".btn-primary")!.click());
  }
  await waitFor(() => host.querySelector("output")?.textContent === "idle");
  assert.deepEqual(answers, [["Yes"], ["Yes"]]);
  assert.equal(turns, 1);
} finally {
  await React.act(() => root.unmount());
  clearMocks();
  await unregisterDom();
}
