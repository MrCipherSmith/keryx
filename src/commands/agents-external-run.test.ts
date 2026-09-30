// `keryx agents external run` (flow 292, AC8/AC11).
//
// The command drives one registry ACP agent through `runExternalChild`, behind
// the same gates every external run has. Every refusal here is NAMED — a silent
// no-op would leave the operator believing an agent ran.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_ENV_VARS, ENV_KERYX_TRANSPORT, EXTERNAL_AGENTS_DEFAULTS, type ExternalAgentsConfig } from "../capability/external-agents";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../harness/child/worktree";
import type { ExternalChildOutcome } from "../harness/external/runtime";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { PassThrough } from "node:stream";
import type { Interface } from "node:readline";
import { answerAcpPermission, clampForeignMode } from "../harness/external/acp-permission";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "../harness/external/supervise";
import { agentsExternalCommand, terminalApprover, type AgentsExternalDeps } from "./agents-external";

const FAKE_AGENT = fileURLToPath(new URL("../../fixtures/external/acp/fake-acp-agent.ts", import.meta.url));
const ENABLED: ExternalAgentsConfig = { ...EXTERNAL_AGENTS_DEFAULTS, enabled: true };

let root = "";
let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-ext-run-")));
  errors = [];
  errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  process.exitCode = 0;
});

