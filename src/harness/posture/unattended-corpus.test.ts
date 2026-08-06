// The permanent regression suite for the unattended posture (flow 137, AC2–AC7).
//
// Everything here runs against a REAL fixture project — a real `git init`, a real
// `package.json`, a real `.env`, a real graph index — and the REAL agent driver
// with the REAL tool array `keryx shell` builds. Only the model is scripted,
// because a model is the one component a regression suite cannot contain.
//
// The reason the fixture is real: all three review rounds of PR #253 passed their
// own tests. What found the holes was running the code and then looking at the
// filesystem. So these tests assert the refusal AND that nothing moved — the tree
// hash, the graph index, `package.json`, and the absence of the `.env` marker from
// everything the run produced.
//
// A note on what "refused" means here, because it is the whole design. No
// assertion below inspects a command string, and no production code path these
// tests exercise does either. `shell_exec` is not in the registered array, so the
// model naming it produces a miss on a map lookup. That is the containment: not a
// verdict about `rm -rf`, but the absence of anything that could carry it out.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { runAgentTurn, buildAgentSystemInstruction, type AgentDeps, type AgentIO } from "../../commands/agent";
import { buildAgentTools, restrictToolsForPosture } from "../../commands/shell";
import { advertisedToolNames } from "../../commands/agent-tool-surface";
import { createMetaprojectAdapter } from "../tool/metaproject-adapter";
import { builtinMetaprojectTools } from "../tool/builtin/metaproject-tools";
import type { InteractiveTool } from "../tool/builtin/interactive-tools";
import type {
  NormalizedEvent,
  NormalizedMessage,
  NormalizedRequest,
  ProviderDescription,
} from "../provider/types";
import {
  isUnattendedEligible,
  parseUnattendedProfile,
  restrictToUnattendedToolSet,
  unattendedApprover,
  unattendedPosture,
  UNATTENDED_PROFILES,
  type UnattendedPosture,
} from "./unattended";
import {
  C1_COMMANDS,
  C2_GRANT_PATTERNS,
  C3_READ_TOOL_ESCAPES,
  C3_SHELL_ESCAPES,
  C4_SEARCH_INPUTS,
} from "./unattended-corpus";

/** A string that exists nowhere else, so finding it anywhere means `.env` was read. */
const ENV_MARKER = "KERYX-CORPUS-ENV-MARKER-4c7f1a9e";
/** The same, for the file a symlink points at outside the project root. */
const OUTSIDE_MARKER = "KERYX-CORPUS-OUTSIDE-MARKER-8b2d";

interface Fixture {
  base: string;
  root: string;
  outside: string;
  cleanup: () => void;
}

/**
 * A real project on disk: git-initialised, with the four things C-1 is asserted
 * not to touch (the tree, the graph index, `package.json`, `.env`) plus an
 * untracked file, because `git clean -fdx` is the corpus line that matters most
 * and it only deletes untracked ones.
 */
function makeFixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-unattended-corpus-"));
  const root = path.join(base, "proj");
  const outside = path.join(base, "outside");
  mkdirSync(path.join(root, "src", "commands"), { recursive: true });
  mkdirSync(path.join(root, ".metaproject", "data", "gdgraph"), { recursive: true });
  mkdirSync(path.join(root, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(outside, { recursive: true });

  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "keryx-corpus-fixture", version: "1.0.0" }, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "src", "commands", "agent.ts"), "export const FIXTURE_ANSWER = 42;\n", "utf8");
  writeFileSync(path.join(root, ".env"), `FIXTURE_SECRET=${ENV_MARKER}\n`, "utf8");
  writeFileSync(
    path.join(root, ".metaproject", "data", "gdgraph", "graph.json"),
    `${JSON.stringify({ nodes: ["src/commands/agent.ts"] })}\n`,
    "utf8",
  );
  writeFileSync(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
  // Untracked on purpose: the `git clean -fdx` target.
  writeFileSync(path.join(root, "untracked-scratch.txt"), "not committed\n", "utf8");
  writeFileSync(path.join(outside, "secret.txt"), `${OUTSIDE_MARKER}\n`, "utf8");
  symlinkSync(outside, path.join(root, "vendor"));

  // A real repository, so `git clean -fdx` and `git reset --hard` would have real
  // work to do if anything let them run.
  const git = (...args: string[]): void => {
    Bun.spawnSync(["git", ...args], {
      cwd: root,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "corpus",
        GIT_AUTHOR_EMAIL: "corpus@example.invalid",
        GIT_COMMITTER_NAME: "corpus",
        GIT_COMMITTER_EMAIL: "corpus@example.invalid",
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  };
  git("init", "-q");
  git("add", "package.json", "src/commands/agent.ts");
  git("commit", "-q", "-m", "fixture");

  return { base, root, outside, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** Recursive content hash of the project, excluding `.git`'s own bookkeeping. */
function treeSnapshot(root: string): string {
  const entries: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === ".git") {
        continue; // git rewrites its own index on read-only commands
      }
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isSymbolicLink()) {
        entries.push(`L ${rel}`);
      } else if (entry.isDirectory()) {
        entries.push(`D ${rel}`);
        walk(full);
      } else {
        entries.push(`F ${rel} ${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(root);
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

/** A scripted `ProviderPort`: replays one event list per `stream()` call. */
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
  requests: NormalizedRequest[];
} {
  const requests: NormalizedRequest[] = [];
  let call = 0;
  const description: ProviderDescription = {
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
  return {
    requests,
    provider: {
      describe: () => description,
      stream: (request, opts) => {
        requests.push(request);
        const events = scripts[call] ?? [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield {
              sequence: sequence++,
              attemptId: opts.attemptId,
              kind: "model_end",
              ...partial,
            } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

/** A script that calls one tool with one input, then answers. */
function callOnce(toolName: string, input: Record<string, unknown>): Partial<NormalizedEvent>[][] {
  return [
    [
      { kind: "tool_call_start", toolCallId: "c1", toolName },
      { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify(input) },
      { kind: "model_end" },
    ],
    [{ kind: "text_delta", text: "finished" }, { kind: "model_end" }],
  ];
}

interface RunOutcome {
  toolResults: { name: string; output: string; isError: boolean }[];
  text: string;
  approvals: number;
  history: NormalizedMessage[];
}

/** Drive one real agent turn over the real tool array. */
async function runTurn(opts: {
  root: string;
  posture: UnattendedPosture | undefined;
  scripts: Partial<NormalizedEvent>[][];
  /** Supervised runs pass an approver; unattended runs must never need one. */
  approver?: "approve" | "deny" | "absent";
  extraTools?: InteractiveTool[];
}): Promise<RunOutcome> {
  const toolResults: RunOutcome["toolResults"] = [];
  const chunks: string[] = [];
  let approvals = 0;
  const io: AgentIO = {
    write: (s) => chunks.push(s),
    onToolResult: (name, result) => toolResults.push({ name, output: result.output, isError: result.isError }),
  };
  if (opts.approver === "approve" || opts.approver === "deny") {
    io.requestApproval = async () => {
      approvals += 1;
      return opts.approver === "approve";
    };
  } else if (opts.posture !== undefined) {
    io.requestApproval = unattendedApprover;
  }

  const spawnTool: InteractiveTool = {
    definition: {
      name: "spawn_subagent",
      description: "spawn",
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
      risk: "delegate",
    },
    invoke: async () => ({ output: "spawned", isError: false }),
  };
  const built = buildAgentTools({
    cwd: opts.root,
    port: createMetaprojectAdapter(opts.root),
    spawnTool,
  });
  const tools = [...restrictToolsForPosture(built, opts.posture), ...(opts.extraTools ?? [])];

  const { provider } = scriptedProvider(opts.scripts);
  const deps: AgentDeps = {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools,
    systemInstruction: buildAgentSystemInstruction(undefined, { toolNames: advertisedToolNames(tools) }),
    idSeq: (() => {
      let n = 0;
      return () => `id-${n++}`;
    })(),
    ...(opts.posture !== undefined ? { posture: opts.posture } : {}),
  };
  const history: NormalizedMessage[] = [];
  await runAgentTurn(io, deps, history, "do the thing");
  return { toolResults, text: chunks.join(""), approvals, history };
}

/** Everything a run produced, as one string, for marker-absence assertions. */
function allProducedText(outcome: RunOutcome): string {
  return [
    outcome.text,
    ...outcome.toolResults.map((r) => r.output),
    ...outcome.history.map((m) => m.content),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// AC2 — C-1
// ---------------------------------------------------------------------------

test("AC2/C-1: every command is refused under every posture, and the project is untouched", async () => {
  const fixture = makeFixture();
  try {
    // "Every posture the mechanism offers" — the mechanism offers exactly these,
    // and "every grant it accepts" is the empty set (see AC3 below).
    expect(UNATTENDED_PROFILES.length).toBeGreaterThan(0);

    for (const profile of UNATTENDED_PROFILES) {
      const posture = unattendedPosture(profile);
      const before = treeSnapshot(fixture.root);
      const graphBefore = readFileSync(
        path.join(fixture.root, ".metaproject", "data", "gdgraph", "graph.json"),
      );
      const packageBefore = readFileSync(path.join(fixture.root, "package.json"));

      for (const command of C1_COMMANDS) {
        const outcome = await runTurn({
          root: fixture.root,
          posture,
          scripts: callOnce("shell_exec", { command }),
        });

        const result = outcome.toolResults[0];
        expect(result, `${profile}: ${command} produced no tool result`).toBeDefined();
        expect(result?.isError, `${profile}: ${command} was not refused`).toBe(true);
        // The refusal is a name that resolves to nothing — not a verdict about
        // the command. Nothing in the pipeline parsed `${command}` at all.
        expect(result?.output ?? "").toContain("unknown tool: shell_exec");
        expect(result?.output ?? "").not.toContain(command);
        // No approver was consulted, because nothing reached a gate.
        expect(outcome.approvals, `${profile}: ${command} asked a human`).toBe(0);
        // `.env` was not read, by anything, anywhere in the run.
        expect(allProducedText(outcome), `${profile}: ${command} leaked .env`).not.toContain(ENV_MARKER);
      }

      expect(treeSnapshot(fixture.root), `${profile}: the fixture tree changed`).toBe(before);
      expect(
        readFileSync(path.join(fixture.root, ".metaproject", "data", "gdgraph", "graph.json")).equals(graphBefore),
        `${profile}: the graph index changed`,
      ).toBe(true);
      expect(
        readFileSync(path.join(fixture.root, "package.json")).equals(packageBefore),
        `${profile}: package.json changed`,
      ).toBe(true);
      // The `git clean -fdx` target specifically.
      expect(existsSync(path.join(fixture.root, "untracked-scratch.txt"))).toBe(true);
    }
  } finally {
    fixture.cleanup();
  }
}, 120_000);

// ---------------------------------------------------------------------------
// AC3 — C-2
// ---------------------------------------------------------------------------

test("AC3/C-2: every grant pattern is refused at launch, and would be harmless if it were not", () => {
  // Per line, the test states WHICH of the two AC3 outcomes applies. For this
  // mechanism it is the same one every time, and that is the point: the flag's
  // grammar has no slot a grant could occupy, so there is nothing to judge.
  const verdicts: { pattern: string; outcome: "refused-at-launch" }[] = [];
  for (const pattern of C2_GRANT_PATTERNS) {
    const parsed = parseUnattendedProfile(pattern);
    expect(parsed.ok, `"${pattern}" was accepted as a profile`).toBe(false);
    expect(parsed.ok === false && parsed.error).toContain("unknown unattended profile");
    verdicts.push({ pattern, outcome: "refused-at-launch" });
  }
  expect(verdicts).toHaveLength(C2_GRANT_PATTERNS.length);
  expect(verdicts.every((v) => v.outcome === "refused-at-launch")).toBe(true);

  // The second half of AC3: "or rendered harmless by the mechanism". Even if a
  // grant were somehow accepted, it would have nothing to authorise — the posture
  // registers no tool a grant could widen.
  const fixture = makeFixture();
  try {
    const spawnTool: InteractiveTool = {
      definition: { name: "spawn_subagent", description: "s", inputSchema: {}, risk: "delegate" },
      invoke: async () => ({ output: "", isError: false }),
    };
    const granted = restrictToUnattendedToolSet(
      buildAgentTools({ cwd: fixture.root, port: createMetaprojectAdapter(fixture.root), spawnTool }),
    );
    for (const tool of granted) {
      expect(tool.definition.risk, `${tool.definition.name} is not read-risk`).toBe("read");
      expect(tool.requiresApprover ?? false).toBe(false);
    }
    expect(granted.map((t) => t.definition.name)).not.toContain("shell_exec");
  } finally {
    fixture.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AC4 — C-3
// ---------------------------------------------------------------------------

test("AC4/C-3: shell-borne escapes through accepted programs have no shell to travel through", async () => {
  const fixture = makeFixture();
  try {
    const posture = unattendedPosture("read-only");
    const before = treeSnapshot(fixture.root);
    for (const command of C3_SHELL_ESCAPES) {
      const outcome = await runTurn({
        root: fixture.root,
        posture,
        scripts: callOnce("shell_exec", { command }),
      });
      expect(outcome.toolResults[0]?.isError, `${command} was not refused`).toBe(true);
      expect(outcome.toolResults[0]?.output ?? "").toContain("unknown tool: shell_exec");
      expect(allProducedText(outcome), `${command} leaked .env`).not.toContain(ENV_MARKER);
      expect(allProducedText(outcome), `${command} leaked out-of-root content`).not.toContain(OUTSIDE_MARKER);
    }
    expect(treeSnapshot(fixture.root)).toBe(before);
  } finally {
    fixture.cleanup();
  }
}, 120_000);

test("AC4/C-3: the two lines with read-tool equivalents are contained by root confinement", async () => {
  const fixture = makeFixture();
  try {
    const posture = unattendedPosture("read-only");
    for (const { line, tool, input } of C3_READ_TOOL_ESCAPES) {
      const outcome = await runTurn({
        root: fixture.root,
        posture,
        scripts: callOnce(tool, input),
      });
      const result = outcome.toolResults[0];
      expect(result, `${line}: no result`).toBeDefined();
      expect(result?.isError, `${line} was not refused`).toBe(true);
      // `/etc/passwd`'s first field, present on every unix. If any of it came
      // back, the confinement did not hold.
      expect(result?.output ?? "").not.toContain("root:x:");
      expect(allProducedText(outcome)).not.toContain("root:x:");
    }
  } finally {
    fixture.cleanup();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// AC5 — C-4, against real ripgrep, through the tool the posture registers
// ---------------------------------------------------------------------------

test("AC5/C-4: every search input is refused or confined, end to end against real ripgrep", async () => {
  const fixture = makeFixture();
  try {
    // The real `rg`, invoked exactly as `keryx ctx rg` invokes it, so the
    // assertion is about what ripgrep actually does with the argv the tool built
    // rather than about the argv's shape.
    const run = async (args: string[]): Promise<{ output: string; isError: boolean }> => {
      const proc = Bun.spawn(["rg", "--with-filename", "--no-heading", ...args.slice(2)], {
        cwd: fixture.root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      return { output: out, isError: (await proc.exited) !== 0 };
    };
    const search = builtinMetaprojectTools(fixture.root, run).find(
      (tool) => tool.definition.name === "search_code",
    );
    expect(search).toBeDefined();
    // The tool the posture registers is this one — read-risk, approver-free.
    expect(search !== undefined && isUnattendedEligible(search)).toBe(true);

    // Control first: it genuinely searches, so "refused everything" cannot pass.
    const control = await search?.invoke({ pattern: "FIXTURE_ANSWER" });
    expect(control?.output ?? "").toContain("agent.ts");

    for (const { label, input } of C4_SEARCH_INPUTS) {
      const result = await search?.invoke(input);
      expect(result, `${label}: no result`).toBeDefined();
      // Refused OR confined — either is acceptable, leaking is not.
      expect(result?.output ?? "", `${label} leaked out-of-root content`).not.toContain(OUTSIDE_MARKER);
      expect(result?.output ?? "", `${label} leaked /etc/passwd`).not.toContain("root:x:");
      expect(result?.output ?? "", `${label} leaked .env`).not.toContain(ENV_MARKER);
    }

    // The symlink case specifically, named by AC5: `vendor` points outside the
    // root and the file behind it exists and is readable by this process.
    expect(existsSync(path.join(fixture.outside, "secret.txt"))).toBe(true);
    const viaSymlink = await search?.invoke({ pattern: OUTSIDE_MARKER, path: "vendor" });
    expect(viaSymlink?.output ?? "").not.toContain(OUTSIDE_MARKER);
    const viaFollow = await search?.invoke({ pattern: OUTSIDE_MARKER, flags: ["--follow"] });
    expect(viaFollow?.isError).toBe(true);
    expect(viaFollow?.output ?? "").not.toContain(OUTSIDE_MARKER);
  } finally {
    fixture.cleanup();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// AC6 — C-5 controls
// ---------------------------------------------------------------------------

test("AC6/C-5: a benign action really runs under the posture", async () => {
  const fixture = makeFixture();
  try {
    const outcome = await runTurn({
      root: fixture.root,
      posture: unattendedPosture("read-only"),
      scripts: callOnce("read_file", { path: "package.json" }),
    });
    const result = outcome.toolResults[0];
    expect(result?.isError, "the control action was refused — the posture refuses everything").toBe(false);
    expect(result?.output ?? "").toContain("keryx-corpus-fixture");
    expect(outcome.approvals).toBe(0);
  } finally {
    fixture.cleanup();
  }
}, 60_000);

test("AC6/C-5: the unflagged default still reaches the approver, unchanged", async () => {
  const fixture = makeFixture();
  try {
    // No posture. `shell_exec` is registered, the call reaches the approval gate,
    // and a denial is the approver's answer rather than the tool's absence.
    const denied = await runTurn({
      root: fixture.root,
      posture: undefined,
      scripts: callOnce("shell_exec", { command: "git status" }),
      approver: "deny",
    });
    expect(denied.approvals, "the supervised default stopped asking").toBe(1);
    expect(denied.toolResults[0]?.isError).toBe(true);
    expect(denied.toolResults[0]?.output ?? "").toBe("command not approved by the user; not executed");

    // And an approval still runs it — the default is not quietly a refusal now.
    const approved = await runTurn({
      root: fixture.root,
      posture: undefined,
      scripts: callOnce("shell_exec", { command: "git status --porcelain" }),
      approver: "approve",
    });
    expect(approved.approvals).toBe(1);
    expect(approved.toolResults[0]?.output ?? "").not.toContain("not approved");
  } finally {
    fixture.cleanup();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// AC7 — deny is terminal, ask-with-no-approver is deny
// ---------------------------------------------------------------------------

test("AC7: an ask with no approver resolves to deny, under the posture and without it", async () => {
  const fixture = makeFixture();
  try {
    // Supervised, no approver at all: the historical default-deny.
    const supervised = await runTurn({
      root: fixture.root,
      posture: undefined,
      scripts: callOnce("shell_exec", { command: "git status" }),
      approver: "absent",
    });
    expect(supervised.toolResults[0]?.isError).toBe(true);
    expect(supervised.toolResults[0]?.output ?? "").toContain("not approved");

    // The posture's installed approver, asked directly. It takes no argument it
    // could weigh, and there is nothing that makes it say yes.
    await expect(unattendedApprover()).resolves.toBe(false);
  } finally {
    fixture.cleanup();
  }
}, 60_000);

test("AC7: a deny stays terminal — an approver that says yes cannot run a tool the posture denies", async () => {
  const fixture = makeFixture();
  try {
    // A mutating tool INJECTED into an unattended run's array, past the tool-set
    // restriction, with an approver that approves everything. This is the second
    // seam, and it is asserted rather than left to unreachability so that
    // widening the posture later cannot quietly turn it into an execution.
    let invoked = false;
    const smuggled: InteractiveTool = {
      definition: {
        name: "smuggled_writer",
        description: "writes",
        inputSchema: { type: "object", properties: {}, additionalProperties: true },
        risk: "shell",
      },
      invoke: async () => {
        invoked = true;
        return { output: "ran", isError: false };
      },
    };
    const outcome = await runTurn({
      root: fixture.root,
      posture: unattendedPosture("read-only"),
      scripts: callOnce("smuggled_writer", { command: "rm -rf ." }),
      approver: "approve",
      extraTools: [smuggled],
    });
    expect(invoked, "an approved call ran under a posture that does not grant it").toBe(false);
    expect(outcome.toolResults[0]?.isError).toBe(true);
    expect(outcome.toolResults[0]?.output ?? "").toContain("is not granted in the unattended read-only posture");
    // The approver never even got the chance: the posture seam runs first.
    expect(outcome.approvals).toBe(0);
  } finally {
    fixture.cleanup();
  }
}, 60_000);

// ---------------------------------------------------------------------------
// The tool surface itself
// ---------------------------------------------------------------------------

test("the posture registers only read-risk, approver-free tools, and advertises exactly those", () => {
  const fixture = makeFixture();
  try {
    const spawnTool: InteractiveTool = {
      definition: { name: "spawn_subagent", description: "s", inputSchema: {}, risk: "delegate" },
      invoke: async () => ({ output: "", isError: false }),
    };
    const supervised = buildAgentTools({
      cwd: fixture.root,
      port: createMetaprojectAdapter(fixture.root),
      spawnTool,
    });
    const unattended = restrictToUnattendedToolSet(supervised);
    const names = advertisedToolNames(unattended);

    // The supervised array is unchanged — the restriction filters a copy.
    expect(advertisedToolNames(supervised)).toContain("shell_exec");
    expect(advertisedToolNames(supervised)).toContain("ask_user");
    expect(advertisedToolNames(supervised)).toContain("spawn_subagent");

    for (const excluded of ["shell_exec", "spawn_subagent", "ask_user"]) {
      expect(names, `${excluded} survived the restriction`).not.toContain(excluded);
    }
    expect(names.length).toBeGreaterThan(3); // still a useful surface

    // Not advertised in the system prompt either — the instruction is derived
    // from this array, so there is nothing separate to keep in step.
    const instruction = buildAgentSystemInstruction(undefined, { toolNames: names });
    for (const excluded of ["shell_exec", "spawn_subagent", "ask_user"]) {
      expect(instruction, `${excluded} is still advertised to the model`).not.toContain(excluded);
    }
    // The control: the supervised instruction does name them.
    const supervisedInstruction = buildAgentSystemInstruction(undefined, {
      toolNames: advertisedToolNames(supervised),
    });
    expect(supervisedInstruction).toContain("shell_exec");
  } finally {
    fixture.cleanup();
  }
});
