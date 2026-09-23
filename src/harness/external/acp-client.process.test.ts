// keryx as an ACP CLIENT, over a real pipe (flow 292, AC1-AC8, AC10).
//
// Every test here starts the scripted fake ACP agent
// (`fixtures/external/acp/fake-acp-agent.ts`) as a REAL subprocess through the
// existing `ExternalSpawnPort` (`createBunSpawnPort`), inside a REAL disposable
// `git worktree` cut from a throwaway repository — the same `runExternalChild`
// path `keryx agents external run` and `spawn_subagent` take. No network, no
// vendor CLI.
//
// The fake agent logs every message it RECEIVES to a JSONL file, so assertions
// are about what reached the agent — the permission answer it got, the
// capabilities it was offered, the cwd and mcpServers it was handed — not about
// what keryx believes it sent. Every wait is on a process result or a wire
// message; the only timers are the production ceilings under test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutGitDiscoveryOverrides } from "../../lib/git-env";
import { listSessions } from "../../session/store";
import { createGitWorktreePort } from "../child/git-worktree-port";
import type { AgentIO } from "../../commands/agent";
import type { PermissionMode } from "../../commands/permission-mode";
import { ACP_RUN_RECORD_FILE, resolveKeryxMcpOffer, type AcpContextOffer } from "./acp-run";
import { createBunSpawnPort } from "./bun-spawn-port";
import { runExternalChild, type ExternalChildOutcome } from "./runtime";
import type { ExternalSpawnPort } from "./supervise";
import type { ExternalEvent } from "./types";

const FAKE_AGENT = fileURLToPath(new URL("../../../fixtures/external/acp/fake-acp-agent.ts", import.meta.url));
const TIMEOUT_MS = 60_000;

const VALID_RESULT = {
  contract_version: "1.0.0",
  run_id: "run-1",
  dispatch_id: "dispatch-1",
  status: "DONE",
  summary: "the fake agent did its part",
  acceptance: [],
  artifacts: [],
  changed_files: [],
  findings: [],
  questions: [],
  errors: [],
  metrics: {},
  timestamp_utc: "2026-09-23T00:00:00.000Z",
};
const RESULT_TEXT = JSON.stringify(VALID_RESULT);
/** The final answer, split in two chunks: the fold must concatenate, not newline-join. */
const SAY_RESULT = [{ say: RESULT_TEXT.slice(0, 40) }, { say: RESULT_TEXT.slice(40) }];

const ALL_OPTIONS = [
  { optionId: "opt-allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "opt-allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "opt-reject-once", name: "Reject", kind: "reject_once" },
  { optionId: "opt-reject-always", name: "Always reject", kind: "reject_always" },
];

let root = "";
let project = "";
let worktreesDir = "";
let dataDir = "";
let outside = "";
let counter = 0;

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "user.name=keryx-test", "-c", "user.email=test@example.invalid", ...args], {
    cwd,
    env: withoutGitDiscoveryOverrides(process.env),
    encoding: "utf8",
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-acp-client-")));
  project = path.join(root, "project");
  worktreesDir = path.join(root, "worktrees");
  dataDir = path.join(root, "data");
  outside = path.join(root, "outside");
  for (const dir of [project, worktreesDir, dataDir, outside]) mkdirSync(dir, { recursive: true });
  mkdirSync(path.join(project, "src"), { recursive: true });
  writeFileSync(path.join(project, "README.md"), "line one\nline two\nline three\n");
  writeFileSync(path.join(project, "AGENTS.md"), "# Project instructions\nUse keryx.\n");
  writeFileSync(path.join(project, "src", "a.ts"), "export const a = 1;\n");
  git(["init", "-q"], project);
  git(["add", "-A"], project);
  git(["commit", "-q", "-m", "init"], project);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A content hash of the project tree, `.git` excluded. */
function treeHash(dir: string): string {
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      if (name === ".git") continue;
      const full = path.join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(`${path.relative(dir, full)}\0${readFileSync(full)}\0`);
    }
  };
  walk(dir);
  return hash.digest("hex");
}

interface LogEntry {
  readonly kind: string;
  readonly message?: { readonly id?: string | number; readonly method?: string; readonly params?: Record<string, unknown> };
  readonly as?: string;
  readonly response?: { readonly result?: Record<string, unknown>; readonly error?: { code: number; message: string } };
  readonly path?: string;
  readonly exists?: boolean;
}

