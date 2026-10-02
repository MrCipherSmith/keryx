// The shell-side client of the channels plane of `keryx serve` (flow 377).
//
// What the /channels modal calls: connect Telegram, test it, disconnect it. A library,
// not a feature: nothing from `src/tui`.
//
// The bot token is typed once into the shell and goes exactly one place: the owner-only
// token file in the user-global directory, written HERE, atomically, by the shell itself.
// It is never put in a request, a response, a result, a reason or a log: serve reads the
// file from disk. What does travel is not secret (a pairing code, a user id, a group id,
// a machine name). Every call returns a typed result whose `reason` is plain language
// built from fixed words and serve's own messages, never from the token.
//
// Like the remote client, it finds serve by `endpoint.json`, authenticates with the local
// shell token (both re-read on every call), and talks only to a loopback address of a
// serve process that runs as this user. A pid check cannot tell serve from another
// program that took the port after serve died, so the raw token is never sent (the
// bearer is derived per request from a fresh nonce) and every answer must carry serve's
// proof for that nonce and that exact body before anything in it is used (F-002).

import { isLoopbackAddress } from "../lib/serve-config";
import { readConfigFile, writeOwnerOnlyFileAtomic } from "../lib/config-dir";
import { authority, ownProcessIsAlive } from "./client";
import {
  DEFAULT_ORPHAN_MS,
  DEFAULT_RUN_TIMEOUT_MS,
  REMOTE_CONFIG_SCHEMA_VERSION,
  removeBotToken,
  removeRemoteConfig,
  saveBotToken,
  saveRemoteConfig,
} from "./config";
import { readEndpoint } from "./endpoint";
import { botTokenPath, ensureRemoteDir, remoteConfigPath } from "./paths";
import {
  type ChannelsDisconnectResponse,
  type ChannelsReloadResponse,
  type ChannelsRoute,
  type ChannelsStatusResponse,
  type ChannelsTestResponse,
  channelsRoutePath,
  CHANNELS_ROUTE_METHODS,
  type PairingResponse,
} from "./protocol";
import { readShellToken, SERVE_PROOF_HEADER, shellRequestCredential, verifyServeResponseProof } from "./shell-token";

export interface ChannelsClientOptions {
  /** User-global directory override (the test seam). */
  dir?: string | undefined;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  /** Test seam: is the serve process named in `endpoint.json` running, as this user? */
  isAlive?: (pid: number) => boolean;
}

export type ChannelsFailureCode =
  /** No serve to talk to (not running, stale endpoint, no shell token, connection refused). */
  | "serve-down"
  /** The endpoint file names a non-loopback address: nothing was sent. */
  | "unsafe-endpoint"
  /** The input was refused locally; nothing was written. */
  | "invalid"
  /** The request may have reached serve but no answer came (a timeout, a dropped connection): the outcome is unknown. */
  | "no-answer"
  /** Anything serve refused, with serve's own code (`token-rejected`, `not-connected`, `no-pairing`, ...). */
  | (string & {});

export type ChannelsResult<T> = { ok: true; value: T } | { ok: false; code: ChannelsFailureCode; reason: string };

export interface ChannelsLocalFiles {
  /** A bot token file exists. Its content is not read here. */
  tokenFile: boolean;
  /** A remote-control config exists. */
  configFile: boolean;
}