afterEach(() => {
  errorSpy?.mockRestore();
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

function fakeWorktree(): { port: WorktreePort; created: string[]; removed: string[] } {
  const created: string[] = [];
  const removed: string[] = [];
  return {
    created,
    removed,
    port: {
      async create(id): Promise<CreatedWorktree> {
        created.push(id);
        return { worktreeId: id, path: path.join(root, id) };
      },
      async remove(id): Promise<void> {
        removed.push(id);
      },
      async merge(id): Promise<WorktreeMergeResult> {
        return { worktreeId: id, ok: true };
      },
    },
  };
}

async function* toLines(items: readonly string[]): AsyncIterable<string> {
  for (const item of items) yield item;
}

/** A fake process seam for a line-stream (codec) agent — flow 357, AC8. */
function fakeSpawn(stdout: readonly string[], exitCode = 0): { port: ExternalSpawnPort; calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> } {
  const calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> = [];
  const port: ExternalSpawnPort = {
    spawn(argv, opts): SpawnedProcess {
      calls.push({ argv, opts });
      return {
        stdout: toLines(stdout),
        stderr: toLines([]),
        writeStdin: () => undefined,
        kill: () => undefined,
        exited: Promise.resolve(exitCode),
      };
    },
  };
  return { port, calls };
}

function deps(overrides: Partial<AgentsExternalDeps> = {}): AgentsExternalDeps & { lines: string[] } {
  const lines: string[] = [];
  return { lines, cwd: root, env: {}, configDir: root, log: (line) => lines.push(line), ...overrides };
}

describe("AC8 — named refusals before anything runs", () => {
  test("the capability disabled (the default) is refused by name, and nothing is created", async () => {
    const wt = fakeWorktree();
    await agentsExternalCommand(["run", "gemini-acp", "--task", "look"], deps({ run: { worktree: wt.port } }));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("refused:");
    expect(errors.join("\n")).toContain("externalAgents.enabled");
    expect(wt.created).toEqual([]);
  });

  test("in CI the capability is hard-disabled even when configured on", async () => {
    const wt = fakeWorktree();
    await agentsExternalCommand(
      ["run", "gemini-acp", "--task", "look"],
      deps({ env: { CI: "true" }, run: { config: ENABLED, worktree: wt.port } }),
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toMatch(/refused: .*CI/);
    expect(wt.created).toEqual([]);
  });

  test("a disabled agent is refused by name", async () => {
    await agentsExternalCommand(
      ["run", "gemini-acp", "--task", "look"],
      deps({ run: { config: { ...ENABLED, agents: { "gemini-acp": { enabled: false, model: null } } } } }),
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain('external agent "gemini-acp" is disabled');
  });

  test("a line-stream agent IS driven by `run` (flow 357 widened this from ACP-only)", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    let outcome: ExternalChildOutcome | undefined;
    await agentsExternalCommand(
      ["run", "codex-cli", "--task", "look"],
      deps({
        run: {
          config: ENABLED,
          worktree: wt.port,
          spawn: sp.port,
          detect: async () => ({ binaryFound: true }),
          onOutcome: (o) => {
            outcome = o;
          },
        },
      }),
    );
    // Reaches the spawn port — the ACP-only refusal this used to hit is gone.
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.argv[0]).toBe("codex");
    expect(outcome).toBeDefined();
    expect(errors.join("\n")).not.toContain("drives ACP agents only");
  });

  test("a missing binary is Denied with a named reason, and the worktree is never cut", async () => {
    const wt = fakeWorktree();
    let outcome: ExternalChildOutcome | undefined;
    await agentsExternalCommand(
      ["run", "gemini-acp", "--task", "look"],
      deps({
        run: {
          config: ENABLED,
          worktree: wt.port,
          detect: async () => ({ binaryFound: false }),
          onOutcome: (o) => {
            outcome = o;
          },
        },
      }),
    );
    expect(outcome?.status).toBe("Denied");
    expect(outcome?.output).toContain("not installed");
    expect(outcome?.output).toContain("`gemini`");
    expect(process.exitCode).toBe(1);
    expect(wt.created).toEqual([]);
  });

  test("--help anywhere is a question, never a run", async () => {
    const wt = fakeWorktree();
    await agentsExternalCommand(
      ["run", "gemini-acp", "--task", "look", "--help"],
      deps({ run: { config: ENABLED, worktree: wt.port, detect: null } }),
    );
    expect(process.exitCode).toBe(0);
    expect(wt.created).toEqual([]);
  });

  test("missing --task is a usage error", async () => {
    await agentsExternalCommand(["run", "gemini-acp"], deps({ run: { config: ENABLED } }));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("Usage: keryx agents external run");
  });
});

describe("AC8 — the command drives an ACP agent end to end", () => {
  test("without a TTY the run is unattended, and the outcome, mode and session are reported", async () => {
    const project = path.join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "README.md"), "hello\n");
    const git = (args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: project,
        env: withoutGitDiscoveryOverrides(process.env),
      });
    };
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);

    const result = JSON.stringify({
      contract_version: "1.0.0",
      run_id: "r",
      dispatch_id: "d",
      status: "DONE",
      summary: "ok",
      acceptance: [],
      artifacts: [],
      changed_files: [],
      findings: [],
      questions: [],
      errors: [],
      metrics: {},
      timestamp_utc: "2026-09-23T00:00:00.000Z",
    });
    const scenario = path.join(root, "scenario.json");
    writeFileSync(
      scenario,
      JSON.stringify({
        log: path.join(root, "agent.log.jsonl"),
        agentInfo: { name: "fake-acp-agent", version: "9.9.9" },
        steps: [
          {
            permission: {
              toolCall: { toolCallId: "x", title: "rm", kind: "execute", rawInput: { command: "ls" } },
              options: [
                { optionId: "a", name: "Allow", kind: "allow_once" },
                { optionId: "r", name: "Reject", kind: "reject_once" },
              ],
            },
          },
          { say: result },
        ],
      }),
    );

    let outcome: ExternalChildOutcome | undefined;
    const d = deps({
      cwd: project,
      // This test must pass ON a CI runner, where the capability is hard-disabled
      // by design (the CI refusal is asserted above): strip the markers here.
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !CI_ENV_VARS.includes(key) && key !== ENV_KERYX_TRANSPORT),
      ),
      run: {
        config: ENABLED,
        detect: null,
        isTTY: false,
        acp: {
          argv: [process.execPath, FAKE_AGENT, scenario],
          dataDir: path.join(root, "data"),
          context: { offered: false, reason: "test" },
          mode: "trust",
        },
        onOutcome: (o) => {
          outcome = o;
        },
      },
    });
    await agentsExternalCommand(["run", "gemini-acp", "--task", "look around", "--timeout", "30000"], d);

    expect(outcome?.status).toBe("Completed");
    expect(process.exitCode).toBe(0);
    expect(outcome?.acp?.unattended).toBe(true);
    expect(outcome?.acp?.decisions[0]).toMatchObject({ verdict: "deny", reason: "unattended" });
    const text = d.lines.join("\n");
    expect(text).toContain("status: Completed");
    expect(text).toContain("agent: gemini-acp (fake-acp-agent 9.9.9)");
    expect(text).toContain("lowered from trust");
    expect(text).toContain("unattended");
    expect(text).toContain("permissions: 1 asked, 1 refused");
    expect(text).toContain("cost: missing");
    expect(text).toContain(`session: ${outcome?.acp?.sessionId ?? "?"}`);
  }, 60_000);
});

describe("AC11 — list shows the transport", () => {
  test("ACP entries are listed with transport acp, codec entries with line-stream", async () => {
    const d = deps();
    await agentsExternalCommand(["list", "--no-probe", "--json"], d);
    const doc = JSON.parse(d.lines.join("\n")) as { agents: Array<{ id: string; transport: string }> };
    expect(doc.agents.find((agent) => agent.id === "gemini-acp")?.transport).toBe("acp");
    expect(doc.agents.find((agent) => agent.id === "codex-cli")?.transport).toBe("line-stream");

    const text = deps();
    await agentsExternalCommand(["list", "--no-probe"], text);
    expect(text.lines.join("\n")).toContain("transport: acp");
  });
});

