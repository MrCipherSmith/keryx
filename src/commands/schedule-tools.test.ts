import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
// Flow 295 (AC7): `schedule_create` from plain language, through the REAL agent
// loop. The model is scripted. The approval must ask in EVERY permission mode,
// `auto` included, and show the card. A declined card writes and installs nothing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgentTurn, type AgentDeps, type AgentIO, type ApprovalMeta } from "./agent";
import { scheduleTools } from "./schedule-tools";
import { buildUnattendedRoster } from "./trigger-dispatch";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription, ProviderPort, StreamOptions, NormalizedRequest } from "../harness/provider/types";
import type { CommandResult, ScheduleHost } from "../trigger/install";
import { loadTriggersConfig, scheduleStorePath } from "../trigger/config";
import { UNATTENDED_EXCLUDED_TOOLS, unattendedRefusal } from "../trigger/unattended";

// Flow 295 (F1): confirming a schedule creates the per-machine signing key in keryx's
// user-global directory. Point HOME and XDG_DATA_HOME at a throwaway directory so no
// test ever writes the developer's real key.
let keyHome = "";
const savedKeyEnv = { HOME: process.env["HOME"], XDG_DATA_HOME: process.env["XDG_DATA_HOME"] };
beforeEach(async () => {
  keyHome = await mkdtemp(path.join(tmpdir(), "keryx-schedule-key-home-"));
  process.env["HOME"] = keyHome;
  process.env["XDG_DATA_HOME"] = path.join(keyHome, ".local", "share");
});
afterEach(async () => {
  for (const [name, value] of Object.entries(savedKeyEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(keyHome, { recursive: true, force: true });
});

/** A real, executable stand-in for a granted program, outside every project root. */
function fakeProgram(program: string): string {
  const dir = path.join(keyHome, "bin");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, program);
  // A real binary, not a `#!` script: drafting refuses scripts and shims (flow 295 N2).
  // `true` lives in /bin on Linux and in /usr/bin on macOS (flow 295: macOS CI).
  copyFileSync(Bun.which("true") ?? "/usr/bin/true", file);
  chmodSync(file, 0o755);
  return file;
}


const DESCRIPTION: ProviderDescription = {
  capabilities: {
    streaming: true,
    toolCalls: true,
    parallelToolCalls: false,
    structuredOutput: false,
    reasoningMetadata: false,
    promptCaching: false,
    vision: false,
    tokenCounting: false,
    modelListing: false,
  },
  descriptor: { providerId: "scripted" },
};

type Round = Partial<NormalizedEvent>[];
function scripted(rounds: Round[]): ProviderPort {
  let call = 0;
  return {
    describe: () => DESCRIPTION,
    stream: (_request: NormalizedRequest, opts: StreamOptions) => {
      const round = rounds[call] ?? [{ kind: "text_delta", text: "ok" }, { kind: "model_end" }];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of round) yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
      })();
    },
  };
}

const REQUEST = {
  name: "check-github",
  cadence: "every 4 hours",
  prompt: "Check open PRs on MrCipherSmith/keryx and summarise what needs my attention",
  rates: { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
  ceilingUsd: 0.5,
  tools: ["gh.pr.list"],
  repos: ["MrCipherSmith/keryx"],
};

let root = "";
let unitDir = "";
let hostCalls: string[] = [];

function host(): ScheduleHost {
  return {
    backend: "systemd",
    unitDir,
    user: "someone",
    invocation: { execPath: "/bin/true", scriptPath: "/bin/true" },
    run: async (command, args): Promise<CommandResult> => {
      hostCalls.push([command, ...args].join(" "));
      return command === "loginctl" ? { code: 0, stdout: "Linger=yes\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
    },
  };
}

async function turn(mode: "ask" | "trust" | "auto", answer: boolean): Promise<{ asked: { tool: string; meta: ApprovalMeta | undefined }[]; autoApproved: string[]; toolOutput: string }> {
  const tools = scheduleTools({
    projectRoot: root,
    defaults: () => ({ provider: "anthropic", model: "claude-x" }),
    host: host(),
    now: () => new Date(2026, 8, 23, 5, 7, 0),
    resolveProgram: (p) => fakeProgram(p),
    accountOf: async () => "MrCipherSmith",
  });
  const asked: { tool: string; meta: ApprovalMeta | undefined }[] = [];
  const autoApproved: string[] = [];
  const history: NormalizedMessage[] = [];
  const deps: AgentDeps = {
    provider: scripted([
      [
        { kind: "tool_call_start", toolCallId: "c1", toolName: "schedule_create" },
        { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify(REQUEST) },
        { kind: "model_end" },
      ],
    ]),
    providerId: "scripted",
    modelId: "m",
    tools,
    systemInstruction: "test",
    idSeq: (() => {
      let n = 0;
      return () => `id${n++}`;
    })(),
  };
  const io: AgentIO = {
    write: () => {},
    permissionMode: () => mode,
    readOnly: () => false,
    requestApproval: async (tool, _input, meta) => {
      asked.push({ tool, meta });
      return answer;
    },
    onAutoApproved: (tool) => {
      autoApproved.push(tool);
    },
  };
  await runAgentTurn(io, deps, history, "schedule me a task every 4 hours to check GitHub");
  const toolOutput = history.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
  return { asked, autoApproved, toolOutput };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-schedule-tool-"));
  unitDir = await mkdtemp(path.join(tmpdir(), "keryx-schedule-tool-units-"));
  hostCalls = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(unitDir, { recursive: true, force: true });
});

describe("AC7: schedule_create always asks and shows the card", () => {
  for (const mode of ["auto", "trust", "ask"] as const) {
    test(`under "${mode}", a declined card writes nothing and installs nothing`, async () => {
      const result = await turn(mode, false);
      expect(result.autoApproved).toEqual([]);
      expect(result.asked).toHaveLength(1);
      const meta = result.asked[0]!.meta!;
      expect(meta.alwaysAsk).toBe(true);
      // "credentials"-class floor: never remembered, never offered "always".
      expect(meta.card?.[0]).toBe('Schedule "check-github" — confirm to store it and install a background timer');
      expect(meta.card).toContain("cadence: 0 */4 * * * (every 4 hours)");
      expect(meta.card?.join("\n")).toContain(`  - gh.pr.list: ${path.join(keyHome, "bin", "gh")}`);
      expect(result.toolOutput).toContain("not confirmed by the operator; nothing was written or installed");
      expect(existsSync(scheduleStorePath(root))).toBe(false);
      expect(await readdir(unitDir)).toEqual([]);
      expect(hostCalls.filter((c) => c.startsWith("systemctl"))).toEqual([]);
    });
  }

  test("a confirmed card stores exactly the drafted entry and installs its timer", async () => {
    const result = await turn("auto", true);
    expect(result.toolOutput).toContain('Schedule "check-github" is stored and installed (systemd');
    const entry = loadTriggersConfig(root).triggers.find((t) => t.name === "check-github");
    expect(entry?.confirmedHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await readdir(unitDir)).length).toBe(2);
  });

  test("schedule_create is not in any unattended roster, and the floor refuses it by name", () => {
    expect(UNATTENDED_EXCLUDED_TOOLS).toContain("schedule_create");
    expect(unattendedRefusal("schedule_create", {})).toContain("is not offered to an unattended run");
    expect(buildUnattendedRoster(root).map((t) => t.definition.name)).not.toContain("schedule_create");
  });
});
