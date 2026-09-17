// Flow 267 (AC4): a `context_overflow` provider error surfaces a `/compact`
// suggestion. `agent.ts`'s round loop treats every provider identically once
// normalized to a `NormalizedEvent` — it never inspects which adapter (native
// OpenAI, an OpenAI-compat gateway, …) produced the event — so exercising the
// shared `formatProviderErrorMessage` helper through ONE scripted provider
// here covers both real provider paths: `openai-compat-provider.test.ts`
// separately proves the compat adapter now classifies
// `error.code === "context_length_exceeded"` as `context_overflow`, and the
// native `OpenAiProvider` already did before this flow (see
// `openai/openai-provider.ts`'s own `classifyHttpError`).

import { expect, test } from "bun:test";
import { runAgentTurn } from "./agent";
import type { AgentDeps, AgentIO } from "./agent";
import type { NormalizedEvent, NormalizedMessage, ProviderDescription } from "../harness/provider/types";

// Duplicated from `agent.test.ts` (not exported there) — see that file's own
// `scriptedProvider` doc comment.
function scriptedProvider(scripts: Partial<NormalizedEvent>[][]): {
  provider: AgentDeps["provider"];
} {
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
    provider: {
      describe: () => description,
      stream: (_request, opts) => {
        const events = scripts[call] ?? [];
        call += 1;
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield { sequence: sequence++, attemptId: opts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

let idCounter = 0;
function fixedIdSeq(): () => string {
  idCounter = 0;
  return () => `id-${idCounter++}`;
}

function collectingIo(): { io: AgentIO; system: string[] } {
  const system: string[] = [];
  return { system, io: { write: () => {}, onSystem: (s) => system.push(s) } };
}

function baseDeps(provider: AgentDeps["provider"]): AgentDeps {
  return {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: fixedIdSeq(),
  };
}

test("AC4: a context_overflow provider error surfaces a /compact suggestion", async () => {
  const { provider } = scriptedProvider([
    [{ kind: "provider_error", error: { kind: "context_overflow", retryable: false, message: "prompt too long" } }],
  ]);
  const { io, system } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runAgentTurn(io, baseDeps(provider), history, "hi");

  const errorLine = system.find((s) => s.includes("prompt too long"));
  expect(errorLine).toBeDefined();
  expect(errorLine?.toLowerCase()).toContain("/compact");
});

test("AC4: the /compact suggestion is NOT appended for a different error kind", async () => {
  const { provider } = scriptedProvider([
    [{ kind: "provider_error", error: { kind: "rate_limit", retryable: true, message: "slow down" } }],
  ]);
  const { io, system } = collectingIo();
  const history: NormalizedMessage[] = [];

  await runAgentTurn(io, baseDeps(provider), history, "hi");

  const errorLine = system.find((s) => s.includes("slow down"));
  expect(errorLine).toBeDefined();
  expect(errorLine?.toLowerCase()).not.toContain("/compact");
});
