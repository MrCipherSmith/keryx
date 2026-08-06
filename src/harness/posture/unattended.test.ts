// The unattended posture's launch decisions, evidence, and the supervised
// default it must not disturb (flow 137, AC1 / AC6 / AC11).
//
// The corpus lives next door in `unattended-corpus.test.ts`. This file holds the
// parts that are not attacks: what the flag accepts, what it refuses before
// anything starts, what a reader of the evidence can tell afterwards, and the
// byte-level pinning of the default that AC6 exists to protect.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import {
  DEFAULT_UNATTENDED_PROFILE,
  isUnattendedEligible,
  parseUnattendedProfile,
  postureHeaderSegment,
  restrictToUnattendedToolSet,
  runPostureRecord,
  unattendedApprover,
  unattendedPosture,
  unattendedToolRefusal,
  UNATTENDED_CHAT_CONFLICT,
  UNATTENDED_NO_SELECTION,
  UNATTENDED_PROFILES,
} from "./unattended";
import {
  approvalPromptLine,
  chooseShellSurface,
  parseShellCliFlags,
  resolveUnattendedLaunch,
  shellHeaderSubtitle,
} from "../../commands/shell";
import { runAgentTurn, buildAgentSystemInstruction, type AgentDeps, type AgentIO } from "../../commands/agent";
import { builtinReadOnlyTools } from "../tool/builtin/interactive-tools";
import type { InteractiveTool } from "../tool/builtin/interactive-tools";
import { createAskUserTool } from "../tool/builtin/ask-user-tool";
import { createSession, listSessions, persistHistory } from "../../session";
import type {
  NormalizedEvent,
  NormalizedMessage,
  ProviderDescription,
} from "../provider/types";

// ---------------------------------------------------------------------------
// The flag
// ---------------------------------------------------------------------------

test("--unattended takes a profile and nothing else", () => {
  expect(parseShellCliFlags(["--unattended"]).unattendedArg).toBe(null);
  expect(parseShellCliFlags(["--unattended=read-only"]).unattendedArg).toBe("read-only");
  expect(parseShellCliFlags(["--provider", "fake"]).unattendedArg).toBeUndefined();

  // A space-separated value is NOT the profile: the next token keeps its own
  // meaning. `--unattended --provider fake` is a bare flag plus a provider, not
  // a run whose profile is "--provider". An operand whose meaning depends on the
  // flag beside it is the exact shape that turned `search_code` into a file
  // reader, and it is not reintroduced here.
  const spaced = parseShellCliFlags(["--unattended", "--provider", "fake", "--model", "m"]);
  expect(spaced.unattendedArg).toBe(null);
  expect(spaced.providerArg).toBe("fake");
});

test("an unknown profile is an error, never a fallback to the widest one", () => {
  const bare = parseUnattendedProfile(undefined);
  expect(bare.ok && bare.posture.profile).toBe(DEFAULT_UNATTENDED_PROFILE);

  for (const bad of ["", "readonly", "read only", "full", "*", "read-only ; rm -rf /"]) {
    const parsed = parseUnattendedProfile(bad);
    expect(parsed.ok, `"${bad}" was accepted`).toBe(false);
  }
  // Whitespace around a real profile is tolerated; the profile itself is exact.
  expect(parseUnattendedProfile(" read-only ").ok).toBe(true);
  expect(UNATTENDED_PROFILES).toEqual(["read-only"]);
});

test("--unattended refuses --chat, and says why", () => {
  const launch = resolveUnattendedLaunch(
    { unattendedArg: null, modeFlag: false, providerArg: "fake", modelArg: "m" },
    {},
  );
  expect(launch.ok).toBe(false);
  expect(launch.ok === false && launch.error).toBe(UNATTENDED_CHAT_CONFLICT);
});

