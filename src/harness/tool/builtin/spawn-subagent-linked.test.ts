// `spawn_subagent` in a linked project (`.metaproject/linked-projects.json`), and a
// `general` child that answers its mutating calls through the parent's own gate.
//
// What these pin: `project: "<name>"` roots the child in that folder, and only that
// names a linked project: a raw cwd outside the root stays refused, inside a linked
// project too;
// a `general` child gets shell_exec/apply_patch ONLY when the parent turn hands over
// its gate, and then every mutating call goes through that gate (approver, mode),
// so the child can do nothing the parent could not. `read_only` never changes.
import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSpawnSubagentTool, type SpawnSubagentToolDeps } from "./spawn-subagent-tool";
import { addLinkedProject } from "../../../lib/linked-projects";
import type { NormalizedEvent, NormalizedRequest, ProviderPort, StreamOptions } from "../../provider/types";
import type { PermissionMode } from "../../../commands/permission-mode";
import { runAgentTurn, type AgentIO, type ApprovalMeta } from "../../../commands/agent";
import { reviewerDeadline } from "./reviewer-activity";
import type { InteractiveTool, InteractiveToolContext } from "./interactive-tools";

const CAPABILITIES = {
  streaming: true,
  toolCalls: true,
  parallelToolCalls: false,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
};

/** Request 1 calls `toolName` with `input` (when given), the next answers with text. Every request is kept. */
function childProvider(call?: { toolName: string; input: Record<string, unknown> }): { provider: ProviderPort; requests: NormalizedRequest[] } {
  const requests: NormalizedRequest[] = [];
  return {
    requests,
    provider: {
      describe: () => ({ capabilities: CAPABILITIES, descriptor: { providerId: "child" } }),
      async *stream(request, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
        requests.push(request);
        const base = { attemptId: opts.attemptId };
        if (call !== undefined && requests.length === 1) {
          yield { ...base, sequence: 0, kind: "tool_call_start", toolCallId: "t1", toolName: call.toolName } as NormalizedEvent;
          yield { ...base, sequence: 1, kind: "tool_call_end", toolCallId: "t1", input: JSON.stringify(call.input) } as NormalizedEvent;
          yield { ...base, sequence: 2, kind: "model_end" };
          return;
        }
        yield { ...base, sequence: 0, kind: "text_delta", text: "done" };
        yield { ...base, sequence: 1, kind: "model_end" };
      },
    },
  };
}

const userText = (request: NormalizedRequest | undefined): string =>
  (request?.messages ?? []).filter((m) => m.role === "user").map((m) => m.content).join("\n");
const toolResults = (request: NormalizedRequest | undefined): string[] =>
  (request?.messages ?? []).filter((m) => m.role === "tool").map((m) => m.content);
const toolNames = (request: NormalizedRequest | undefined): string[] => (request?.tools ?? []).map((tool) => tool.name);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** An organiser folder beside a backend repository it links as "be". */
async function organiser(): Promise<{ home: string; backend: string; other: string }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "keryx-subagent-linked-")));
  dirs.push(base);
  const home = path.join(base, "home");
  const backend = path.join(base, "backend");
  const other = path.join(base, "other");
  for (const dir of [home, path.join(backend, "src"), other]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(backend, "CLAUDE.md"), "# backend rules\n");
  await addLinkedProject(home, backend, { name: "be" });
  return { home, backend, other };
}

function spawnTool(home: string, provider: ProviderPort, extra: Partial<SpawnSubagentToolDeps> = {}) {
  return createSpawnSubagentTool({
    cwd: home,
    getParentModel: () => ({ providerId: "ollama", modelId: "fake" }),
    makeProvider: () => provider,
    getDetectedProviders: () => [{ name: "ollama" }],
    ...extra,
  });
}

test("project names a linked project: the child is rooted there and told whose rules apply", async () => {
  const { home, backend } = await organiser();
  const { provider, requests } = childProvider();
  const events: Array<{ kind: string; detail?: string }> = [];
  const result = await spawnTool(home, provider, { onFleetEvent: (event) => events.push(event as { kind: string; detail?: string }) })
    .invoke({ task: "read the API", mode: "read_only", project: "be" });
  expect(events.some((event) => event.kind === "upsert" && event.detail === "read-only · in be")).toBe(true);
  expect(result.isError).toBe(false);
  const line = userText(requests[0]);
  expect(line).toContain(`Project root: ${backend}`);
  expect(line).toContain(`This is "be", a linked project of ${home}`);
  expect(toolNames(requests[0])).not.toContain("shell_exec");
});

test("a raw cwd never reaches a linked project or an unlinked sibling; only project does", async () => {
  const { home, other } = await organiser();
  const { provider, requests } = childProvider();
  const tool = spawnTool(home, provider);
  // A linked root widens the read boundary only for the spawn that names it: a raw cwd that
  // happens to fall inside one is refused, so the model cannot reach it without the project field.
  const inside = await tool.invoke({ task: "look", mode: "read_only", cwd: "../backend/src" });
  expect(inside.isError).toBe(true);
  const outside = await tool.invoke({ task: "look", mode: "read_only", cwd: other });
  expect(outside.isError).toBe(true);
  expect(requests).toHaveLength(0);
});