interface Scenario {
  readonly file: string;
  readonly log: () => LogEntry[];
}

function scenario(body: Record<string, unknown>): Scenario {
  counter += 1;
  const log = path.join(root, `agent-${counter}.log.jsonl`);
  const file = path.join(root, `scenario-${counter}.json`);
  writeFileSync(file, JSON.stringify({ log, ...body }));
  return {
    file,
    log: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as LogEntry)
        : [],
  };
}

function received(log: LogEntry[], method: string): LogEntry[] {
  return log.filter((entry) => entry.kind === "received" && entry.message?.method === method);
}

function responseAs(log: LogEntry[], as: string): LogEntry["response"] {
  return log.find((entry) => entry.kind === "response" && entry.as === as)?.response;
}

/** A human approver that answers `approved` for THIS prompt's fingerprint. */
function humanSays(approved: boolean): NonNullable<AgentIO["requestApproval"]> {
  return async (_tool, _input, meta) => ({ approved, fingerprint: meta?.fingerprint ?? "" });
}

interface RunOptions {
  readonly write?: boolean;
  readonly mode?: PermissionMode;
  readonly requestApproval?: AgentIO["requestApproval"];
  readonly unattended?: boolean;
  readonly context?: AcpContextOffer;
  readonly timeoutMs?: number;
  readonly approvalTimeoutMs?: number;
  readonly spawn?: ExternalSpawnPort;
  readonly events?: ExternalEvent[];
}

const NOT_OFFERED: AcpContextOffer = { offered: false, reason: "not offered in this test" };

async function run(s: Scenario, options: RunOptions = {}): Promise<ExternalChildOutcome> {
  counter += 1;
  return runExternalChild(
    {
      runtime: { kind: "external", agent: "gemini-acp", sandbox: options.write === true ? "worktree-write" : "read-only" },
      allowedActions: options.write === true ? ["read-file", "write"] : ["read-file"],
      taskTitle: "Fake task",
      taskDescription: "Investigate the fixture project and report back.",
      acceptanceCriteria: [],
      worktreeId: `wt-${counter}`,
      maxPromptBytes: 65_536,
      timeoutMs: options.timeoutMs ?? 30_000,
      parentEnv: process.env,
      depth: 0,
      projectRoot: project,
    },
    {
      spawn: options.spawn ?? createBunSpawnPort(),
      worktree: createGitWorktreePort({ repoRoot: project, worktreesDir }),
      capability: () => ({ enabled: true }),
      maxExternalDepth: 5,
      ...(options.events === undefined ? {} : { onEvent: (event) => options.events?.push(event) }),
      acp: {
        argv: [process.execPath, FAKE_AGENT, s.file],
        dataDir,
        killGraceMs: 1_000,
        ...(options.context === undefined ? { context: NOT_OFFERED } : { context: options.context }),
        ...(options.mode === undefined ? {} : { mode: options.mode }),
        ...(options.requestApproval === undefined ? {} : { requestApproval: options.requestApproval }),
        ...(options.unattended === undefined ? {} : { unattended: options.unattended }),
        ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
      },
    },
  );
}

