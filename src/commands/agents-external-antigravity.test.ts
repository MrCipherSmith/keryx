// `keryx agents external run antigravity-cli` — the block-list and one-time
// consent gates specific to a vendor-collection agent (flow 357, AC6/AC8).
//
// Offline: process seam and worktree are both fakes, and the `/external`
// block-list + consent config both read/write a temp config dir, never the
// operator's real one.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EXTERNAL_AGENTS_DEFAULTS, hasRecordedConsent, loadExternalAgentsConfig, recordExternalAgentConsent, type ExternalAgentsConfig } from "../capability/external-agents";
import type { CreatedWorktree, WorktreeMergeResult, WorktreePort } from "../harness/child/worktree";
import type { ExternalChildOutcome } from "../harness/external/runtime";
import type { ExternalSpawnOptions, ExternalSpawnPort, SpawnedProcess } from "../harness/external/supervise";
import { agentsExternalCommand, type AgentsExternalDeps } from "./agents-external";

const ENABLED: ExternalAgentsConfig = { ...EXTERNAL_AGENTS_DEFAULTS, enabled: true };

let root = "";
let errors: string[] = [];
let errorSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "keryx-ext-agy-")));
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
        return { worktreeId: id, path: path.join(root, "wt", id) };
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

function fakeSpawn(
  stdout: readonly string[],
  exitCode = 0,
): { port: ExternalSpawnPort; calls: Array<{ argv: readonly string[]; opts: ExternalSpawnOptions }> } {
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

const AGY_TRANSCRIPT = [
  JSON.stringify({ event: "init", conversation_id: "conv-test", init: { cwd: "/wt", tools: [], permission_mode: "request-review" } }),
  JSON.stringify({ event: "result", result: { conversation_id: "conv-test", status: "SUCCESS", response: "OK\n", duration_seconds: 1, num_turns: 1, usage: { input_tokens: 1, output_tokens: 1, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 2 } } }),
];

// The binary probe is a seam: CI has neither `agy` nor `codex` installed, so a
// run that is meant to reach the spawn port must say the binary is found.
function deps(overrides: Partial<AgentsExternalDeps> = {}): AgentsExternalDeps {
  const { run, ...rest } = overrides;
  return { cwd: root, env: {}, configDir: root, run: { detect: async () => ({ binaryFound: true }), ...run }, ...rest };
}

describe("AC6: the /external block-list refuses antigravity-cli before anything spawns", () => {
  test("/external off (project override) refuses with the ExternalBlockedError message", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ external: "off" }));
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({ run: { config: ENABLED, worktree: wt.port, spawn: sp.port } }),
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("blocked by /external off");
    expect(errors.join("\n")).toContain("antigravity-cli");
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
  });

  test("/external on (default) lets the block-list step through to the consent gate", async () => {
    // No project override written — resolves to the built-in default, "on".
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({ run: { config: ENABLED, worktree: wt.port, spawn: sp.port, isTTY: false } }),
    );
    // Not blocked by /external — the refusal actually hit is consent-required.
    expect(errors.join("\n")).not.toContain("blocked by /external off");
    expect(errors.join("\n")).toContain("consent-required");
  });

  test("a different agent (no block-list entry) is unaffected by /external off", async () => {
    mkdirSync(path.join(root, ".metaproject"), { recursive: true });
    writeFileSync(path.join(root, ".metaproject", "tasks.config.json"), JSON.stringify({ external: "off" }));
    const wt = fakeWorktree();
    const sp = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    await agentsExternalCommand(["run", "codex-cli", "--task", "look"], deps({ run: { config: ENABLED, worktree: wt.port, spawn: sp.port } }));
    expect(errors.join("\n")).not.toContain("blocked by /external off");
    expect(sp.calls).toHaveLength(1);
  });
});

describe("AC6: one-time consent", () => {
  test("a non-TTY dispatch with no recorded consent is refused with consent-required, and nothing spawns", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({ run: { config: ENABLED, worktree: wt.port, spawn: sp.port, isTTY: false } }),
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("consent-required");
    expect(sp.calls).toHaveLength(0);
    expect(wt.created).toHaveLength(0);
    expect(hasRecordedConsent(loadExternalAgentsConfig(root), "antigravity-cli")).toBe(false);
  });

  test("a TTY dispatch prompts for consent, records it once accepted, and then proceeds", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    let asked = 0;
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({
        run: {
          config: ENABLED,
          worktree: wt.port,
          spawn: sp.port,
          isTTY: true,
          requestConsent: async () => {
            asked += 1;
            return true;
          },
        },
      }),
    );
    expect(asked).toBe(1);
    expect(sp.calls).toHaveLength(1);
    expect(hasRecordedConsent(loadExternalAgentsConfig(root), "antigravity-cli")).toBe(true);
  });

  test("declining consent refuses the run and records nothing", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({
        run: { config: ENABLED, worktree: wt.port, spawn: sp.port, isTTY: true, requestConsent: async () => false },
      }),
    );
    expect(process.exitCode).toBe(1);
    expect(errors.join("\n")).toContain("consent declined");
    expect(sp.calls).toHaveLength(0);
    expect(hasRecordedConsent(loadExternalAgentsConfig(root), "antigravity-cli")).toBe(false);
  });

  test("a previously recorded consent is never asked again", async () => {
    // The gate reads `config` straight from what the caller passes — pull a
    // FRESH read off disk after recording, rather than the pre-recorded
    // `ENABLED` snapshot, or the consent this test just wrote would never be
    // seen.
    recordExternalAgentConsent("antigravity-cli", "0.0.0-test", root);
    const config: ExternalAgentsConfig = { ...loadExternalAgentsConfig(root), enabled: true };
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    let asked = 0;
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({
        run: {
          config,
          worktree: wt.port,
          spawn: sp.port,
          isTTY: true,
          requestConsent: async () => {
            asked += 1;
            return true;
          },
        },
      }),
    );
    expect(asked).toBe(0);
    expect(sp.calls).toHaveLength(1);
  });

  test("codex-cli and claude-cli need no consent at all — the gate is a no-op for them", async () => {
    const wt = fakeWorktree();
    const sp = fakeSpawn([
      JSON.stringify({ type: "thread.started", thread_id: "t-1" }),
      JSON.stringify({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: "ok" } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
    ]);
    await agentsExternalCommand(
      ["run", "codex-cli", "--task", "look"],
      deps({ run: { config: ENABLED, worktree: wt.port, spawn: sp.port, isTTY: false } }),
    );
    expect(errors.join("\n")).not.toContain("consent-required");
    expect(sp.calls).toHaveLength(1);
  });
});

describe("AC8: a full read-only antigravity-cli run through the command surface", () => {
  test("with consent already recorded, the outcome carries the parsed conversation id", async () => {
    recordExternalAgentConsent("antigravity-cli", "0.0.0-test", root);
    const config: ExternalAgentsConfig = { ...loadExternalAgentsConfig(root), enabled: true };
    const wt = fakeWorktree();
    const sp = fakeSpawn(AGY_TRANSCRIPT);
    let outcome: ExternalChildOutcome | undefined;
    await agentsExternalCommand(
      ["run", "antigravity-cli", "--task", "say ok"],
      deps({
        run: {
          config,
          worktree: wt.port,
          spawn: sp.port,
          isTTY: false,
          onOutcome: (o) => {
            outcome = o;
          },
        },
      }),
    );
    expect(sp.calls[0]?.argv[0]).toBe("agy");
    expect(sp.calls[0]?.argv).toContain("--sandbox");
    expect(outcome?.sessionRef).toBe("conv-test");
  });
});