test("--unattended resolves provider/model without a picker, or refuses to start", () => {
  // From flags.
  const fromFlags = resolveUnattendedLaunch(
    { unattendedArg: null, providerArg: "fake", modelArg: "fake-echo" },
    {},
  );
  expect(fromFlags.ok && fromFlags.posture?.label).toBe("unattended:read-only");
  expect(fromFlags.ok && fromFlags.posture !== undefined && fromFlags.selection).toEqual({
    provider: "fake",
    model: "fake-echo",
  });

  // From the saved config, when no flags were given.
  const fromSaved = resolveUnattendedLaunch({ unattendedArg: null }, { provider: "ollama", model: "q" });
  expect(fromSaved.ok && fromSaved.posture !== undefined && fromSaved.selection.provider).toBe("ollama");

  // Neither: refuse, rather than open the picker the flag exists to avoid.
  const nothing = resolveUnattendedLaunch({ unattendedArg: null }, {});
  expect(nothing.ok).toBe(false);
  expect(nothing.ok === false && nothing.error).toBe(UNATTENDED_NO_SELECTION);

  // A half-answer is not an answer.
  expect(resolveUnattendedLaunch({ unattendedArg: null, providerArg: "fake" }, {}).ok).toBe(false);

  // A saved base URL belongs to the saved provider, and does not follow a
  // provider named on the command line. Observed on the real binary before this
  // held: `--provider fake` came up pointing at the last session's gateway.
  const flagProvider = resolveUnattendedLaunch(
    { unattendedArg: null, providerArg: "fake", modelArg: "f" },
    { provider: "zai", model: "glm", baseUrl: "https://gateway.invalid" },
  );
  expect(flagProvider.ok && flagProvider.posture !== undefined && flagProvider.selection).toEqual({
    provider: "fake",
    model: "f",
  });
  // …but it does travel when the provider came from the same saved config.
  const savedProvider = resolveUnattendedLaunch(
    { unattendedArg: null },
    { provider: "zai", model: "glm", baseUrl: "https://gateway.invalid" },
  );
  expect(savedProvider.ok && savedProvider.posture !== undefined && savedProvider.selection.baseUrl).toBe(
    "https://gateway.invalid",
  );
});

test("an unattended run never launches OpenTUI, even on a TTY", () => {
  expect(chooseShellSurface({ wantTui: true, unattendedArg: null }, true)).toBe("readline");
  expect(chooseShellSurface({ wantTui: true, unattendedArg: "read-only" }, true)).toBe("readline");
  // The default is untouched.
  expect(chooseShellSurface({ wantTui: true }, true)).toBe("tui-agent");
  expect(chooseShellSurface({ wantTui: true, modeFlag: false }, true)).toBe("tui-chat");
  expect(chooseShellSurface({ wantTui: false }, true)).toBe("readline");
});

// ---------------------------------------------------------------------------
// The tool-set decision
// ---------------------------------------------------------------------------

test("eligibility is decided by the tool's own declared risk, not by its name", () => {
  const named = (name: string, risk: string | undefined): InteractiveTool => ({
    definition: {
      name,
      description: "",
      inputSchema: {},
      ...(risk !== undefined ? { risk } : {}),
    },
    invoke: async () => ({ output: "", isError: false }),
  });

  // A tool called `shell_exec` that declares itself read-risk is eligible; a tool
  // called `read_file` that declares itself shell-risk is not. The name plays no
  // part, which is what makes this not a vocabulary.
  expect(isUnattendedEligible(named("shell_exec", "read"))).toBe(true);
  expect(isUnattendedEligible(named("read_file", "shell"))).toBe(false);
  expect(isUnattendedEligible(named("anything", "delegate"))).toBe(false);
  expect(isUnattendedEligible(named("anything", "destructive"))).toBe(false);
  expect(isUnattendedEligible(named("anything", "write"))).toBe(false);
  expect(isUnattendedEligible(named("anything", "network"))).toBe(false);
  expect(isUnattendedEligible(named("anything", "credential"))).toBe(false);

  // A tool that declares NO risk fails closed: excluded until someone says what
  // it is, rather than admitted until someone notices.
  expect(isUnattendedEligible(named("undeclared", undefined))).toBe(false);
});

test("a tool that needs a person excludes itself, whatever its risk class says", () => {
  const askUser = createAskUserTool(async () => "never");
  expect(askUser.definition.risk).toBe("read");
  expect(askUser.requiresApprover).toBe(true);
  expect(isUnattendedEligible(askUser)).toBe(false);

  // Read-risk builtins with no such requirement stay.
  const kept = restrictToUnattendedToolSet([...builtinReadOnlyTools(tmpdir()), askUser]);
  expect(kept.map((t) => t.definition.name)).toEqual(["get_cwd", "list_dir", "read_file"]);
});