test("a linked project's folder is refused when it would hold the project or everything", async () => {
  const { home } = await organiser();
  await expect(addLinkedProject(home, path.dirname(home), { name: "parent" })).rejects.toThrow("it contains this project");
  await expect(addLinkedProject(home, "/", { name: "root" })).rejects.toThrow(/filesystem root|contains this project/);
});

test("an unknown project, project with cwd, and project with an external runtime are refused before anything starts", async () => {
  const { home } = await organiser();
  const { provider, requests } = childProvider();
  const tool = spawnTool(home, provider);
  const unknown = await tool.invoke({ task: "x", project: "fe" });
  expect(unknown).toMatchObject({ isError: true });
  expect(unknown.output).toContain('"fe" is not a linked project of this one (linked: be)');
  expect((await tool.invoke({ task: "x", project: "be", cwd: "." })).output).toContain("'project' or 'cwd', not both");
  expect((await tool.invoke({ task: "x", project: "be", runtime: { kind: "external", agent: "codex" } })).isError).toBe(true);
  expect((await tool.invoke({ task: "x", project: 3 })).output).toContain("must be the name of a linked project");
  expect(requests).toHaveLength(0);
});

test("a general child without the parent's gate stays read-only and refuses every mutating call", async () => {
  const { home } = await organiser();
  const { provider, requests } = childProvider();
  await spawnTool(home, provider).invoke({ task: "change it", mode: "general", project: "be" });
  expect(toolNames(requests[0])).not.toContain("shell_exec");
  expect(toolNames(requests[0])).not.toContain("apply_patch");
});

function gate(mode: PermissionMode, answer: boolean | (() => Promise<boolean>)) {
  const asked: string[] = [];
  const metas: Array<ApprovalMeta | undefined> = [];
  return {
    asked,
    metas,
    parentGate: {
      requestApproval: async (tool: string, _input: string, meta?: ApprovalMeta) => {
        asked.push(tool);
        metas.push(meta);
        return typeof answer === "boolean" ? answer : answer();
      },
      permissionMode: () => mode,
    },
  };
}

test("a general child under the parent's gate gets shell_exec and apply_patch, and asks the parent's approver", async () => {
  const { home, backend } = await organiser();
  const { provider, requests } = childProvider({ toolName: "shell_exec", input: { command: "echo hi > made.txt" } });
  const { asked, parentGate } = gate("ask", false);
  const result = await spawnTool(home, provider).invoke({ task: "make a file", mode: "general", project: "be" }, { parentGate });
  expect(result.isError).toBe(false);
  expect(toolNames(requests[0])).toEqual(expect.arrayContaining(["shell_exec", "apply_patch"]));
  expect(userText(requests[0])).toContain("each mutating call is approved exactly as the parent's own calls are");
  expect(asked).toEqual(["shell_exec"]);
  expect(existsSync(path.join(backend, "made.txt"))).toBe(false);
  expect(toolResults(requests[1]).join("\n")).toContain("not approved by the user; not executed");
});

test("the parent's yes lets the child's call run, in the linked project's root", async () => {
  const { home, backend } = await organiser();
  const { provider } = childProvider({ toolName: "shell_exec", input: { command: "echo hi > made.txt" } });
  const { asked, parentGate } = gate("ask", true);
  await spawnTool(home, provider).invoke({ task: "make a file", mode: "general", project: "be" }, { parentGate });
  expect(asked).toEqual(["shell_exec"]);
  expect(existsSync(path.join(backend, "made.txt"))).toBe(true);
  expect(existsSync(path.join(home, "made.txt"))).toBe(false);
});

test("a read_only child ignores the parent's gate: no shell, and its approver never runs", async () => {
  const { home } = await organiser();
  const { provider, requests } = childProvider({ toolName: "shell_exec", input: { command: "echo hi" } });
  const { asked, parentGate } = gate("auto", true);
  await spawnTool(home, provider).invoke({ task: "look", mode: "read_only", project: "be" }, { parentGate });
  expect(toolNames(requests[0])).not.toContain("shell_exec");
  expect(asked).toEqual([]);
});

test("a host-built child roster is never widened by the parent's gate", async () => {
  const { home } = await organiser();
  const { provider, requests } = childProvider();
  const { parentGate } = gate("auto", true);
  await spawnTool(home, provider, { childTools: () => [] }).invoke({ task: "x", mode: "general" }, { parentGate });
  expect(toolNames(requests[0])).not.toContain("shell_exec");
});

