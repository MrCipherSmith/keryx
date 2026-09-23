// Flow 303 (AC7): the readline shell (both modes) and the ACP host print a
// GROUPED `/help`, not a flat list — same task-based grouping `keryx help`
// and the TUI's `/help` modal use. Wording anti-drift is already covered by
// `shell-slash-registry.test.ts`; this file covers the grouping itself.

import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, ProviderCapabilities, ProviderPort } from "../harness/provider/types";
import { acpCommandHelpText } from "../acp/commands";
import { HELP_GROUP_ORDER } from "../standard/service";
import { readlineAgentHelpText, runShell, type ShellDeps, type ShellIO } from "./shell";

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

function stubProvider(): ProviderPort {
  return {
    describe: () => ({ capabilities: NO_CAPS, descriptor: { providerId: "fake-provider" } }),
    stream: (): AsyncIterable<NormalizedEvent> => (async function* (): AsyncGenerator<NormalizedEvent> {})(),
  };
}

async function* linesFrom(...lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line;
}

async function chatOutput(...lines: string[]): Promise<string> {
  const writes: string[] = [];
  const io: ShellIO = { lines: linesFrom(...lines, "/exit"), write: (s: string) => writes.push(s) };
  const deps: ShellDeps = {
    makeProvider: stubProvider,
    clock: () => "1970-01-01T00:00:00.000Z",
    idSeq: () => "id",
    initial: { provider: "fake", model: "fixture-model" },
    selectProviderModel: async () => ({ provider: "fake", model: "fixture-model" }),
  };
  await runShell(io, deps);
  return writes.join("");
}

/** Group headers appear in ONBOARDING order — never out of order, never duplicated. */
function assertGroupOrder(text: string): void {
  let lastIndex = -1;
  let seen = 0;
  for (const group of HELP_GROUP_ORDER) {
    const idx = text.indexOf(`${group.name}:`);
    if (idx === -1) continue;
    expect(idx).toBeGreaterThan(lastIndex);
    lastIndex = idx;
    seen += 1;
  }
  // At least a couple of groups must actually be present, or this assertion
  // would pass vacuously on a surface that dropped every header.
  expect(seen).toBeGreaterThan(1);
}

describe("AC7: readline chat /help is grouped", () => {
  test("prints group headers in onboarding order", async () => {
    const output = await chatOutput("/help");
    assertGroupOrder(output);
  });
});

describe("AC7: readline agent REPL /help is grouped", () => {
  test("prints group headers in onboarding order", () => {
    assertGroupOrder(readlineAgentHelpText());
  });
});

describe("AC7: the ACP host's /help is grouped", () => {
  test("prints group headers in onboarding order", () => {
    assertGroupOrder(acpCommandHelpText());
  });

  test("still uses ACP's own editor-specific wording, not the shared table's generic summary", () => {
    const text = acpCommandHelpText();
    // The shared table's generic /model summary is "Switch the model." — ACP's
    // own wording (commands.ts) is the longer, editor-specific sentence.
    expect(text).toContain("List the models this session can run, or switch to one from the next turn");
  });

  // PR #669 review, LOW: an ACP command with no HELP_GROUPS entry used to
  // fall into an "Other" bucket the render loop never visits — it vanished
  // from the text silently. It now throws instead, naming the command.
  test("a command with no HELP_GROUPS entry throws by name, instead of silently vanishing into an unrendered bucket", () => {
    expect(() => acpCommandHelpText([{ name: "not-a-real-command", description: "made up for this test" }])).toThrow(
      /not-a-real-command.*HELP_GROUPS/,
    );
  });

  test("every REAL advertised ACP command has a HELP_GROUPS entry (the throw above never fires in production)", () => {
    expect(() => acpCommandHelpText()).not.toThrow();
  });
});
