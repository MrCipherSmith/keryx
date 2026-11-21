import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFlowService, flowsRoot, githubAdapter, readFlow } from "../flow/service";
import { shellHarness, textRound, toolRound } from "../acp/shell-profile.test-helpers";
import { listSessions, openSession, persistHistory, sessionDir } from "../session";
import { readSessionFlags } from "../session/organize";
import { issueWorkspace, issueWorkspaceStages, type IssueWorkAction, type IssueWorkPorts, type IssueWorkRequest } from "../session/issues/issues-launch";
import { issueBindingFile, issueContextForSession } from "../session/issues/issue-session";
import { acceptIssueTurn, answerIssueQuestion, issueTurnReceipt, rememberIssueQuestion, settleIssueTurn } from "../session/issues/issue-turn";
import { issueKey, type IssueDetail, type IssueProjectRef, type IssueViewer } from "./issues-contract";

const viewer: IssueViewer = { host: "github.com", login: "reader", nodeId: "user-reader" };
const issue: IssueDetail = {
  ref: { host: "github.com", nodeId: "issue-B", repositoryId: "repo-B", owner: "owner", repo: "B", number: 42,
    url: "https://github.com/owner/B/issues/42" },
  title: "Prepare this issue", body: "Observed behavior of the fixture.", author: "writer", state: "open",
  assignees: [], labels: [], updatedAt: "2026-03-01", createdAt: "2026-03-01",
};
let root: string;
let dataDir: string;
let project: IssueProjectRef;
let ports: IssueWorkPorts;
const run = (action: IssueWorkAction, extra: Partial<IssueWorkRequest> = {}, cwd = project.cwd, custom = ports) =>
  issueWorkspace(action, cwd, viewer.login, { ref: issue.ref, ...extra }, custom);

