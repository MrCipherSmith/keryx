// `keryx agents external run` (flow 292, AC8/AC11).
//
// The command drives one registry ACP agent through `runExternalChild`, behind
// the same gates every external run has. Every refusal here is NAMED — a silent
// no-op would leave the operator believing an agent ran.

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CI_ENV_VARS, ENV_KERYX_TRANSPORT, EXTERNAL_AGENTS_DEFAULTS, type ExternalAgentsConfig } from "../capability/external-agents";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../harness/child/worktree";
import type { ExternalChildOutcome } from "../harness/external/runtime";
import { withoutGitDiscoveryOverrides } from "../lib/git-env";
import { agentsExternalCommand, type AgentsExternalDeps } from "./agents-external";

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

  test("a line-stream agent is not driven by `run`", async () => {
    await agentsExternalCommand(["run", "codex-cli", "--task", "look"], deps({ run: { config: ENABLED } }));
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("drives ACP agents only");
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
