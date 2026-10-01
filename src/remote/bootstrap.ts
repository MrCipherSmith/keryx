// Assemble a RemoteHub from the user's own files (flow 376, block 1).
//
// The one place that turns "token file + config file" into a running hub. It
// refuses, with a reason that names the fix and never the token, when either
// file is missing, loose or malformed; the caller (serve) decides whether that
// is fatal. Nothing here polls: `hub.start()` does that.

import { createHttpBotApi, type HttpBotApiOptions } from "./bot-api-http";
import { loadBotToken, loadRemoteConfig } from "./config";
import { RemoteHub, type RemoteHubOptions } from "./hub";
import type { BotApi } from "./types";

export interface OpenRemoteHubOptions
  extends Pick<
    RemoteHubOptions,
    | "deliver"
    | "deliverCallback"
    | "dir"
    | "now"
    | "timers"
    | "sweepIntervalMs"
    | "deliverRetryMs"
    | "pollTimeoutSec"
    | "pollBackoffMs"
    | "pollSleep"
    | "onEvent"
    | "onPollerStatus"
    | "beforeAck"
    | "machine"
  > {
  /** Replaces the real HTTP client; tests pass the in-process fake here. The token is then not read. */
  api?: BotApi;
  /** Passed to the HTTP client (tests of the client itself). */
  fetchImpl?: HttpBotApiOptions["fetchImpl"];
  baseUrl?: string;
}

export type OpenRemoteHubResult = { ok: true; hub: RemoteHub } | { ok: false; reason: string };

export type OpenBotApiResult = { ok: true; api: BotApi } | { ok: false; reason: string };

/** The Bot API client for this machine's token file, or the injected one (tests). The token never leaves this closure. */
export function openBotApi(options: Pick<OpenRemoteHubOptions, "api" | "fetchImpl" | "baseUrl" | "dir">): OpenBotApiResult {
  if (options.api !== undefined) {
    return { ok: true, api: options.api };
  }
  const token = loadBotToken(options.dir);
  if (!token.ok) {
    return { ok: false, reason: token.reason };
  }
  return {
    ok: true,
    api: createHttpBotApi({
      token: token.value,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    }),
  };
}

export function openRemoteHub(options: OpenRemoteHubOptions): OpenRemoteHubResult {
  const config = loadRemoteConfig(options.dir);
  if (!config.ok) {
    return { ok: false, reason: config.reason };
  }
  const opened = openBotApi(options);
  if (!opened.ok) {
    return { ok: false, reason: opened.reason };
  }
  const { api: _api, fetchImpl: _fetch, baseUrl: _base, ...rest } = options;
  void _api;
  void _fetch;
  void _base;
  return { ok: true, hub: new RemoteHub({ ...rest, api: opened.api, config: config.value }) };
}