describe("AC1 — a full ACP turn over a real pipe", () => {
  test(
    "initialize v1 → session/new in the worktree → session/prompt → end_turn, folded and Completed",
    async () => {
      const s = scenario({
        agentInfo: { name: "fake-acp-agent", version: "1.2.3" },
        steps: [
          { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } } },
          { update: { sessionUpdate: "tool_call", toolCallId: "c1", title: "Read README", kind: "read", status: "pending" } },
          { update: { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: "line one" } },
          { update: { sessionUpdate: "usage_update", used: 120, size: 1000, cost: { amount: 0.0125, currency: "USD" } } },
          ...SAY_RESULT,
        ],
      });
      const events: ExternalEvent[] = [];
      const outcome = await run(s, { events });

      expect(outcome.status).toBe("Completed");
      expect(JSON.parse(outcome.output)).toEqual(VALID_RESULT);

      const log = s.log();
      const init = received(log, "initialize")[0];
      expect(init?.message?.params?.["protocolVersion"]).toBe(1);
      const created = received(log, "session/new")[0];
      const cwd = created?.message?.params?.["cwd"];
      expect(typeof cwd).toBe("string");
      expect(path.isAbsolute(cwd as string)).toBe(true);
      expect(cwd).toBe(outcome.worktreePath);
      expect(received(log, "session/prompt")).toHaveLength(1);

      const kinds = events.map((event) => event.kind);
      expect(kinds).toEqual(
        expect.arrayContaining(["child_started", "thinking", "tool_call", "tool_result", "usage", "assistant_text", "child_finished"]),
      );
      expect(events.find((event) => event.kind === "usage")).toEqual({ kind: "usage", costUnits: 0.0125 });
      expect(outcome.costUnits).toBe(0.0125);

      // The disposable worktree is gone once the run returns.
      expect(existsSync(outcome.worktreePath ?? "")).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "an unsupported protocol version ends Error with a named reason, and the child is killed",
    async () => {
      const s = scenario({ protocolVersion: 2, steps: SAY_RESULT });
      const outcome = await run(s);
      expect(outcome.status).toBe("Error");
      expect(outcome.output).toContain("unsupported ACP protocol version");
      expect(outcome.output).toContain("protocolVersion 2");
      expect(outcome.acp?.killed).toBe(true);
      // Nothing past the handshake was attempted.
      expect(received(s.log(), "session/new")).toHaveLength(0);
    },
    TIMEOUT_MS,
  );
});

function permissionScenario(options: readonly Record<string, string>[] = ALL_OPTIONS): Scenario {
  return scenario({
    steps: [
      { update: { sessionUpdate: "tool_call", toolCallId: "x1", title: "List files", kind: "execute", status: "pending" } },
      {
        permission: {
          toolCall: { toolCallId: "x1", title: "List files", kind: "execute", rawInput: { command: "ls" } },
          options,
        },
        onAllow: [{ update: { sessionUpdate: "tool_call_update", toolCallId: "x1", status: "completed", rawOutput: "ran" } }],
        onDeny: [{ update: { sessionUpdate: "tool_call_update", toolCallId: "x1", status: "failed", rawOutput: "rejected" } }],
      },
      ...SAY_RESULT,
    ],
  });
}

describe("AC2 — the permission bridge on the wire", () => {
  test(
    "a human approval that echoes the fingerprint reaches the agent as allow_once; trust is lowered to ask and recorded",
    async () => {
      const s = permissionScenario();
      let asked = 0;
      const outcome = await run(s, {
        mode: "trust",
        requestApproval: async (tool, input, meta) => {
          asked += 1;
          return humanSays(true)(tool, input, meta);
        },
      });
      expect(outcome.status).toBe("Completed");
      // Under an UNCLAMPED trust a benign execute would auto-approve with no
      // prompt; the human was asked because the mode was lowered.
      expect(asked).toBe(1);
      expect(responseAs(s.log(), "permission")?.result?.["outcome"]).toEqual({ outcome: "selected", optionId: "opt-allow-once" });
      const decision = outcome.acp?.decisions[0];
      expect(decision).toMatchObject({
        kind: "execute",
        risk: "shell",
        gateDecision: "ask",
        verdict: "approve",
        reason: "human",
        optionId: "opt-allow-once",
        modeRequested: "trust",
        modeEffective: "ask",
      });
      expect(outcome.acp?.mode).toEqual({ requested: "trust", effective: "ask", clamped: true });
      expect(outcome.acp?.toolCalls.find((call) => call.toolCallId === "x1")?.status).toBe("completed");
    },
    TIMEOUT_MS,
  );
});

