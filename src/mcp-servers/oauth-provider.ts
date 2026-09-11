// keryx's `OAuthClientProvider`, and the rule that it refuses headless.
//
// P3b. The SDK owns the protocol — discovery, PKCE, the token
// exchange, refresh — and asks an implementation of this interface
// where to keep things and how to reach a human. This is that
// implementation: storage is `credentials.ts`, the human is a browser,
// and when there is no human it says so instead of pretending.
//
// AC20 is the criterion that shapes the whole file: `keryx mcp auth`
// in a non-TTY process must exit non-zero WITHOUT opening a browser
// and without hanging. Three failures hide behind that one sentence:
//
//   - opening a browser on a server. Nobody sees it, and on a headless
//     box `xdg-open` can block or spawn something that never exits;
//   - hanging. A CI job that waits five minutes for a consent screen
//     nobody will ever click has turned a clear failure into a
//     timeout, which is the least diagnosable outcome available;
//   - reporting success. The worst: a flow that "completed" with no
//     token, so the next call fails somewhere else entirely.
//
// So interactivity is a capability passed IN, not sniffed at the point
// of use. A function that checks `process.stdout.isTTY` deep inside
// itself cannot be tested for the headless case without lying to the
// process, and the lie is what the test ends up asserting.

import { isExpired, readCredential, writeCredential, type StoredClient, type StoredTokens } from "./credentials";

/** What the SDK hands back after a successful exchange. */
export type SdkTokens = {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
};

export type BrowserOpener = (url: URL) => void | Promise<void>;

export type ProviderDeps = {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly configDir?: string | undefined;
  /**
   * Whether a human can be asked. PASSED IN, never sniffed.
   *
   * `keryx mcp auth` resolves this once from the real terminal and
   * hands it down; every other entry point passes `false`. A test can
   * therefore exercise the headless path without lying to the process
   * about its own stdio.
   */
  readonly interactive: boolean;
  readonly openBrowser?: BrowserOpener | undefined;
  /** Where the loopback listener is waiting, when one is running. */
  readonly redirectUrl?: string | undefined;
  /** The `state` that listener will accept. */
  readonly state?: string | undefined;
  /** Injected in tests. */
  readonly now?: (() => number) | undefined;
  /** A configured client id skips dynamic registration entirely. */
  readonly clientId?: string | undefined;
};

/**
 * Raised when the SDK asks for a browser and there is no human.
 *
 * A distinct type rather than a string, because the caller has to tell
 * it from a network failure: this one means "run `keryx mcp auth`",
 * and every other means "something went wrong".
 */
export class OAuthInteractionRequiredError extends Error {
  constructor(readonly serverName: string) {
    super(
      `server "${serverName}" needs OAuth and this process cannot ask: run \`keryx mcp auth ${serverName}\` in a terminal`,
    );
    this.name = "OAuthInteractionRequiredError";
  }
}

const CLIENT_NAME = "keryx";

export function createOAuthProvider(deps: ProviderDeps) {
  const now = deps.now ?? Date.now;
  const read = (): ReturnType<typeof readCredential> =>
    readCredential(deps.serverName, deps.serverUrl, deps.configDir);

  return {
    get redirectUrl(): string | undefined {
      return deps.redirectUrl;
    },

    get clientMetadata() {
      return {
        client_name: CLIENT_NAME,
        // Only the loopback callback, and only when one is listening.
        // An empty list is correct for a non-interactive provider: it
        // has nowhere to be redirected to.
        redirect_uris: deps.redirectUrl === undefined ? [] : [deps.redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },

    state(): string {
      if (deps.state === undefined) {
        // The SDK would otherwise mint its own, which the listener
        // does not know and will reject — a flow that fails at the
        // last step for a reason nobody can see.
        throw new Error("no callback listener is running; state is minted by the listener");
      }
      return deps.state;
    },

    clientInformation(): StoredClient | undefined {
      // A CONFIGURED id wins and stops dynamic registration happening
      // at all: an operator who registered the client themselves does
      // not want keryx quietly creating a second one.
      if (deps.clientId !== undefined && deps.clientId !== "") {
        return { client_id: deps.clientId };
      }
      return read().record?.client;
    },

    saveClientInformation(client: StoredClient): void {
      writeCredential(deps.serverName, deps.serverUrl, { client }, deps.configDir);
    },

    tokens(): StoredTokens | undefined {
      const stored = read().record?.tokens;
      if (stored === undefined) return undefined;
      // Expired WITHOUT a refresh token is the same as none: handing
      // it to the transport produces a 401 the operator reads as the
      // server being broken.
      if (isExpired(stored, now()) && stored.refresh_token === undefined) return undefined;
      return stored;
    },

    saveTokens(sdkTokens: SdkTokens): void {
      // `expires_in` is relative to NOW and meaningless once written,
      // so it is resolved to an absolute instant at the moment of
      // issue. Storing the relative value would make a token look
      // valid forever to whoever read the file later.
      const tokens: StoredTokens = {
        access_token: sdkTokens.access_token,
        ...(sdkTokens.token_type === undefined ? {} : { token_type: sdkTokens.token_type }),
        ...(sdkTokens.refresh_token === undefined ? {} : { refresh_token: sdkTokens.refresh_token }),
        ...(sdkTokens.scope === undefined ? {} : { scope: sdkTokens.scope }),
        ...(sdkTokens.expires_in === undefined ? {} : { expires_at: now() + sdkTokens.expires_in * 1000 }),
      };
      writeCredential(deps.serverName, deps.serverUrl, { tokens }, deps.configDir);
    },

    async redirectToAuthorization(url: URL): Promise<void> {
      // THE headless gate. Reached whenever the SDK decides a human is
      // needed, which is the only moment at which "there is no human"
      // is actually a problem — so it is the right place to refuse,
      // rather than guessing earlier from the shape of the config.
      if (!deps.interactive) throw new OAuthInteractionRequiredError(deps.serverName);
      if (deps.openBrowser === undefined) throw new OAuthInteractionRequiredError(deps.serverName);
      await deps.openBrowser(url);
    },

    saveCodeVerifier(codeVerifier: string): void {
      writeCredential(deps.serverName, deps.serverUrl, { code_verifier: codeVerifier }, deps.configDir);
    },

    codeVerifier(): string {
      const verifier = read().record?.code_verifier;
      if (verifier === undefined) {
        throw new Error("no PKCE verifier stored; the authorisation was not started by this keryx");
      }
      return verifier;
    },
  };
}
