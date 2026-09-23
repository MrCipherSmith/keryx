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
  /**
   * The models a session may switch between (flow 288). Omitted: one model,
   * `fixture-model`. A scripted `text` containing `{{model}}` is replayed with
   * the id of the model the turn actually ran — the wire-visible proof that a
   * switch took effect on the turn it should have, and not on another.
   */
  readonly models?: readonly string[];
}

export interface AcpFixture {
  readonly models: readonly string[];
  /** A provider for `modelId`. Every provider built from one fixture shares its call counter. */
  readonly providerFor: (modelId: string) => ProviderPort;
}

const MODEL_PLACEHOLDER = "{{model}}";

export function loadAcpFixture(path: string): AcpFixture {
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw) as AcpFixtureFile;
  const turns = parsed.turns;
  const models = parsed.models !== undefined && parsed.models.length > 0 ? [...parsed.models] : ["fixture-model"];
  // ONE counter for the process, whichever model's provider asks: the script
  // is ordered by turn, not by model.
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

  const providerFor = (modelId: string): ProviderPort => ({
    describe: () => description,
    stream: (_request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> => {
      const events = turns[call] ?? [];
      call += 1;
      return (async function* (): AsyncGenerator<NormalizedEvent> {
        let sequence = 0;
        for (const partial of events) {
          const text =
            typeof partial.text === "string" ? { text: partial.text.split(MODEL_PLACEHOLDER).join(modelId) } : {};
          yield { sequence: sequence++, attemptId: opts.attemptId, ...partial, ...text };
        }
      })();
    },
  });

  return { models, providerFor };
}

/** The fixture's provider for its first model — what a launch without a switch runs. */
export function loadAcpFixtureProvider(path: string): ProviderPort {
  const fixture = loadAcpFixture(path);
  return fixture.providerFor(fixture.models[0] ?? "fixture-model");
}
