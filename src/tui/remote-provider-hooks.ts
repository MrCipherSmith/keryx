// The provider hooks Telegram's /connect calls on the shell (flow 471, AC8).
//
// Kept apart from `tui-shell.ts` so each hook takes what it touches (the login, the fetch, the
// environment step, the clock, the time limit) as a parameter and is tested without a terminal.
//
// Whatever these return is sent to a chat, and the chat's redactor does not catch a masked
// fragment of a key ("sk-proj-****abcd", "key ending in 1a2b"). So the texts here come from a
// fixed vocabulary: a failure kind and an HTTP status, never a provider's own error text, never
// the message of a thrown error, never a token or a device code.

import type { ModelsFailure } from "../commands/providers";
import type { ProfileRefreshSummary } from "../harness/routing/model-profile";
import { catalogAllows } from "../lib/oauth/catalog";
import { applyOAuthAccessToEnv } from "../lib/oauth/grants";
import { type DeviceLoginInput, type DeviceLoginResult, loginDeviceCode } from "../lib/oauth/login";
import type { ProviderOutcome } from "../remote/command-router";

/** What a provider test says when there is nothing to authenticate with; no network call is made. */
export const NO_CREDENTIAL_TEXT = "no credential, Connect first";

/** How long a device login started from Telegram may wait for the operator to authorize it. */
export const REMOTE_DEVICE_LOGIN_LIMIT_MS = 10 * 60_000;

/** How probing one provider's `/models` ended. Carries no credential, address or response body. */
export type ProviderProbeOutcome =
  | { kind: "unknown" }
  | { kind: "no-credential" }
  | { kind: "live"; modelCount: number; profileSummary?: ProfileRefreshSummary }
  | { kind: "failed"; failure: ModelsFailure };

/** A failure as a fixed sentence: its kind and status only. The provider's `detail` is dropped on purpose. */
export function remoteFailureText(failure: ModelsFailure): string {
  switch (failure.kind) {
    case "rejected":
      return `rejected the credential (HTTP ${Number.isInteger(failure.status) ? failure.status : "error"})`;
    case "http":
      return `could not list models (HTTP ${Number.isInteger(failure.status) ? failure.status : "error"})`;
    case "unreachable":
      return "could not be reached";
    case "empty":
      return "reports no models";
  }
}

/** `[Test]` of Telegram's /connect: the probe's outcome as a chat-safe message. */
export async function testProviderForRemote(providerId: string, deps: { probe: (providerId: string) => Promise<ProviderProbeOutcome> }): Promise<ProviderOutcome> {
  const outcome = await deps.probe(providerId);
  switch (outcome.kind) {
    case "unknown":
      return { ok: false, message: "unknown provider, cannot test" };
    case "no-credential":
      return { ok: false, message: NO_CREDENTIAL_TEXT };
    case "live":
      return { ok: true, message: `ok — ${outcome.modelCount} model(s)` };
    case "failed":
      return { ok: false, message: remoteFailureText(outcome.failure) };
  }
}

export interface RemoteDeviceLoginDeps {
  /** The login itself; the real one by default. */
  login?: (input: DeviceLoginInput) => Promise<DeviceLoginResult>;
  fetch?: typeof fetch;
  /** Puts the saved token in this process's environment; the real one by default. */
  applyEnv?: (dir?: string) => void;
  /** Does the catalog offer a device login for this provider? */
  allows?: (providerId: string) => boolean;
  /** True while a turn (or anything else) holds the shell. Asked again right before the token is applied. */
  isBusy?: () => boolean;
  /** How long the login may wait. Default {@link REMOTE_DEVICE_LOGIN_LIMIT_MS}. */
  timeoutMs?: number;
  configDir?: string;
  /** Called with the connected provider's id once the token is applied (the caller drops its caches). */
  onConnected?: (providerId: string) => void;
}

export interface RemoteDeviceLogin {
  connect(providerId: string, notify: (text: string) => Promise<void>): Promise<ProviderOutcome>;
  /** End a login that is waiting (remote control went off, the shell is closing). Nothing is saved. */
  abort(): void;
  readonly running: boolean;
}