function service() {
  return createFlowService({ now: () => new Date("2026-03-01T12:00:00Z"),
    tracker: { ...githubAdapter, detect: async () => true, fetchIssue: async () => ({ title: issue.title, body: issue.body }) },
    healthGate: async () => ({ status: "pass", reasons: [] }) });
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-issues-")));
  dataDir = path.join(root, "profile");
  const cwd = path.join(root, "checkout");
  await mkdir(cwd);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  await mkdir(path.join(cwd, ".metaproject/skills/gdskills/orchestration/flow-orchestrator"), {recursive:true});
  await writeFile(path.join(cwd, ".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md"), "# Flow coordinator");
  await writeFile(path.join(cwd, ".metaproject/metaproject.json"), JSON.stringify({modules:{tasks:{enabled:true}}}));
  project = { cwd, cloneId: "clone-B", projectId: "project-B", baseBranch: "main" };
  ports = { dataDir, projects: async () => [project], authorized: async () => true, read: async () => ({ viewer, issue }),
    init: async (target, detail) => {
      const { flow, dir, existingCwd } = await service().init({ cwd: target.cwd, title: detail.title,
        issue: detail.ref.url, baseBranch: target.baseBranch });
      return { cloneId: target.cloneId, cwd: existingCwd ?? target.cwd, id: flow.id, flowDir: path.basename(dir),
        status: flow.status, baseBranch: target.baseBranch };
    } };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("AC7 foreign checkout, absent target, explicit choice and same issue number in two repositories", async () => {
  expect((await run("open-session", {}, root)).problem?.code).toBe("project_required");
  expect(listSessions(root, dataDir)).toHaveLength(0);
  const other = { ...project, projectId: "second", cwd: root, cloneId: "clone-A" };
  expect((await run("workspace", {}, root, { ...ports, projects: async () => [] })).projects).toEqual([]);
  expect((await run("open-session", {}, root, { ...ports, projects: async () => [other, project] })).problem?.code).toBe("project_ambiguous");
  expect((await run("open-session", {selectedCwd:project.cwd}, root)).session).toBeUndefined();
  expect((await run("open-session", {selectedCwd:project.cwd})).session?.project).toEqual(project);
  const ref = { ...issue.ref, nodeId:"issue-A", repositoryId:"repo-A", repo:"A", url:"https://github.com/owner/A/issues/42" };
  expect(issueKey(ref)).not.toBe(issueKey(issue.ref));
  expect(issueBindingFile(viewer, other, ref, dataDir)).not.toBe(issueBindingFile(viewer, project, issue.ref, dataDir));
});

test("AC8 requesting preparation from an existing discussion preserves its session, transcript and recorded model", async () => {
  const opened = await run("open-session");
  const id = opened.session!.sessionId;
  const { handle } = openSession({ cwd: project.cwd, resumeId:id, dataDir });
  persistHistory(handle, [{ role:"user", content:"Keep the imported assets available offline." }], {provider:"fake",model:"chosen-model"});
  const prepared = await run("prepare-flow");
  expect(prepared.session?.sessionId).toBe(id);
  expect((await run("open-session")).session?.sessionId).toBe(id);
  expect(listSessions(project.cwd,dataDir)).toHaveLength(1);
  const resumed = openSession({cwd:project.cwd, dataDir, resumeId:id});
  expect(resumed.handle.summary.model).toBe("chosen-model");
  expect(resumed.history.some(m => m.content === "Keep the imported assets available offline.")).toBe(true);
  expect(readSessionFlags(handle.dir).flow).toBe(prepared.launch!.flow!.flowDir);
  const mismatch = await run("workspace", {}, project.cwd, { ...ports, authorized: async () => false });
  expect(mismatch.problem?.code).toBe("account_mismatch");
  expect(mismatch.session).toBeUndefined();
});

test("AC9 one action initializes verified issue source and base and supplies a prepare-only ordinary session turn", async () => {
  const result = await run("prepare-flow", {baseBranch:"release/1"});
  const ref = result.launch!.flow!;
  const stored = await readFlow(ref.cwd, ref.flowDir);
  expect(stored.source.ref).toBe(issue.ref.url);
  expect(stored.baseBranch).toBe("release/1");
  expect(stored.status).toBe("initializing");
  expect(await readFile(path.join(flowsRoot(ref.cwd), ref.flowDir, "context.md"), "utf8")).toContain(issue.body);
  expect(result.initialTurn?.text).toContain("prepare-only");
  const dir = sessionDir(project.cwd, result.session!.sessionId, dataDir);
  expect(acceptIssueTurn(dir, issueContextForSession(dir,dataDir), result.initialTurn!.launchId, result.initialTurn!.text)).toBe(true);
  expect(issueTurnReceipt(dir)?.prompt).toBe(result.initialTurn!.text);
});

test("AC10 a durable coordinator question survives reconnect and its answer is reusable until its source changes", async () => {
  const result = await run("prepare-flow");
  const dir = sessionDir(project.cwd, result.session!.sessionId, dataDir);
  const bound = issueContextForSession(dir,dataDir)!;
  acceptIssueTurn(dir, bound, result.initialTurn!.launchId, result.initialTurn!.text);
  const ask = { question:"Should offline data be kept?", options:[{ id:"yes",label:"Yes",description:"Retain data" }], allowFreeform:true };
  const q = rememberIssueQuestion(dir, bound, ask);
  expect((await run("workspace")).question).toEqual({id:q.id, sessionId:result.session!.sessionId});
  answerIssueQuestion(dir, q, "yes");
  const other = rememberIssueQuestion(dir, bound, { ...ask, question: "Should an unrelated artifact be kept?" });
  answerIssueQuestion(dir, other, "no");
  expect(rememberIssueQuestion(dir, bound, ask).answer).toBe("yes");
  expect((await run("workspace")).question).toBeUndefined();
  expect(rememberIssueQuestion(dir, { ...bound,updatedAt:"2026-03-02" }, ask).answer).toBeUndefined();
});

test("AC10 cold ACP restores outstanding questions through an admitted prompt and continues the same conversation once", async () => {
  const work = await run("prepare-flow");
  const { launchId, text } = work.initialTurn!;
  const id = work.session!.sessionId;
  const dir = sessionDir(project.cwd, id, dataDir);
  const opts = { clientCapabilities:{ _meta:{keryx:{askUser:true}} }, serverOptions:{dataDir} };
  const options = [{ id:"yes",label:"Yes",description:"Include it" },{ id:"no",label:"No",description:"Leave it out" }];
  const askDate = {question:"Should dates be UTC?", options};
  const askAudience = {question:"Should contractors see the preview?", options};
  const old = shellHarness({ ...opts, rounds:[toolRound("q-date","ask_user",askDate),textRound("waiting")] });
  try {
    await old.initialize();
    const load = old.request("session/load",{cwd:project.cwd, sessionId:id, mcpServers:[]});
    await old.waitFor(f => f.id === load);
    old.request("session/prompt",{sessionId:id,prompt:[{type:"text",text}],_meta:{keryx:{issueLaunchId:launchId}}});
    await old.waitFor(f => f.method === "_keryx/ask_user");
    // A second worker asks while the coordinator's first dialog is still outstanding.
    rememberIssueQuestion(dir, issueContextForSession(dir,dataDir)!, askAudience);
  } finally { await old.end(); }
  settleIssueTurn(dir);
  const resumed = shellHarness({ ...opts, storedMode:"ask",
    rounds:[toolRound("work","shell_exec",{command:"touch coordinator-fixture"}),textRound("I will apply both decisions.")] });
  try {
    await resumed.initialize();
    const load = () => resumed.request("session/load",{cwd:project.cwd, sessionId:id, mcpServers:[]});
    const firstLoad = load();
    expect((await resumed.waitFor(f => f.id === firstLoad)).result?.["_meta"]).toEqual({keryx:{pendingIssueQuestions:true}});
    expect(resumed.frames.filter(f => f.method === "_keryx/ask_user")).toHaveLength(0);
    const params = {sessionId:id,prompt:[{type:"text",text:"Resume the pending issue questions."}],_meta:{keryx:{resumeIssueQuestions:true}}};
    const turn = resumed.request("session/prompt",params);
    const first = await resumed.waitFor(f => f.method === "_keryx/ask_user");
    expect(first.params).toMatchObject({question:askDate.question});
    resumed.respond(first.id,{result:{outcome:"answered",answers:["Yes"]}});
    const next = await resumed.waitFor(f => f.method === "_keryx/ask_user" && f.id !== first.id);
    expect(next.params).toMatchObject({question:askAudience.question});
    resumed.respond(next.id,{result:{outcome:"answered",answers:["No"]}});
    const working = await resumed.waitFor(f => f.method === "session/request_permission");
    expect((await run("workspace")).launch?.stage).toBe("preparing");
    resumed.respond(working.id,{result:{outcome:{outcome:"selected",optionId:"allow_once"}}});
    expect((await resumed.waitFor(f => f.id === turn)).result?.["stopReason"]).toBe("end_turn");
    // The connection continues holding its lease after the model turn finished.
    expect((await run("workspace")).launch?.stage).toBe("resume_required");
    const replay = resumed.request("session/prompt",params);
    await resumed.waitFor(f => f.id === replay);
    const reopened = load();
    expect((await resumed.waitFor(f => f.id === reopened)).result?.["_meta"]).toBeUndefined();
    const handoffs = openSession({cwd:project.cwd,dataDir,resumeId:id}).history.filter(m => m.role === "user" && m.content.includes("keryx:issue-questions/"));
    expect(handoffs).toHaveLength(1);
    expect(handoffs[0]?.content).toContain(askAudience.question);
    expect(handoffs[0]?.content).toContain(askDate.question);
    expect((await run("workspace")).question).toBeUndefined();
  } finally { await resumed.end(); }
}, 15_000);

test("AC11 concurrent callers and lost package/turn replies recover the same real session, Flow and first turn", async () => {
  const failAfterInit: IssueWorkPorts = { ...ports, init: async (target, detail) => {
    await ports.init(target, detail); throw new Error("lost reply");
  } };
  await expect(run("prepare-flow", {}, project.cwd, failAfterInit)).rejects.toThrow("lost reply");
  const results = await Promise.all([run("prepare-flow"),run("prepare-flow"),run("open-session")]);
  expect(new Set(results.map(r => r.session?.sessionId)).size).toBe(1);
  const workspace = await run("workspace");
  expect(workspace.flows).toHaveLength(1);
  const dir = sessionDir(project.cwd, workspace.session!.sessionId, dataDir);
  const bound = issueContextForSession(dir,dataDir);
  const first = workspace.initialTurn!;
  const stages = async () => (await issueWorkspaceStages(project.cwd, viewer, [issue.ref], {
    catalog: async () => new Map([[issue.ref.repositoryId, [project]]]), authorized: async () => true, dataDir,
  }))[issueKey(issue.ref)];
  expect((await stages())?.canResumePreparation).toBe(true);
  expect((await run("open-session")).initialTurn).toBeUndefined();
  expect((await run("prepare-flow")).initialTurn).toEqual(first);
  expect(acceptIssueTurn(dir,bound,first.launchId,first.text)).toBe(true);
  expect(acceptIssueTurn(dir,bound,first.launchId,first.text)).toBe(false);
  expect((await run("prepare-flow")).initialTurn).toBeUndefined();
  expect((await run("workspace")).launch?.initialTurn.state).toBe("accepted");
  settleIssueTurn(dir);
  expect((await run("workspace")).problem?.code).toBe("resume_required");
  await writeFile(path.join(dir,"issue-preparation-turn.json"),"{");
  expect((await run("workspace")).problem?.code).toBe("launch_outcome_unknown");
  expect((await stages())?.canResumePreparation).toBeUndefined();
  await writeFile(path.join(dir,"issue-preparation-turn.json"),"null");
  expect((await run("prepare-flow")).initialTurn).toBeUndefined();
});

test("AC11 Shell and Desktop race to initialize an issue in separate worktrees of one clone", async () => {
  const git = (args: string[]) => execFileSync("git", args, { cwd:project.cwd, stdio:"pipe" });
  git(["-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-q","--allow-empty","-m","fixture"]);
  const sibling = path.join(root, "sibling");
  git(["worktree","add","--detach",sibling,"HEAD"]);
  const both = await Promise.all([project.cwd, sibling].map(cwd =>
    service().init({ cwd, issue:issue.ref.url, title:issue.title })));
  expect(new Set(both.map(entry => entry.flow.id)).size).toBe(1);
  expect(both.filter(entry => entry.existingCwd !== undefined)).toHaveLength(1);
});

test("AC11 shell-profile ACP accepts exactly one keyed preparation turn and replays its real session", async () => {
  const workspace = await run("prepare-flow");
  const first = workspace.initialTurn!;
  const sessionId = workspace.session!.sessionId;
  const h = shellHarness({ rounds: [textRound("Preparing the project.")],
    clientCapabilities: { _meta: { keryx: { askUser: true } } }, serverOptions: { dataDir } });
  try {
    await h.initialize();
    const load = h.request("session/load", { cwd:project.cwd, sessionId, mcpServers:[] });
    expect((await h.waitFor(frame => frame.id === load)).error).toBeUndefined();
    const params = { sessionId, prompt:[{type:"text",text:first.text}], _meta:{keryx:{issueLaunchId:first.launchId}} };
    for (let i = 0; i < 2; i++) {
      const id = h.request("session/prompt",params);
      expect((await h.waitFor(frame => frame.id === id)).result?.["stopReason"]).toBe("end_turn");
    }
    const reopened = openSession({cwd:project.cwd, dataDir, resumeId:sessionId});
    expect(reopened.history.filter(row => row.role === "user" && row.content.includes(first.text))).toHaveLength(1);
    expect(reopened.history.some(row => row.content.includes("external content") && row.content.includes(issue.body))).toBe(true);
  } finally { await h.end(); }
});

test("AC12 discover legacy CLI packages, require a choice for ambiguous packages, and diagnose missing capabilities", async () => {
  const first = await service().init({ cwd:project.cwd, issue:issue.ref.url });
  const second = await service().init({ cwd:project.cwd, issue:issue.ref.url, separateIssueFlow:true });
  expect(first.flow.id).not.toBe(second.flow.id);
  const choice = await run("prepare-flow");
  expect(choice.problem?.code).toBe("flow_choice_required");
  expect(choice.flows.map(f => f.flowDir)).toContain(path.basename(first.dir));
  expect(choice.flows.every(f => f.cwd===project.cwd && f.status==="initializing")).toBe(true);
  expect((await run("prepare-flow", {flowDir:path.basename(second.dir)})).launch?.flow?.id).toBe(second.flow.id);
  await rm(path.join(project.cwd,".metaproject/skills/gdskills/orchestration/flow-orchestrator/SKILL.md"));
  expect((await run("prepare-flow")).problem?.code).toBe("capability_missing");
  await writeFile(path.join(project.cwd,".metaproject/metaproject.json"),"{}");
  expect((await run("prepare-flow")).problem?.code).toBe("tasks_module_unavailable");
  expect((await run("open-session")).session).toBeDefined();
});
