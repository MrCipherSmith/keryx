// Flow 112, T5 / AC8 + AC9: the readline surfaces are driven by the SHARED
// mode-aware registry, not by duplicated literals.
//
// `src/commands/shell.test.ts` stays untouched (AC15 pins it "unmodified"), so
// the registry-derivation and wrong-mode assertions live here. Offline and
// deterministic: `runShell` only ever sees a stub `ProviderPort` that is never
// expected to stream.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  NormalizedEvent,
  ProviderCapabilities,
  ProviderPort,
} from "../harness/provider/types";
import {
  commandsForMode,
  describeCommand,
  AGENT_SLASH_COMMANDS,
  isCommandInMode,
} from "./agent-commands";
import { readlineAgentHelpText, runAgentRepl, runShell, type ShellDeps, type ShellIO } from "./shell";
import type { AgentDeps } from "./agent";
import type { MetaprojectPort } from "../harness/tool/metaproject-port";
import { REVIEWS_EMPTY } from "../tui/reviews-inspector";

const NO_CAPS: ProviderCapabilities = {
  streaming: false,
  toolCalls: false,
  parallelToolCalls: false,
  structuredOutput: false,
  reasoningMetadata: false,
  promptCaching: false,
  vision: false,
  tokenCounting: false,
  modelListing: false,
};

/** A provider whose `stream()` is counted; a slash command must never reach it. */
function countingProvider(streamCalls: { count: number }): ProviderPort {
  return {
    describe: () => ({ capabilities: NO_CAPS, descriptor: { providerId: "fake-provider" } }),
    stream: (): AsyncIterable<NormalizedEvent> => {
      streamCalls.count++;
      return (async function* (): AsyncGenerator<NormalizedEvent> {})();
    },
  };
}

async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

/** Run the chat REPL over `lines` and return everything it wrote. */
async function chatOutput(...lines: string[]): Promise<string> {
  const streamCalls = { count: 0 };
  const writes: string[] = [];
  const io: ShellIO = {
    lines: linesFrom(...lines, "/exit"),
    write: (s: string) => writes.push(s),
  };
  const deps: ShellDeps = {
    makeProvider: () => countingProvider(streamCalls),
    clock: () => "1970-01-01T00:00:00.000Z",
    idSeq: () => "id",
    initial: { provider: "fake", model: "fixture-model" },
    // Present so `/models` / `/provider` do not take the "not available" branch.
    selectProviderModel: async () => ({ provider: "fake", model: "fixture-model" }),
  };
  await runShell(io, deps);
  expect(streamCalls.count).toBe(0); // no slash command may start a model turn
  return writes.join("");
}

describe("AC9 — the readline chat surface derives its commands from the registry", () => {
  test("/help lists EVERY chat-mode command with the registry's chat wording", async () => {
    const output = await chatOutput("/help");
    for (const option of commandsForMode("chat")) {
      expect(output).toContain(option.name);
      // The description is the registry's, resolved for chat — a duplicated
      // literal in `shell.ts` would not track a registry edit.
      expect(output).toContain(option.description);
    }
  });

  test("/help never advertises an agent-only command in chat", async () => {
    const output = await chatOutput("/help");
    for (const command of AGENT_SLASH_COMMANDS) {
      if (!isCommandInMode(command, "chat")) {
        expect(output).not.toContain(`  ${command.name} `);
      }
    }
  });

  test("every chat-mode registry command is actually handled — none falls through", async () => {
    for (const option of commandsForMode("chat")) {
      if (option.name === "/exit") {
        continue; // terminates the loop; covered by shell.test.ts
      }
      const output = await chatOutput(option.name);
      expect(output).not.toContain("Unknown command");
      expect(output).not.toContain("is only available in");
    }
  });

  test("/status dumps session and context rows and never streams", async () => {
    const output = await chatOutput("/status");
    expect(output).toContain("Session");
    expect(output).toContain("Session id");
    expect(output).toContain("Usage");
    expect(output).toContain("Context");
    expect(output).not.toContain("Unknown command");
  });

  test("/session-info and /info are not registered", async () => {
    for (const name of ["/session-info", "/info"]) {
      const output = await chatOutput(name);
      expect(output).toContain("Unknown command");
    }
  });

  test("the chat help text carries the CHAT semantics of /model and /connect (R4)", async () => {
    const output = await chatOutput("/help");
    const model = AGENT_SLASH_COMMANDS.find((c) => c.name === "/model");
    const connect = AGENT_SLASH_COMMANDS.find((c) => c.name === "/connect");
    expect(model).toBeDefined();
    expect(connect).toBeDefined();
    if (model === undefined || connect === undefined) {
      return;
    }
    expect(output).toContain(describeCommand(model, "chat"));
    expect(output).not.toContain(describeCommand(model, "agent"));
    expect(output).toContain(describeCommand(connect, "chat"));
    expect(output).not.toContain(describeCommand(connect, "agent"));
  });
});

