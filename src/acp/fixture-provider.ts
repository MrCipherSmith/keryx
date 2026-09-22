// A deterministic, offline `ProviderPort` for driving `keryx acp` end-to-end
// in a REAL subprocess (AC8), without a network call.
//
// `FakeProvider` (`../harness/provider/fake-provider.ts`) selects a transcript
// by an exact sha256 of the whole `NormalizedRequest` — system instruction,
// full tool list, message history included — which is impractical to
// hand-author against `runAgentTurn`'s real request shape from outside the
// process. This instead replays a fixture BY CALL ORDER: the Nth `stream()`
// call (across the process's lifetime) replays the Nth scripted event list —
// the same shape `commands/agent.test.ts`'s in-process `scriptedProvider`
// helper uses, just loaded from a file so a spawned CLI process can use it.
//
// Selected only via `keryx acp --fixture <path>`; never reachable from a
// production invocation (see `commands/acp.ts`).

import { readFileSync } from "node:fs";
import type {
  NormalizedEvent,
  NormalizedRequest,
  ProviderDescription,
  ProviderPort,
  StreamOptions,
} from "../harness/provider/types";

/** One scripted event: `kind` required, every other `NormalizedEvent` field optional. */
export type AcpFixtureEvent = Partial<NormalizedEvent> & Pick<NormalizedEvent, "kind">;

export interface AcpFixtureFile {
  /** `turns[N]` is what the (N+1)th `stream()` call replays. */
  readonly turns: readonly (readonly AcpFixtureEvent[])[];
}

export function loadAcpFixtureProvider(path: string): ProviderPort {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as AcpFixtureFile;
  const turns = parsed.turns;
  let call = 0;

  const description: ProviderDescription = {
    capabilities: {
      streaming: true,
      toolCalls: true,
      parallelToolCalls: false,
      structuredOutput: false,
      reasoningMetadata: true,
      promptCaching: false,
      vision: false,
      tokenCounting: false,
      modelListing: false,
    },
    descriptor: { providerId: "acp-fixture" },
  };

  return {
    describe: () => description,
    stream: (_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> => {
      const events = turns[call] ?? [];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          yield { sequence: sequence++, attemptId: opts.attemptId, ...partial };
        }
      })();
    },
  };
}
