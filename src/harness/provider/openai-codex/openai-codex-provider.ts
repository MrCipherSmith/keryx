import { OpenAiProvider } from "../openai/openai-provider";
import type { NormalizedEvent, NormalizedRequest, ProviderPort, StreamOptions } from "../types";

/** A narrowly granted OAuth capability, resolved again for every model turn. */
export type OpenAiCodexAuthorize = (signal?: AbortSignal, forceRefresh?: boolean) => Promise<{ access: string; accountId: string }>;

export interface OpenAiCodexProviderDeps {
  fetch: typeof fetch;
  authorize?: OpenAiCodexAuthorize;
}

const LOGIN_HINT = "Run `keryx auth login openai-codex`.";
const isCancelled = (signal?: AbortSignal): boolean => signal?.aborted === true;

/** Subscription credential lifecycle around the shared Responses serializer/parser. */
export class OpenAiCodexProvider implements ProviderPort {
  constructor(private readonly deps: OpenAiCodexProviderDeps) {}

  describe() {
    return new OpenAiProvider({ fetch: this.deps.fetch, codex: { accountId: "" } }).describe();
  }

  async *stream(request: NormalizedRequest, opts: StreamOptions): AsyncIterable<NormalizedEvent> {
    const failure = (cancelled: boolean): NormalizedEvent => ({
      kind: "provider_error", sequence: 0, attemptId: opts.attemptId,
      error: {
        kind: cancelled ? "cancelled" : "authentication", retryable: false,
        message: cancelled ? "attempt cancelled" : `ChatGPT subscription authorization is unavailable. ${LOGIN_HINT}`,
      },
    });
    if (isCancelled(opts.signal)) {
      yield failure(true);
      return;
    }
    if (this.deps.authorize === undefined) {
      yield failure(false);
      return;
    }
    // Exactly one refresh/retry on an HTTP auth rejection, and only before any
    // event escapes. Never replay a turn after text or tools reached the caller.
    for (let attempt = 0; attempt < 2; attempt++) {
      let grant: { access: string; accountId: string };
      try {
        grant = await this.deps.authorize(opts.signal, attempt > 0);
      } catch {
        // The auth boundary may hold raw response/credential details. Never relay it.
        yield failure(isCancelled(opts.signal));
        return;
      }
      if (isCancelled(opts.signal)) {
        yield failure(true);
        return;
      }
      if (grant.access.length === 0 || grant.accountId.length === 0) {
        yield failure(false);
        return;
      }
      const provider = new OpenAiProvider({
        fetch: this.deps.fetch,
        grant: { network: true, apiKey: grant.access },
        codex: { accountId: grant.accountId },
      });
      let emitted = false;
      let retry = false;
      for await (const event of provider.stream(request, opts)) {
        if (event.error?.kind === "authentication") {
          if (attempt === 0 && !emitted) {
            retry = true;
            break;
          }
          yield { ...event, error: { ...event.error, message: `ChatGPT subscription authorization was rejected. ${LOGIN_HINT}` } };
          return;
        }
        emitted = true;
        yield event;
      }
      if (!retry) return;
    }
  }
}