test("the refusal names the risk class that produced it", () => {
  expect(unattendedToolRefusal("shell_exec", "shell")).toContain("(risk shell)");
  expect(unattendedToolRefusal("mystery", undefined)).toContain("(risk undeclared)");
});

test("the posture's approver denies whatever it is handed", async () => {
  await expect(unattendedApprover()).resolves.toBe(false);
});

// ---------------------------------------------------------------------------
// AC6 — the supervised default, pinned to the byte
// ---------------------------------------------------------------------------

test("AC6: the unflagged header subtitle is byte-identical to what it always was", () => {
  // The literal below is the string the header printed before this flow existed.
  // If a change to the posture makes this fail, the change altered the default,
  // and altering the default is the cheap way to make the posture look safe.
  expect(
    shellHeaderSubtitle({
      provider: "anthropic",
      model: "claude-x",
      agentMode: true,
      cwdLabel: "~/proj",
    }),
  ).toBe("anthropic/claude-x · agent · ~/proj");

  expect(
    shellHeaderSubtitle({
      provider: "ollama",
      model: "q",
      baseUrl: "http://127.0.0.1:11434",
      agentMode: false,
      cwdLabel: "~/proj",
    }),
  ).toBe("ollama/q (http://127.0.0.1:11434) · chat · ~/proj");

  // And the posture is an ADDITION, in a fixed place, not a rewrite.
  expect(
    shellHeaderSubtitle({
      provider: "anthropic",
      model: "claude-x",
      agentMode: true,
      cwdLabel: "~/proj",
      posture: unattendedPosture("read-only"),
    }),
  ).toBe("anthropic/claude-x · agent · unattended:read-only · ~/proj");

  expect(postureHeaderSegment(undefined)).toBe("");
});

test("AC6: the supervised approval prompt is byte-identical", () => {
  // Colour is off under `bun test` (no TTY), so this is the plain form the
  // readline REPL writes. The wording, the spacing and the `[y/N] ` are the
  // contract: a scripted supervised run reads them.
  expect(approvalPromptLine("git status")).toBe("\n  Run: git status [y/N] ");
});