const LOGIN_FAILED_TEXT = "Device login failed; see the shell for the cause.";
const LOGIN_TIMED_OUT_TEXT = "Device login timed out; nothing was saved.";
const LOGIN_ABORTED_TEXT = "Device login was stopped; nothing was saved.";

/**
 * `[Connect]` of Telegram's /connect for a provider that offers a device login. One login at a time:
 * a second request is answered, not started. Only the user code and the link are sent to the chat
 * (both public by design); tokens go to the user-global store and no text from the login's errors
 * is passed on.
 */
export function createRemoteDeviceLogin(deps: RemoteDeviceLoginDeps = {}): RemoteDeviceLogin {
  const login = deps.login ?? loginDeviceCode;
  const applyEnv = deps.applyEnv ?? applyOAuthAccessToEnv;
  const allows = deps.allows ?? ((id: string) => catalogAllows(id, "device-code"));
  const timeoutMs = deps.timeoutMs ?? REMOTE_DEVICE_LOGIN_LIMIT_MS;
  let current: AbortController | undefined;
  let stoppedByCaller = false;

  return {
    get running(): boolean {
      return current !== undefined;
    },
    abort(): void {
      if (current !== undefined) {
        stoppedByCaller = true;
        current.abort();
      }
    },
    async connect(providerId, notify): Promise<ProviderOutcome> {
      if (!allows(providerId)) {
        return { ok: false, message: "this provider has no device login; its key is entered in the shell with /connect" };
      }
      if (current !== undefined) {
        return { ok: false, message: "a device login is already running" };
      }
      const controller = new AbortController();
      current = controller;
      stoppedByCaller = false;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const endedEarly = (): ProviderOutcome => ({ ok: false, message: timedOut ? LOGIN_TIMED_OUT_TEXT : stoppedByCaller ? LOGIN_ABORTED_TEXT : LOGIN_FAILED_TEXT });
      try {
        const result = await login({
          provider: providerId,
          fetch: (input, init) => (deps.fetch ?? globalThis.fetch)(input, init),
          signal: controller.signal,
          ...(deps.configDir !== undefined ? { dir: deps.configDir } : {}),
          onChallenge: (challenge) => {
            void notify(`Open ${challenge.verificationUri} and enter the code ${challenge.userCode}`).catch(() => undefined);
          },
        });
        if (!result.ok || controller.signal.aborted) {
          return endedEarly();
        }
        if (deps.isBusy?.() === true) {
          // A turn is running on the current provider's credentials; do not change the environment under it.
          return { ok: false, message: "signed in, but main is busy, so the login was not applied to this session; run /connect in the shell when it is idle" };
        }
        applyEnv(deps.configDir);
        deps.onConnected?.(providerId);
        return { ok: true, message: "connected. The session and model are unchanged." };
      } catch {
        return endedEarly();
      } finally {
        clearTimeout(timer);
        current = undefined;
      }
    },
  };
}

/**
 * The connected providers, computed once for a burst of calls: `/connect` asks for the connected list
 * and then for the Add list, and each would otherwise probe every provider's `/models` again.
 */
export function createConnectedProvidersCache<T extends { name: string }>(
  load: () => Promise<{ detected: T[]; connected: T[] }>,
  options: { ttlMs?: number; now?: () => number } = {},
): { get(): Promise<{ detected: T[]; connected: T[] }>; invalidate(): void } {
  const ttlMs = options.ttlMs ?? 15_000;
  const now = options.now ?? Date.now;
  let entry: { at: number; value: Promise<{ detected: T[]; connected: T[] }> } | undefined;
  return {
    get() {
      if (entry !== undefined && now() - entry.at < ttlMs) {
        return entry.value;
      }
      const value = load();
      const mine = { at: now(), value };
      entry = mine;
      // A failed load is not kept.
      value.catch(() => {
        if (entry === mine) entry = undefined;
      });
      return value;
    },
    invalidate() {
      entry = undefined;
    },
  };
}