describe("AC9 — the readline agent surface derives its commands from the registry", () => {
  test("its help text uses the registry's AGENT wording for the commands it implements", () => {
    const help = readlineAgentHelpText();
    for (const name of ["/help", "/expand", "/new", "/clear", "/compact", "/rewind", "/status", "/flows", "/exit"]) {
      const command = AGENT_SLASH_COMMANDS.find((c) => c.name === name);
      expect(command).toBeDefined();
      if (command === undefined) {
        continue;
      }
      expect(help).toContain(name);
      expect(help).toContain(describeCommand(command, "agent"));
    }
  });

  test("flow 369: /approvals is advertised with the registry's agent wording", () => {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === "/approvals");
    expect(command).toBeDefined();
    if (command === undefined) {
      return;
    }
    expect(readlineAgentHelpText()).toContain(describeCommand(command, "agent"));
    expect(commandsForMode("chat").map((c) => c.name)).not.toContain("/approvals");
  });

  test("flow 370: /external-diff is agent-only and advertised with the registry's agent wording", () => {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === "/external-diff");
    expect(command?.modes).toEqual(["agent"]);
    expect(readlineAgentHelpText()).toContain(describeCommand(command!, "agent"));
    expect(commandsForMode("chat").map((c) => c.name)).not.toContain("/external-diff");
  });

  test("it does not advertise picker-only or agent commands it cannot run", () => {
    const help = readlineAgentHelpText();
    expect(help).not.toContain("/models");
    expect(help).not.toContain("/provider");
    // Agent-mode commands with no readline equivalent (TUI pickers / blocks).
    expect(help).not.toContain("/think");
    expect(help).not.toContain("/copy");
    expect(help).not.toContain("/resume");
    expect(help).not.toContain("/sessions");
  });

  test("/rewind is agent-only, and the readline agent help advertises it with the registry wording", () => {
    const rewind = AGENT_SLASH_COMMANDS.find((c) => c.name === "/rewind");
    expect(rewind?.modes).toEqual(["agent"]);
    expect(commandsForMode("chat").map((c) => c.name)).not.toContain("/rewind");
    expect(readlineAgentHelpText()).toContain(describeCommand(rewind!, "agent"));
  });

  test("/exit carries the AGENT wording here and the CHAT wording in runShell", async () => {
    const exit = AGENT_SLASH_COMMANDS.find((c) => c.name === "/exit");
    expect(exit).toBeDefined();
    if (exit === undefined) {
      return;
    }
    expect(readlineAgentHelpText()).toContain(describeCommand(exit, "agent"));
    expect(await chatOutput("/help")).toContain(describeCommand(exit, "chat"));
  });
});

describe("/reviews — the readline equivalent of the TUI modal", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function agentOutput(...lines: string[]): Promise<string> {
    const root = mkdtempSync(path.join(tmpdir(), "keryx-reviews-repl-"));
    dirs.push(root);
    const out: string[] = [];
    const deps = {
      providerId: "scripted",
      modelId: "m",
      systemInstruction: "sys",
      provider: {
        complete: () => {
          throw new Error("a slash command must not reach the provider");
        },
      },
    } as unknown as AgentDeps;
    const port = {
      searchCode: async ({ pattern }: { pattern: string }) => ({ pattern, output: "", isError: false }),
    } as unknown as MetaprojectPort;
    await runAgentRepl(
      linesFrom(...lines, "/exit"),
      { printPrompt: () => {}, safeBoundary: undefined, write: (s) => out.push(s) },
      deps,
      port,
      { cwd: root, enabled: false },
      undefined,
      undefined,
      undefined,
      path.join(root, "config"),
    );
    return out.join("");
  }

  test("the readline agent help advertises it with the registry's wording", () => {
    const command = AGENT_SLASH_COMMANDS.find((c) => c.name === "/reviews");
    expect(command).toBeDefined();
    if (command === undefined) return;
    expect(command.modes).not.toContain("chat");
    const help = readlineAgentHelpText();
    expect(help).toContain("/reviews");
    expect(help).toContain(describeCommand(command, "agent"));
  });

  test("typed in the agent REPL it prints the metrics block and says when nothing is on record", async () => {
    const output = await agentOutput("/reviews");
    expect(output).toContain("Review metrics: 0 review(s) on 0 pull request(s).");
    expect(output).toContain("Precision: n/a");
    expect(output).toContain("Resolved before merge: n/a");
    expect(output).toContain(REVIEWS_EMPTY);
    expect(output).not.toContain("Unknown command");
  });

  test("/external-diff typed in the agent REPL lists nothing to land and points at the CLI", async () => {
    const output = await agentOutput("/external-diff");
    expect(output).toContain("Use keryx agents external review <run-id> and keryx agents external apply <run-id> in a terminal.");
    expect(output).not.toContain("Unknown command");
  });

  test("/review is a different command and is left alone", () => {
    expect(AGENT_SLASH_COMMANDS.find((c) => c.name === "/review")).toBeDefined();
    expect(AGENT_SLASH_COMMANDS.filter((c) => c.name === "/reviews")).toHaveLength(1);
  });

  test("typed in chat it is explained as agent-mode only", async () => {
    const output = await chatOutput("/reviews");
    expect(output).toContain("only available in agent mode");
    expect(output).not.toContain("Unknown command");
  });
});

describe("AC8 — an agent-only command typed in chat fails cleanly", () => {
  for (const name of ["/expand", "/think", "/copy", "/resume", "/sessions", "/rewind", "/external-diff"]) {
    test(`${name} explains that it is agent-mode only, and starts no turn`, async () => {
      const output = await chatOutput(name);
      expect(output).toContain(name);
      expect(output).toContain("only available in agent mode");
      expect(output).toContain("this is chat mode");
      // NOT the generic fallback: the user is told WHY, not just "unknown".
      expect(output).not.toContain("Unknown command");
    });
  }

  test("a genuinely unknown token still gets the plain unknown-command message", async () => {
    const output = await chatOutput("/definitely-not-a-command");
    expect(output).toContain("Unknown command: /definitely-not-a-command");
    expect(output).not.toContain("only available in");
  });

  test("the wrong-mode branch does not swallow arguments or the loop", async () => {
    const output = await chatOutput("/expand some args", "/help");
    expect(output).toContain("only available in agent mode");
    expect(output).toContain("Commands:"); // the loop continued to /help
  });
});