test("the agent loop hands its own gate to spawn_subagent, and to no other tool", async () => {
  const seen: Record<string, InteractiveToolContext | undefined> = {};
  const recorder = (name: string): InteractiveTool => ({
    definition: { name, description: "probe", inputSchema: { type: "object", properties: {}, additionalProperties: true }, risk: "read" },
    invoke: async (_input, ctx) => {
      seen[name] = ctx;
      return { output: "ok", isError: false };
    },
  });
  let round = 0;
  const provider: ProviderPort = {
    describe: () => ({ capabilities: CAPABILITIES, descriptor: { providerId: "parent" } }),
    async *stream(_request, opts: StreamOptions): AsyncGenerator<NormalizedEvent> {
      round += 1;
      const base = { attemptId: opts.attemptId };
      if (round === 1) {
        let sequence = 0;
        for (const [id, name] of [["c1", "spawn_subagent"], ["c2", "list_probe"]] as const) {
          yield { ...base, sequence: sequence++, kind: "tool_call_start", toolCallId: id, toolName: name } as NormalizedEvent;
          yield { ...base, sequence: sequence++, kind: "tool_call_end", toolCallId: id, input: "{}" } as NormalizedEvent;
        }
        yield { ...base, sequence, kind: "model_end" };
        return;
      }
      yield { ...base, sequence: 0, kind: "text_delta", text: "done" };
      yield { ...base, sequence: 1, kind: "model_end" };
    },
  };
  const approvals: string[] = [];
  const requestApproval: NonNullable<AgentIO["requestApproval"]> = async (tool) => {
    approvals.push(tool);
    return false;
  };
  const permissionMode = (): PermissionMode => "trust";
  const io: AgentIO = { write: () => {}, requestApproval, permissionMode };
  await runAgentTurn(io, { provider, providerId: "p", modelId: "m", tools: [recorder("spawn_subagent"), recorder("list_probe")], systemInstruction: "sys", idSeq: () => `id-${round}` }, [], "go");
  const handed = seen["spawn_subagent"]?.parentGate;
  expect(handed?.permissionMode?.()).toBe("trust");
  const before = approvals.length;
  expect(await handed?.requestApproval?.("shell_exec", "{}")).toBe(false);
  expect(approvals.slice(before)).toEqual(["shell_exec"]);
  expect(seen["list_probe"]).toBeDefined();
  expect(seen["list_probe"]?.parentGate).toBeUndefined();
});

test("a child's call in a linked project names the folder, and is marked as a subagent's", async () => {
  const { home, backend } = await organiser();
  const { provider } = childProvider({ toolName: "shell_exec", input: { command: "echo hi" } });
  const { metas, parentGate } = gate("ask", false);
  await spawnTool(home, provider).invoke({ task: "run it", mode: "general", project: "be" }, { parentGate });
  expect(metas[0]).toMatchObject({ foreignRoot: backend, subagent: true });
});

test("a child in the parent's own root carries no foreign folder", async () => {
  const { home } = await organiser();
  const { provider } = childProvider({ toolName: "shell_exec", input: { command: "echo hi" } });
  const { metas, parentGate } = gate("ask", false);
  await spawnTool(home, provider).invoke({ task: "run it", mode: "general" }, { parentGate });
  expect(metas[0]?.subagent).toBe(true);
  expect(metas[0]?.foreignRoot).toBeUndefined();
});

test("a parent that read untrusted content hands the child the taint", async () => {
  const { home } = await organiser();
  const { provider } = childProvider({ toolName: "shell_exec", input: { command: "echo hi" } });
  const { metas, parentGate } = gate("trust", false);
  await spawnTool(home, provider).invoke({ task: "run it", mode: "general", project: "be" }, { parentGate, untrustedContentSeen: true });
  // In `trust` mode a clean call would run unasked; a tainted one is asked, as untrusted-origin.
  expect(metas).toHaveLength(1);
  expect(metas[0]?.untrustedOrigin).toBe(true);
});

test("a yes that arrives after the parent turn was interrupted does not run the child's call", async () => {
  const { home, backend } = await organiser();
  const { provider } = childProvider({ toolName: "shell_exec", input: { command: "echo hi > made.txt" } });
  const controller = new AbortController();
  const { asked, parentGate } = gate("ask", async () => {
    controller.abort();
    return true;
  });
  await spawnTool(home, provider).invoke({ task: "make a file", mode: "general", project: "be" }, { parentGate, signal: controller.signal });
  expect(asked).toEqual(["shell_exec"]);
  expect(existsSync(path.join(backend, "made.txt"))).toBe(false);
});

test("the child's deadline stops while an approval waits on the operator", async () => {
  let notify!: (waiting: boolean) => void;
  const approvals = { onWait: (listener: (waiting: boolean) => void) => { notify = listener; return () => {}; } };
  const deadline = reviewerDeadline(40, undefined, approvals);
  let expired = false;
  void deadline.expired.then(() => { expired = true; });
  notify(true);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(expired).toBe(false);
  notify(false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(expired).toBe(true);
  deadline.dispose();
});