export interface ChannelsDisconnectResult {
  deleted: number;
  /** Topics Telegram would not delete, or that serve could not reach: they stay in the group. */
  remaining: number;
  /** False when serve was down or had no running hub: the topics were not touched. */
  topicsDeleted: boolean;
  /** The token and config files are gone. */
  erased: boolean;
  /** One plain-language line for the operator. */
  message: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Failures of `channels-pair` after which serve may have taken the token or another start owns the file. */
const PAIRING_OUTCOME_UNKNOWN: ReadonlySet<string> = new Set(["no-answer", "superseded", "unexpected-response"]);
export const UNVERIFIED_SERVE_REASON =
  "The program answering on keryx serve's port did not prove it is the keryx serve this shell trusts, so its answer was ignored and nothing was written. Restart `keryx serve` (an older serve cannot prove itself; update keryx on both sides).";
/** Deleting many topics is one call per topic. */
const DISCONNECT_TIMEOUT_FACTOR = 8;

class ServeDown extends Error {
  constructor(
    readonly code: "serve-down" | "unsafe-endpoint",
    message: string,
  ) {
    super(message);
  }
}

function fileExists(file: string): boolean {
  const read = readConfigFile(file);
  return read.ok || read.reason !== "absent";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export class ChannelsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly isAlive: (pid: number) => boolean;

  constructor(private readonly options: ChannelsClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.isAlive = options.isAlive ?? ownProcessIsAlive;
  }

  /** What is on disk, without asking serve: enough to draw "not connected" when serve is down. */
  localFiles(): ChannelsLocalFiles {
    return {
      tokenFile: fileExists(botTokenPath(this.options.dir)),
      configFile: fileExists(remoteConfigPath(this.options.dir)),
    };
  }

  status(): Promise<ChannelsResult<ChannelsStatusResponse>> {
    return this.call<ChannelsStatusResponse>("channels-status", (body) => {
      const telegram = body.telegram;
      return typeof body.machine === "string" && isObject(telegram) && typeof telegram.state === "string" && typeof telegram.sessions === "number";
    });
  }

  /**
   * Step 1 of Connect. Validates the token's shape, writes it to the token file (owner-only,
   * atomically) and asks serve to open a pairing. If serve refuses, or is down, the file is put
   * back as it was: a refused token leaves nothing on disk. When the outcome is unknown (no answer,
   * superseded, an answer that does not parse) the file stays, and so does a file another shell has
   * replaced since.
   */
  async startPairing(token: string): Promise<ChannelsResult<PairingResponse>> {
    // Reach serve first: a token is not written for a serve that is not there.
    const reachable = this.reachable();
    if (!reachable.ok) {
      return reachable;
    }
    const file = botTokenPath(this.options.dir);
    const before = readConfigFile(file);
    const saved = saveBotToken(token, this.options.dir);
    if (!saved.ok) {
      return { ok: false, code: "invalid", reason: saved.reason };
    }
    const written = readConfigFile(file);
    const result = await this.call<PairingResponse>("channels-pair", isPairing);
    if (!result.ok && !PAIRING_OUTCOME_UNKNOWN.has(result.code)) {
      const now = readConfigFile(file);
      // Only a file still holding exactly what this call wrote is this call's to put back.
      if (written.ok && now.ok && now.text === written.text) {
        this.restore(file, before);
      }
    }
    return result;
  }

  pairingStatus(): Promise<ChannelsResult<PairingResponse>> {
    return this.call<PairingResponse>("channels-pairing", isPairing);
  }

  /** Abandon a pairing. A token that never became a connection is erased with it. */
  async cancelPairing(): Promise<ChannelsResult<{ cancelled: boolean }>> {
    const result = await this.call<{ cancelled: boolean }>("channels-cancel", (body) => typeof body.cancelled === "boolean");
    if (!fileExists(remoteConfigPath(this.options.dir))) {
      removeBotToken(this.options.dir);
    }
    return result;
  }

  /**
   * Step 2 of Connect: write the config from the ids Telegram reported and ask serve to start
   * the hub, with no restart. The data is checked before anything is written; if serve cannot
   * connect, the files are put back as they were (and a connection that never existed leaves
   * neither a config nor a token).
   */
  async connectFinish(ids: { userId: number; chatId: number }): Promise<ChannelsResult<ChannelsReloadResponse>> {
    const reachable = this.reachable();
    if (!reachable.ok) {
      this.dropUnusedToken();
      return reachable;
    }
    const configFile = remoteConfigPath(this.options.dir);
    const before = readConfigFile(configFile);
    const saved = saveRemoteConfig(
      {
        schemaVersion: REMOTE_CONFIG_SCHEMA_VERSION,
        chatId: ids.chatId,
        allowedUserIds: [ids.userId],
        orphanMs: DEFAULT_ORPHAN_MS,
        runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
      },
      this.options.dir,
    );
    if (!saved.ok) {
      this.dropUnusedToken();
      return { ok: false, code: "invalid", reason: saved.reason };
    }
    const result = await this.call<ChannelsReloadResponse>("channels-reload", (body) => typeof body.state === "string");
    // No answer is not a refusal: serve may have started the hub from these files, so they stay and the next status read tells the truth.
    if (!result.ok && result.code !== "no-answer") {
      this.restore(configFile, before);
      if (!before.ok) {
        removeBotToken(this.options.dir);
      }
    }
    return result;
  }

  /** Ask serve to start the hub again from the files already on disk (the channel is configured but not running). */
  reload(): Promise<ChannelsResult<ChannelsReloadResponse>> {
    return this.call<ChannelsReloadResponse>("channels-reload", (body) => typeof body.state === "string");
  }

  /** The token written for a pairing that did not become a connection: nothing is kept, so it goes. */
  private dropUnusedToken(): void {
    if (!fileExists(remoteConfigPath(this.options.dir))) {
      removeBotToken(this.options.dir);
    }
  }

  /** One message to the General topic, naming this machine. */
  test(): Promise<ChannelsResult<ChannelsTestResponse>> {
    return this.call<ChannelsTestResponse>("channels-test", (body) => body.delivered === true && typeof body.machine === "string");
  }

  /**
   * Delete every topic, stop polling, then erase the token and config. With serve down the files
   * are erased anyway and the result says the topics remain in the group.
   */
  async disconnect(): Promise<ChannelsResult<ChannelsDisconnectResult>> {
    const result = await this.call<ChannelsDisconnectResponse>(
      "channels-disconnect",
      (body) =>
        typeof body.deleted === "number" && typeof body.remaining === "number" && typeof body.hubWasRunning === "boolean",
    );
    if (!result.ok && result.code !== "serve-down") {
      // Serve refused, or may have acted and not answered (a timeout): keep the files, the connection may still be there.
      return result.code === "no-answer" ? { ...result, reason: `${result.reason} Nothing was erased on this machine.` } : result;
    }
    const erasedToken = removeBotToken(this.options.dir);
    const erasedConfig = removeRemoteConfig(this.options.dir);
    const erased = erasedToken && erasedConfig;
    const gone = erased ? "The bot token and the config were erased." : "The bot token or the config could not be erased; remove the files in the keryx remote directory by hand.";
    if (!result.ok) {
      return {
        ok: true,
        value: {
          deleted: 0,
          remaining: 0,
          topicsDeleted: false,
          erased,
          message: `keryx serve is not running, so the topics could not be deleted: they remain in the group. ${gone}`,
        },
      };
    }
    const { deleted, remaining, hubWasRunning } = result.value;
    const topics = !hubWasRunning
      ? "Telegram was not running in serve, so the topics could not be deleted: they remain in the group."
      : remaining > 0
        ? `${plural(deleted, "topic", "topics")} deleted; ${plural(remaining, "topic", "topics")} could not be deleted and remain in the group.`
        : `${plural(deleted, "topic", "topics")} deleted.`;
    return { ok: true, value: { deleted, remaining, topicsDeleted: hubWasRunning && remaining === 0, erased, message: `${topics} ${gone}` } };
  }

  // ---- requests --------------------------------------------------------------

  /** The one place a URL is built, and the one place the loopback rule is enforced. */
  private target(route: ChannelsRoute): { url: string; token: string } {
    // Token first, endpoint second: serve removes the old endpoint before it mints a token, so a new token
    // is never paired with an endpoint left over from an earlier serve.
    const token = readShellToken(this.options.dir);
    const endpoint = readEndpoint(this.options.dir);
    if (!endpoint.ok) {
      throw new ServeDown("serve-down", `keryx serve is not running (${endpoint.reason})`);
    }
    if (!isLoopbackAddress(endpoint.value.address)) {
      throw new ServeDown("unsafe-endpoint", "the serve endpoint is not a loopback address; refusing to send the shell token there");
    }
    if (!this.isAlive(endpoint.value.pid)) {
      throw new ServeDown("serve-down", `keryx serve is not running (pid ${endpoint.value.pid} is gone); start it with \`keryx serve\``);
    }
    if (!token.ok) {
      throw new ServeDown("serve-down", `keryx serve is not accepting the shell yet (${token.reason})`);
    }
    return { url: `http://${authority(endpoint.value.address, endpoint.value.port)}${channelsRoutePath(route)}`, token: token.value };
  }

  /**
   * One request. The bearer is derived from the token and a fresh nonce, never the token
   * itself; the answer is trusted only once its proof for that nonce checks out (F-002).
   */
  private async send(route: ChannelsRoute): Promise<{ response: Response; token: string; nonce: string }> {
    const { url, token } = this.target(route);
    const { nonce, bearer } = shellRequestCredential(token);
    const post = CHANNELS_ROUTE_METHODS[route] === "POST";
    const response = await this.fetchImpl(url, {
      method: post ? "POST" : "GET",
      redirect: "manual",
      headers: post ? { authorization: `Bearer ${bearer}`, "content-type": "application/json" } : { authorization: `Bearer ${bearer}` },
      ...(post ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(route === "channels-disconnect" ? this.requestTimeoutMs * DISCONNECT_TIMEOUT_FACTOR : this.requestTimeoutMs),
    });
    return { response, token, nonce };
  }

  private reachable(): { ok: true } | { ok: false; code: ChannelsFailureCode; reason: string } {
    try {
      this.target("channels-status");
      return { ok: true };
    } catch (error) {
      if (error instanceof ServeDown) {
        return { ok: false, code: error.code, reason: error.message };
      }
      throw error;
    }
  }

  private async call<T>(route: ChannelsRoute, guard: (body: Record<string, unknown>) => boolean): Promise<ChannelsResult<T>> {
    let sent: { response: Response; token: string; nonce: string };
    let text: string;
    try {
      sent = await this.send(route);
      text = await sent.response.text();
    } catch (error) {
      if (error instanceof ServeDown) {
        return { ok: false, code: error.code, reason: error.message };
      }
      if (refusedConnection(error)) {
        return { ok: false, code: "serve-down", reason: "keryx serve is not accepting connections; is it still running?" };
      }
      // The request may have been sent: a timeout or a dropped connection says nothing about what serve did.
      return {
        ok: false,
        code: "no-answer",
        reason: "keryx serve did not answer in time or dropped the connection, so the outcome is unknown. Check /channels, then retry if needed.",
      };
    }
    const { response, token, nonce } = sent;
    if (!verifyServeResponseProof(token, nonce, route, response.status, text, response.headers.get(SERVE_PROOF_HEADER))) {
      // Whatever answered is not the serve that minted this token (another program on a freed port), or a serve too old to prove itself. Nothing from it is used.
      return { ok: false, code: "unverified-serve", reason: UNVERIFIED_SERVE_REASON };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = isObject(parsed) && isObject(parsed.error) ? parsed.error : undefined;
      const code = typeof error?.code === "string" ? error.code : `http-${response.status}`;
      const message = typeof error?.message === "string" ? error.message : `keryx serve refused the request (HTTP ${response.status})`;
      return { ok: false, code, reason: message };
    }
    if (!isObject(parsed) || !guard(parsed)) {
      return { ok: false, code: "unexpected-response", reason: "keryx serve sent an answer this shell does not understand; update keryx on both sides" };
    }
    return { ok: true, value: parsed as T };
  }

  /** Put a file back as it was: its old bytes, or gone. */
  private restore(file: string, before: ReturnType<typeof readConfigFile>): void {
    try {
      if (before.ok) {
        ensureRemoteDir(this.options.dir);
        writeOwnerOnlyFileAtomic(file, before.text);
      } else if (file === botTokenPath(this.options.dir)) {
        removeBotToken(this.options.dir);
      } else {
        removeRemoteConfig(this.options.dir);
      }
    } catch {
      // Nothing more can be done from here; the reason already tells the operator what failed.
    }
  }
}

/** A failure that happened before any byte reached serve: nothing was sent, so nothing was done. */
function refusedConnection(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current: unknown = error; isObject(current) || current instanceof Error; ) {
    if (seen.has(current)) break;
    seen.add(current);
    const { code, message, cause } = current as { code?: unknown; message?: unknown; cause?: unknown };
    if (code === "ECONNREFUSED" || code === "ConnectionRefused" || code === "EHOSTUNREACH" || code === "ENETUNREACH") return true;
    if (typeof message === "string" && /ECONNREFUSED|Unable to connect|connection refused/i.test(message)) return true;
    current = cause;
  }
  return false;
}

function isPairing(body: Record<string, unknown>): boolean {
  return typeof body.state === "string" && typeof body.expiresAt === "number" && Array.isArray(body.problems);
}
