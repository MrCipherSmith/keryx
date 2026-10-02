// Shared scripted-provider and io fixtures for the runAgentTurn tests (flow 387 review r3 F-029:
// three test files carried their own copy of the provider contract).

import type { AgentDeps, AgentIO } from "./agent";
import type { NormalizedEvent, NormalizedRequest, ProviderDescription } from "../harness/provider/types";

export type Script = Partial<NormalizedEvent>[];

/**
 * A minimal scripted ProviderPort: each `stream()` call replays the next script and records the
 * request it received. Once the scripts run out, `exhausted` decides what comes next: the last
 * script again (`"repeat-last"`, the default) or an empty stream (`"empty"`).
 */
export function scriptedProvider(
  scripts: Script[],
  opts: { exhausted?: "repeat-last" | "empty" } = {},
): { provider: AgentDeps["provider"]; requests: NormalizedRequest[] } {
  const requests: NormalizedRequest[] = [];
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
  const repeatLast = (opts.exhausted ?? "repeat-last") === "repeat-last";
  return {
    requests,
    provider: {
      describe: () => description,
      stream: (request, streamOpts) => {
        const events = scripts[requests.length] ?? (repeatLast ? scripts[scripts.length - 1] : undefined) ?? [];
        requests.push(request);
        return (async function* (): AsyncGenerator<NormalizedEvent> {
          let sequence = 0;
          for (const partial of events) {
            yield { sequence: sequence++, attemptId: streamOpts.attemptId, kind: "model_end", ...partial } as NormalizedEvent;
          }
        })();
      },
    },
  };
}

/** An io that records `onSystem` text and drops everything else. */
export function collectingIo(): { io: AgentIO; system: string[] } {
  const system: string[] = [];
  return { system, io: { write: () => {}, onSystem: (s) => system.push(s) } };
}

export function makeDeps(provider: AgentDeps["provider"], extra: Partial<AgentDeps> = {}): AgentDeps {
  let n = 0;
  return {
    provider,
    providerId: "scripted",
    modelId: "m",
    tools: [],
    systemInstruction: "sys",
    idSeq: () => `id-${n++}`,
    ...extra,
  };
}

/** One model round that issues a single tool call. */
export function callRound(id: string, name: string, input: string): Script {
  return [
    { kind: "tool_call_start", toolCallId: id, toolName: name },
    { kind: "tool_call_end", toolCallId: id, input },
    { kind: "model_end" },
  ];
}

export const okReply: Script = [{ kind: "text_delta", text: "done" }, { kind: "model_end" }];