describe("AC3 — an unattended run fails closed", () => {
  test(
    "no approver: the agent receives reject_once, reports the tool as not run, and the record holds the decision",
    async () => {
      const s = permissionScenario();
      const outcome = await run(s, { mode: "auto" });
      expect(responseAs(s.log(), "permission")?.result?.["outcome"]).toEqual({ outcome: "selected", optionId: "opt-reject-once" });
      expect(outcome.acp?.toolCalls.find((call) => call.toolCallId === "x1")?.status).toBe("failed");
      expect(outcome.acp?.decisions).toHaveLength(1);
      expect(outcome.acp?.decisions[0]).toMatchObject({
        risk: "shell",
        gateDecision: "ask",
        verdict: "deny",
        timedOut: false,
        reason: "unattended",
      });
      expect(outcome.acp?.unattended).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    "--unattended overrides a wired approver, and with no reject_once offered the answer is cancelled",
    async () => {
      const s = permissionScenario(ALL_OPTIONS.filter((option) => option.kind !== "reject_once"));
      let asked = 0;
      const outcome = await run(s, {
        unattended: true,
        requestApproval: async () => {
          asked += 1;
          return true;
        },
      });
      expect(asked).toBe(0);
      expect(responseAs(s.log(), "permission")?.result?.["outcome"]).toEqual({ outcome: "cancelled" });
      expect(outcome.acp?.decisions[0]).toMatchObject({ verdict: "deny", reason: "unattended", outcome: "cancelled", optionId: null });
    },
    TIMEOUT_MS,
  );

  test(
    "an approver that does not answer in time and a human no are both rejections, each recorded with its reason",
    async () => {
      const slow = permissionScenario();
      const timedOut = await run(slow, { requestApproval: () => new Promise(() => undefined), approvalTimeoutMs: 200 });
      expect(responseAs(slow.log(), "permission")?.result?.["outcome"]).toEqual({ outcome: "selected", optionId: "opt-reject-once" });
      expect(timedOut.acp?.decisions[0]).toMatchObject({ verdict: "deny", reason: "timeout", timedOut: true });

      const no = permissionScenario();
      const refused = await run(no, { requestApproval: humanSays(false) });
      expect(responseAs(no.log(), "permission")?.result?.["outcome"]).toEqual({ outcome: "selected", optionId: "opt-reject-once" });
      expect(refused.acp?.decisions[0]).toMatchObject({ verdict: "deny", reason: "human", timedOut: false });
    },
    TIMEOUT_MS,
  );
});

function refusalRequests(): Record<string, unknown>[] {
  return [
    { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/new.txt", content: "x" } }, as: "write" },
    { stat: "{{cwd}}/new.txt" },
    { request: { method: "terminal/create", params: { sessionId: "fake-session-1", command: "touch", args: ["{{cwd}}/spawned.txt"] } }, as: "terminal" },
    { stat: "{{cwd}}/spawned.txt" },
    { request: { method: "elicitation/create", params: { sessionId: "fake-session-1", message: "?" } }, as: "elicitation" },
  ];
}

describe("AC4 — keryx advertises only what it serves", () => {
  test(
    "a read-only run advertises readTextFile only; write, terminal and elicitation are refused by name and recorded",
    async () => {
      const s = scenario({ steps: [...refusalRequests(), ...SAY_RESULT] });
      const outcome = await run(s);
      const log = s.log();
      const caps = received(log, "initialize")[0]?.message?.params?.["clientCapabilities"] as Record<string, unknown>;
      expect(caps).toEqual({ fs: { readTextFile: true, writeTextFile: false }, terminal: false });
      expect("elicitation" in caps).toBe(false);

      for (const as of ["write", "terminal", "elicitation"]) {
        const error = responseAs(log, as)?.error;
        expect(error?.code).toBe(-32601);
        expect(error?.message).toContain("refused");
      }
      expect(responseAs(log, "write")?.error?.message).toContain("did not advertise fs.writeTextFile");
      expect(log.filter((entry) => entry.kind === "stat").map((entry) => entry.exists)).toEqual([false, false]);

      const refused = outcome.acp?.fsRequests.filter((record) => record.outcome === "refused").map((record) => record.method);
      expect(refused).toEqual(["fs/write_text_file", "terminal/create", "elicitation/create"]);
    },
    TIMEOUT_MS,
  );

  test(
    "--write additionally advertises writeTextFile, and still never terminal; terminal and elicitation stay refused",
    async () => {
      const s = scenario({
        steps: [
          { request: { method: "terminal/create", params: { sessionId: "fake-session-1", command: "ls" } }, as: "terminal" },
          { request: { method: "elicitation/create", params: { sessionId: "fake-session-1" } }, as: "elicitation" },
          ...SAY_RESULT,
        ],
      });
      await run(s, { write: true });
      const log = s.log();
      expect(received(log, "initialize")[0]?.message?.params?.["clientCapabilities"]).toEqual({
        fs: { readTextFile: true, writeTextFile: true },
        terminal: false,
      });
      expect(responseAs(log, "terminal")?.error?.message).toContain("refused");
      expect(responseAs(log, "elicitation")?.error?.message).toContain("refused");
    },
    TIMEOUT_MS,
  );
});

describe("AC5 — fs requests run only inside keryx's confined code", () => {
  test(
    "reads are served from the worktree; escapes, credentials and flow files are refused; an approved write lands in the worktree and leaves as a never-applied patch",
    async () => {
      writeFileSync(path.join(outside, "secret.txt"), "outside secret");
      const before = treeHash(project);
      const s = scenario({
        steps: [
          { request: { method: "fs/read_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/README.md", line: 2, limit: 1 } }, as: "read" },
          { request: { method: "fs/read_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/../../outside/secret.txt" } }, as: "read-traversal" },
          { symlink: { target: outside, path: "link" } },
          { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/link/escape.txt", content: "escaped" } }, as: "write-symlink" },
          { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/../escape.txt", content: "escaped" } }, as: "write-traversal" },
          { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/.config/keryx/auth.json", content: "{}" } }, as: "write-credentials" },
          { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/.metaproject/flows/1-x/flow.json", content: "{}" } }, as: "write-flow" },
          { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/src/new.ts", content: "export const b = 2;\n" } }, as: "write-ok" },
          { stat: "{{cwd}}/src/new.ts" },
          ...SAY_RESULT,
        ],
      });
      const approved: string[] = [];
      const outcome = await run(s, {
        write: true,
        requestApproval: async (tool, input, meta) => {
          approved.push(tool);
          return humanSays(true)(tool, input, meta);
        },
      });
      expect(outcome.status).toBe("Completed");
      const log = s.log();

      expect(responseAs(log, "read")?.result).toEqual({ content: "line two" });
      expect(responseAs(log, "read-traversal")?.error?.message).toContain("outside the disposable worktree");
      expect(responseAs(log, "write-symlink")?.error?.message).toContain("outside the disposable worktree");
      expect(responseAs(log, "write-traversal")?.error?.message).toContain("outside the disposable worktree");
      expect(responseAs(log, "write-credentials")?.error?.message).toContain("credential");
      expect(responseAs(log, "write-flow")?.error?.message).toContain("managed flow state");
      expect(responseAs(log, "write-ok")?.result).toEqual({});
      expect(log.find((entry) => entry.kind === "stat")?.exists).toBe(true);
      expect(existsSync(path.join(outside, "escape.txt"))).toBe(false);
      expect(existsSync(path.join(root, "escape.txt"))).toBe(false);
      expect(existsSync(path.join(worktreesDir, "escape.txt"))).toBe(false);

      // Only the confined, legitimate write reached the bridge — as risk `write`.
      expect(approved).toHaveLength(1);
      const writeDecision = outcome.acp?.decisions.find((decision) => decision.kind === "edit");
      expect(writeDecision).toMatchObject({ risk: "write", verdict: "approve", reason: "human" });

      // The patch artifact carries the write; the operator's tree does not.
      const patchPath = outcome.acp?.patchArtifact;
      expect(patchPath).toBeDefined();
      const patch = readFileSync(patchPath as string, "utf8");
      expect(patch).toContain("src/new.ts");
      expect(patch).toContain("export const b = 2;");
      expect(existsSync(path.join(project, "src", "new.ts"))).toBe(false);
      expect(treeHash(project)).toBe(before);
    },
    TIMEOUT_MS,
  );

  test(
    "a --write run with nobody to ask writes nothing",
    async () => {
      const before = treeHash(project);
      const s = scenario({
        steps: [
          { request: { method: "fs/write_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/src/new.ts", content: "x" } }, as: "write" },
          { stat: "{{cwd}}/src/new.ts" },
          ...SAY_RESULT,
        ],
      });
      const outcome = await run(s, { write: true });
      expect(responseAs(s.log(), "write")?.error?.message).toContain("not approved (unattended)");
      expect(s.log().find((entry) => entry.kind === "stat")?.exists).toBe(false);
      expect(outcome.acp?.patchArtifact).toBeUndefined();
      expect(treeHash(project)).toBe(before);
    },
    TIMEOUT_MS,
  );
});

describe("AC6 — context through keryx's own MCP server", () => {
  test(
    "session/new carries one stdio server launching the running build as serve-mcp --read-only",
    async () => {
      mkdirSync(path.join(project, ".metaproject"), { recursive: true });
      writeFileSync(path.join(project, ".metaproject", "metaproject.json"), JSON.stringify({ modules: { mcp: { enabled: true } } }));
      const context = await resolveKeryxMcpOffer(project, { sdkAvailable: () => true });
      expect(context.offered).toBe(true);
      const s = scenario({ steps: SAY_RESULT });
      const outcome = await run(s, { context });
      const servers = received(s.log(), "session/new")[0]?.message?.params?.["mcpServers"] as Array<Record<string, unknown>>;
      expect(servers).toHaveLength(1);
      expect(servers[0]?.["name"]).toBe("keryx");
      expect(servers[0]?.["command"]).toBe(process.execPath);
      expect(servers[0]?.["command"]).not.toBe("keryx");
      const args = servers[0]?.["args"] as string[];
      expect(args.slice(-4)).toEqual(["serve-mcp", "--read-only", "--cwd", project]);
      expect(args[0]).toMatch(/src[/\\]cli\.ts$/);
      expect(outcome.acp?.context).toEqual(context);
    },
    TIMEOUT_MS,
  );

  test(
    "with the MCP module unavailable the run still proceeds and records not-offered with the reason",
    async () => {
      const s = scenario({ steps: SAY_RESULT });
      const outcome = await runExternalChildWithDefaultContext(s);
      expect(outcome.status).toBe("Completed");
      expect(received(s.log(), "session/new")[0]?.message?.params?.["mcpServers"]).toEqual([]);
      expect(outcome.acp?.context.offered).toBe(false);
      if (outcome.acp?.context.offered === false) expect(outcome.acp.context.reason).toContain("MCP module is disabled");
    },
    TIMEOUT_MS,
  );

  test(
    "the first prompt is buildExternalPrompt's; resource blocks only when the agent advertised embeddedContext",
    async () => {
      const plain = scenario({ steps: SAY_RESULT });
      const plainOutcome = await run(plain);
      const plainPrompt = received(plain.log(), "session/prompt")[0]?.message?.params?.["prompt"] as Array<Record<string, unknown>>;
      expect(String(plainPrompt[0]?.["text"])).toContain("Investigate the fixture project and report back.");
      expect(String(plainPrompt[0]?.["text"])).toContain("contract_version");
      expect(plainPrompt.some((block) => block["type"] === "resource")).toBe(false);
      expect(plainPrompt.some((block) => String(block["text"]).includes("Project instructions"))).toBe(true);
      expect(plainOutcome.acp?.embeddedContextSent).toBe(false);

      const rich = scenario({ agentCapabilities: { promptCapabilities: { embeddedContext: true } }, steps: SAY_RESULT });
      const richOutcome = await run(rich);
      const richPrompt = received(rich.log(), "session/prompt")[0]?.message?.params?.["prompt"] as Array<Record<string, unknown>>;
      const resource = richPrompt.find((block) => block["type"] === "resource")?.["resource"] as Record<string, unknown> | undefined;
      expect(resource?.["uri"]).toBe(`file://${path.join(project, "AGENTS.md")}`);
      expect(String(resource?.["text"])).toContain("Project instructions");
      expect(richOutcome.acp?.embeddedContextSent).toBe(true);
    },
    TIMEOUT_MS,
  );
});

/** A run that does NOT inject a context offer, so the runtime resolves it itself. */
async function runExternalChildWithDefaultContext(s: Scenario): Promise<ExternalChildOutcome> {
  counter += 1;
  return runExternalChild(
    {
      runtime: { kind: "external", agent: "gemini-acp", sandbox: "read-only" },
      allowedActions: ["read-file"],
      taskTitle: "Fake task",
      taskDescription: "Investigate the fixture project and report back.",
      acceptanceCriteria: [],
      worktreeId: `wt-${counter}`,
      maxPromptBytes: 65_536,
      timeoutMs: 30_000,
      parentEnv: process.env,
      depth: 0,
      projectRoot: project,
    },
    {
      spawn: createBunSpawnPort(),
      worktree: createGitWorktreePort({ repoRoot: project, worktreesDir }),
      capability: () => ({ enabled: true }),
      maxExternalDepth: 5,
      acp: { argv: [process.execPath, FAKE_AGENT, s.file], dataDir, killGraceMs: 1_000 },
    },
  );
}

describe("AC7 — every run is a keryx session", () => {
  test(
    "listed by keryx sessions under provider acp:<id>, with decisions, fs requests, argv, worktree, agent info, usage and cost",
    async () => {
      const token = `ghp_${"a1B2c3D4e5".repeat(4)}`;
      const s = scenario({
        agentInfo: { name: "fake-acp-agent", version: "1.2.3" },
        steps: [
          { request: { method: "fs/read_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/README.md" } }, as: "read" },
          { request: { method: "terminal/create", params: { sessionId: "fake-session-1", command: "ls" } }, as: "terminal" },
          { update: { sessionUpdate: "usage_update", used: 50, size: 2000, cost: { amount: 3, currency: "EUR" } } },
          { say: `a token leaked into my reply: ${token}\n` },
          ...SAY_RESULT,
        ],
        stopReason: "end_turn",
      });
      const outcome = await run(s, { mode: "trust" });
      const record = outcome.acp;
      expect(record?.sessionId).toBeDefined();
      const session = listSessions(project, dataDir).find((summary) => summary.id === record?.sessionId);
      expect(session?.provider).toBe("acp:gemini-acp");
      expect(session?.model).toBe("fake-acp-agent 1.2.3");

      const sessionDir = path.dirname(record?.patchArtifact ?? path.join(findSessionDir(record?.sessionId ?? ""), "x"));
      const persisted = JSON.parse(readFileSync(path.join(sessionDir, ACP_RUN_RECORD_FILE), "utf8")) as Record<string, unknown>;
      expect(persisted["agentInfo"]).toEqual({ name: "fake-acp-agent", version: "1.2.3" });
      expect(persisted["argv"]).toEqual([process.execPath, FAKE_AGENT, s.file]);
      expect(persisted["worktreePath"]).toBe(outcome.worktreePath);
      expect(persisted["usage"]).toEqual({ used: 50, size: 2000 });
      // Raw, never converted, never folded into the USD `costUnits`.
      expect(persisted["cost"]).toEqual({ amount: 3, currency: "EUR" });
      expect(outcome.costUnits).toBeUndefined();
      expect(persisted["mode"]).toEqual({ requested: "trust", effective: "ask", clamped: true });
      const fs = persisted["fsRequests"] as Array<Record<string, unknown>>;
      expect(fs.map((request) => [request["method"], request["outcome"]])).toEqual([
        ["fs/read_text_file", "served"],
        ["terminal/create", "refused"],
      ]);

      const transcript = readFileSync(path.join(sessionDir, "context.jsonl"), "utf8");
      expect(transcript).toContain("a token leaked into my reply");
      expect(transcript).not.toContain(token);
    },
    TIMEOUT_MS,
  );

  test(
    "a cost the agent never reported is recorded as missing, never 0",
    async () => {
      const s = scenario({ steps: SAY_RESULT });
      const outcome = await run(s);
      expect(outcome.acp?.cost).toBe("missing");
      expect(outcome.acp?.usage).toBe("missing");
      expect(outcome.costUnits).toBeUndefined();
      const persisted = JSON.parse(
        readFileSync(path.join(findSessionDir(outcome.acp?.sessionId ?? ""), ACP_RUN_RECORD_FILE), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted["cost"]).toBe("missing");
    },
    TIMEOUT_MS,
  );
});

/** The on-disk directory of a session, found by walking the data dir. */
function findSessionDir(sessionId: string): string {
  const stack = [dataDir];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (name === sessionId) return full;
      stack.push(full);
    }
  }
  throw new Error(`session ${sessionId} not found under ${dataDir}`);
}

describe("AC8 — timeout, and cleanup on every path", () => {
  test(
    "a run past its ceiling sends session/cancel, kills the agent after the grace window, ends Timeout, and removes the worktree",
    async () => {
      const s = scenario({ hang: true, steps: [{ say: "started" }] });
      const outcome = await run(s, { timeoutMs: 1_500 });
      expect(outcome.status).toBe("Timeout");
      expect(received(s.log(), "session/cancel")).toHaveLength(1);
      expect(outcome.acp?.cancelSent).toBe(true);
      expect(outcome.acp?.killed).toBe(true);
      expect(existsSync(outcome.worktreePath ?? "")).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    "a spawn port that throws is a named Error and the worktree is still removed",
    async () => {
      const throwing: ExternalSpawnPort = {
        spawn: () => {
          throw new Error("no process for you");
        },
      };
      const outcome = await run(scenario({}), { spawn: throwing });
      expect(outcome.status).toBe("Error");
      expect(outcome.output).toContain("no process for you");
      expect(outcome.worktreePath).toBeDefined();
      expect(existsSync(outcome.worktreePath ?? "")).toBe(false);
      expect(readdirSync(worktreesDir)).toEqual([]);
    },
    TIMEOUT_MS,
  );
});

describe("AC10 — the honest limit: the agent's own tools never reach keryx", () => {
  test(
    "a file the agent writes itself lands only in the disposable worktree, is not recorded as a keryx write, and the project is untouched",
    async () => {
      const before = treeHash(project);
      const s = scenario({ steps: [{ writeOwnFile: { path: "own.txt", content: "agent-wrote-this" } }, { stat: "{{cwd}}/own.txt" }, ...SAY_RESULT] });
      const outcome = await run(s);
      const log = s.log();
      const own = log.find((entry) => entry.kind === "own-write");
      expect(own?.path).toBe(path.join(outcome.worktreePath ?? "", "own.txt"));
      expect(log.find((entry) => entry.kind === "stat")?.exists).toBe(true);
      // keryx never saw it: no fs request, no decision.
      expect(outcome.acp?.fsRequests).toEqual([]);
      expect(outcome.acp?.decisions).toEqual([]);
      // The worktree — and the file with it — is gone; the project never had it.
      expect(existsSync(own?.path ?? "")).toBe(false);
      expect(existsSync(path.join(project, "own.txt"))).toBe(false);
      expect(treeHash(project)).toBe(before);
    },
    TIMEOUT_MS,
  );
});

describe("flow 292 T13 — keryx answers only for this run's session, and only during its turn", () => {
  test(
    "a permission or fs request naming another session is refused by name and recorded; an update for another session is ignored",
    async () => {
      const s = scenario({
        steps: [
          {
            request: {
              method: "session/request_permission",
              params: {
                sessionId: "other-session",
                toolCall: { toolCallId: "o1", title: "read", kind: "read" },
                options: ALL_OPTIONS,
              },
            },
            as: "foreign-permission",
          },
          {
            request: { method: "fs/read_text_file", params: { sessionId: "other-session", path: "{{cwd}}/README.md" } },
            as: "foreign-read",
          },
          { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "INJECTED-BY-OTHER-SESSION" } }, session: "other-session" },
          { update: { sessionUpdate: "tool_call", toolCallId: "o2", title: "ghost", kind: "execute" }, session: "other-session" },
          ...SAY_RESULT,
        ],
      });
      const outcome = await run(s);
      expect(outcome.status).toBe("Completed");
      const log = s.log();
      for (const as of ["foreign-permission", "foreign-read"]) {
        const error = responseAs(log, as)?.error;
        expect(error?.code).toBe(-32602);
        expect(error?.message).toContain('names session "other-session"');
      }
      // Recorded, and never decided: no permission decision exists for it.
      expect(outcome.acp?.decisions).toEqual([]);
      expect(outcome.acp?.fsRequests.map((r) => [r.method, r.outcome])).toEqual([
        ["session/request_permission", "refused"],
        ["fs/read_text_file", "refused"],
      ]);
      // The foreign updates were ignored: nothing folded, nothing recorded.
      expect(outcome.output).not.toContain("INJECTED-BY-OTHER-SESSION");
      expect(outcome.acp?.toolCalls.find((call) => call.toolCallId === "o2")).toBeUndefined();
    },
    TIMEOUT_MS,
  );

  test(
    "a permission or fs request sent after the prompt was answered is refused and recorded, never decided",
    async () => {
      const s = scenario({
        steps: SAY_RESULT,
        afterPrompt: [
          {
            method: "session/request_permission",
            params: {
              sessionId: "fake-session-1",
              toolCall: { toolCallId: "late", title: "late", kind: "read" },
              options: ALL_OPTIONS,
            },
          },
          { method: "fs/read_text_file", params: { sessionId: "fake-session-1", path: "{{cwd}}/README.md" } },
        ],
      });
      const outcome = await run(s);
      expect(outcome.status).toBe("Completed");
      expect(outcome.acp?.decisions).toEqual([]);
      const refused = outcome.acp?.fsRequests ?? [];
      expect(refused.map((r) => r.method)).toEqual(["session/request_permission", "fs/read_text_file"]);
      for (const record of refused) {
        expect(record.outcome).toBe("refused");
        expect(record.reason).toContain("turn has ended");
      }
    },
    TIMEOUT_MS,
  );
});