describe("flow 292 T13 — the terminal approver never leaks its readline", () => {
  function approverUnderTest(): { approver: ReturnType<typeof terminalApprover>; input: PassThrough; interfaces: Interface[]; closed: () => number } {
    const input = new PassThrough();
    const output = new PassThrough();
    const interfaces: Interface[] = [];
    let closed = 0;
    const approver = terminalApprover({
      input,
      output,
      onInterface: (rl) => {
        interfaces.push(rl);
        rl.on("close", () => {
          closed += 1;
        });
      },
    });
    return { approver, input, interfaces, closed: () => closed };
  }

  test("an answered prompt closes its readline and carries the fingerprint", async () => {
    const t = approverUnderTest();
    const answer = t.approver("acp:x", "{}", { fingerprint: "fp-1", destructive: false });
    t.input.write("y\n");
    expect(await answer).toEqual({ approved: true, fingerprint: "fp-1" });
    expect(t.closed()).toBe(1);
  });

  test("when the bridge's approval timeout wins, the readline is closed and nothing waits on stdin", async () => {
    const t = approverUnderTest();
    const { decision } = await answerAcpPermission(
      {
        requestId: 1,
        toolCall: { toolCallId: "c", kind: "edit", title: "edit" },
        options: [
          { optionId: "a", name: "Allow", kind: "allow_once" },
          { optionId: "r", name: "Reject", kind: "reject_once" },
        ],
      },
      { worktree: root, mode: clampForeignMode("ask"), unattended: false, requestApproval: t.approver, approvalTimeoutMs: 30 },
    );
    expect(decision).toMatchObject({ verdict: "deny", reason: "timeout", timedOut: true });
    expect(t.interfaces).toHaveLength(1);
    expect(t.closed()).toBe(1);
    // A late keystroke reaches nobody: the interface is gone.
    t.input.write("y\n");
    expect(t.closed()).toBe(1);
  });

  test("an already-aborted question never opens a prompt it cannot close", async () => {
    const t = approverUnderTest();
    const controller = new AbortController();
    controller.abort();
    const answer = await t.approver("acp:x", "{}", { fingerprint: "fp", destructive: false, signal: controller.signal });
    expect(answer).toEqual({ approved: false, fingerprint: "fp" });
    expect(t.closed()).toBe(1);
  });
});

describe("flow 370 — `run claude-cli --write` stores a patch for review", () => {
  function gitProject(): string {
    const project = path.join(root, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, "README.md"), "hello\n");
    const git = (args: string[]): void => {
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], {
        cwd: project,
        env: withoutGitDiscoveryOverrides(process.env),
      });
    };
    git(["init", "-q"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
    return project;
  }

  function editingSpawn(edit: (cwd: string) => void): ExternalSpawnPort {
    return {
      spawn(_argv, opts): SpawnedProcess {
        edit(opts.cwd);
        return { stdout: toLines([]), stderr: toLines([]), writeStdin: () => undefined, kill: () => undefined, exited: Promise.resolve(0) };
      },
    };
  }

  test("prints the patch path, hash, files, flagged paths and the review line, and leaves the checkout untouched", async () => {
    const project = gitProject();
    const d = deps({
      cwd: project,
      run: {
        config: ENABLED,
        detect: null,
        isTTY: false,
        dataDir: path.join(root, "data"),
        spawn: editingSpawn((cwd) => {
          writeFileSync(path.join(cwd, "README.md"), "hello\nworld\n");
          mkdirSync(path.join(cwd, ".github"), { recursive: true });
          writeFileSync(path.join(cwd, ".github", "ci.yml"), "name: x\n");
        }),
      },
    });
    await agentsExternalCommand(["run", "claude-cli", "--task", "edit the readme", "--write"], d);
    const text = d.lines.join("\n");
    expect(text).toMatch(/patch \(never applied\): .*acp-worktree\.patch/);
    expect(text).toMatch(/patch hash: sha256:[0-9a-f]{64}/);
    expect(text).toContain("modified     README.md");
    expect(text).toContain("added        .github/ci.yml");
    expect(text).toContain("flagged paths (1)");
    expect(text).toMatch(/review with: keryx agents external review [0-9a-f-]{36}/);
    expect(readFileSync(path.join(project, "README.md"), "utf8")).toBe("hello\n");
  });

  test("a run that changes nothing says so and prints no review line", async () => {
    const project = gitProject();
    const d = deps({
      cwd: project,
      run: { config: ENABLED, detect: null, isTTY: false, dataDir: path.join(root, "data"), spawn: editingSpawn(() => undefined) },
    });
    await agentsExternalCommand(["run", "claude-cli", "--task", "look", "--write"], d);
    const text = d.lines.join("\n");
    expect(text).toContain("no changes");
    expect(text).not.toContain("review with:");
  });

  test("codex-cli --write is still refused, naming claude-only", async () => {
    const agent = "codex-cli";
    const project = gitProject();
    let outcome: ExternalChildOutcome | undefined;
    const sp = fakeSpawn([]);
    await agentsExternalCommand(
      ["run", agent, "--task", "edit", "--write"],
      deps({
        cwd: project,
        run: {
          config: { ...ENABLED, agents: { [agent]: { enabled: true, model: null } } },
          detect: null,
          isTTY: false,
          spawn: sp.port,
          onOutcome: (o) => {
            outcome = o;
          },
        },
      }),
    );
    expect(outcome?.status).toBe("Denied");
    expect(outcome?.output).toContain("claude-only in this release");
    expect(sp.calls).toHaveLength(0);
    expect(process.exitCode).toBe(1);
  });
});