test("AC6: a supervised run's record carries no posture fields at all", () => {
  expect(runPostureRecord(undefined, 3)).toEqual({});
  expect(Object.keys(runPostureRecord(undefined, 0))).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// AC11 — the run record
// ---------------------------------------------------------------------------

test("AC11: the run record distinguishes an unattended run from a supervised one", () => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-posture-record-"));
  const project = path.join(base, "proj");
  const data = path.join(base, "data");
  mkdirSync(project, { recursive: true });
  try {
    const message: NormalizedMessage[] = [{ role: "user", content: "hello" }];

    const supervised = createSession({ cwd: project, dataDir: data, provider: "fake", model: "m" });
    persistHistory(supervised, message, { ...runPostureRecord(undefined, 2) });
    const supervisedSummary = JSON.parse(
      readFileSync(path.join(supervised.dir, "summary.json"), "utf8"),
    ) as Record<string, unknown>;
    expect("posture" in supervisedSummary).toBe(false);
    expect("humanInterventions" in supervisedSummary).toBe(false);

    const unattended = createSession({ cwd: project, dataDir: data, provider: "fake", model: "m" });
    persistHistory(unattended, message, {
      ...runPostureRecord(unattendedPosture("read-only"), 0),
    });
    const unattendedSummary = JSON.parse(
      readFileSync(path.join(unattended.dir, "summary.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(unattendedSummary.posture).toBe("unattended:read-only");
    expect(unattendedSummary.humanInterventions).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("AC11: the stamp survives being read back, so a resume does not launder the run", () => {
  // Without this the stamp is write-only: `listSessions` rebuilds each summary
  // field by field, and a field it does not rebuild is gone the next time
  // anything persists — so continuing an unattended session would quietly
  // relabel it supervised, which is the opposite of what AC11 is for.
  const base = mkdtempSync(path.join(tmpdir(), "keryx-posture-resume-"));
  const project = path.join(base, "proj");
  const data = path.join(base, "data");
  mkdirSync(project, { recursive: true });
  try {
    const handle = createSession({ cwd: project, dataDir: data, provider: "fake", model: "m" });
    persistHistory(handle, [{ role: "user", content: "hello" }], {
      ...runPostureRecord(unattendedPosture("read-only"), 0),
    });

    const listed = listSessions(project, data).find((s) => s.id === handle.summary.id);
    expect(listed?.posture).toBe("unattended:read-only");
    expect(listed?.humanInterventions).toBe(0);

    // And a supervised session still reads back with neither field.
    const supervised = createSession({ cwd: project, dataDir: data, provider: "fake", model: "m" });
    persistHistory(supervised, [{ role: "user", content: "hi" }], {});
    const listedSupervised = listSessions(project, data).find((s) => s.id === supervised.summary.id);
    expect(listedSupervised?.posture).toBeUndefined();
    expect(listedSupervised?.humanInterventions).toBeUndefined();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// AC1 — a scripted read-only run that finishes, with nobody there
// ---------------------------------------------------------------------------

test("AC1: a scripted read-only run answers a real project question with human_interventions: 0", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "keryx-posture-ac1-"));
  const project = path.join(base, "proj");
  const data = path.join(base, "data");
  mkdirSync(project, { recursive: true });
  try {
    // A real project fact, on disk, that the run has no way to know but to look.
    writeFileSync(
      path.join(project, "package.json"),
      `${JSON.stringify({ name: "ac1-fixture", version: "7.3.1" }, null, 2)}\n`,
      "utf8",
    );

    const posture = unattendedPosture("read-only");
    const tools = restrictToUnattendedToolSet(builtinReadOnlyTools(project));
    let humanInterventions = 0;

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
    // Round 2 answers FROM the tool result, so a wrong answer means the run did
    // not really read the file.
    let round = 0;
    let toolContent = "";
    const provider: AgentDeps["provider"] = {
      describe: () => description,
      stream: (request, opts) => {
        const events: Partial<NormalizedEvent>[] =
          round === 0
            ? [
                { kind: "tool_call_start", toolCallId: "c1", toolName: "read_file" },
                { kind: "tool_call_end", toolCallId: "c1", input: JSON.stringify({ path: "package.json" }) },
                { kind: "model_end" },
              ]
            : [
                {
                  kind: "text_delta",
                  text: `version ${
                    (JSON.parse(request.messages.find((m) => m.role === "tool")?.content ?? "{}") as {
                      version?: string;
                    }).version ?? "unknown"
                  }`,
                },
                { kind: "model_end" },
              ];
        if (round === 1) {
          toolContent = request.messages.find((m) => m.role === "tool")?.content ?? "";
        }
        round += 1;
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
    };

    const chunks: string[] = [];
    const io: AgentIO = {
      write: (s) => chunks.push(s),
      // Wired the way the shell wires it under the posture: installed, denying,
      // and counting — so `human_interventions: 0` is measured, not assumed.
      requestApproval: async () => {
        humanInterventions += 1;
        return unattendedApprover();
      },
    };
    const deps: AgentDeps = {
      provider,
      providerId: "scripted",
      modelId: "m",
      tools,
      systemInstruction: buildAgentSystemInstruction(undefined, {
        toolNames: tools.map((t) => t.definition.name),
      }),
      idSeq: (() => {
        let n = 0;
        return () => `id-${n++}`;
      })(),
      posture,
    };
    const history: NormalizedMessage[] = [];

    await runAgentTurn(io, deps, history, "what version is this project?");

    // The run finished, and it finished with the right answer — read from disk.
    expect(toolContent).toContain("7.3.1");
    expect(chunks.join("")).toContain("version 7.3.1");
    // Nobody was asked anything.
    expect(humanInterventions).toBe(0);

    // …and the record says so.
    const session = createSession({ cwd: project, dataDir: data, provider: "scripted", model: "m" });
    const persisted = persistHistory(session, history, {
      ...runPostureRecord(posture, humanInterventions),
    });
    expect(persisted.summary.posture).toBe("unattended:read-only");
    expect(persisted.summary.humanInterventions).toBe(0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}, 60_000);
