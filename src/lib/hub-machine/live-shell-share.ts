import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { NormalizedMessage } from "../../harness/provider/types";
import { HISTORY_SECRET_PLACEHOLDER, qualifyingHistory } from "../../remote/history";
import { liveShellLimits, type LiveShellCommand, type LiveShellMessage, type LiveShellUpdate } from "../../remote-control/live-shell";
import { parseClosedJson } from "../../remote-control/protocol";
import { looksLikeSecret, redactSensitiveText } from "../../security/service";
import { keryxConfigDir } from "../config-dir";
import { hubAccessHeaders } from "./access";
import { readBoundedResponse } from "./client";
import { listEnrollments, readMachineSecret } from "./config";
import { MachineError, machineFailure } from "./errors";

export const hubShareUsage = "Usage: /remote-control hub on|off|status";
export type HubShareAction = "on" | "off" | "status" | "usage";

export function parseHubShareCommand(line: string): HubShareAction | undefined {
  const [command, target, action, ...extra] = line.trim().split(/\s+/);
  // Keep `/remote-control hub` available as a Telegram topic name.
  if (command !== "/remote-control" || target !== "hub" || action === undefined) return;
  if (extra.length === 0 && (action === "on" || action === "off" || action === "status")) return action;
  return "usage";
}

export interface LiveShellHost {
  sessionId(): string;
  isBusy(): boolean;
  turnId(): string | undefined;
  history(): readonly NormalizedMessage[];
  submit(text: string): boolean;
  stop(turnId: string): boolean;
  notice(text: string): void;
}

type Registration = {
  url: string;
  headers: Record<string, string>;
  projectId: string;
  checkoutId: string;
};

function registrationFor(cwd: string, shellId: string): Registration {
  const actualCwd = realpathSync(cwd);
  const matches = listEnrollments(keryxConfigDir()).flatMap((enrollment) =>
    enrollment.mappings.filter((mapping) => mapping.cwd === actualCwd).map((mapping) => ({ enrollment, mapping })),
  );
  if (matches.length !== 1) {
    throw new MachineError(matches.length === 0 ? "hub-checkout-not-enrolled" : "hub-checkout-ambiguous");
  }
  const { enrollment, mapping } = matches[0]!;
  return {
    url: `${enrollment.hubUrl}/hub/v2/machines/${encodeURIComponent(enrollment.machineId)}/live-shells/${shellId}`,
    headers: { ...hubAccessHeaders(enrollment.hubUrl), Authorization: `Bearer ${readMachineSecret(enrollment)}` },
    projectId: mapping.projectId,
    checkoutId: mapping.checkoutId,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const turnIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const operationIdPattern = /^[0-9a-f]{64}$/;
const pollMs = 1500;
const fullRefreshMs = 10_000;
const requestTimeoutMs = 4000;

export function liveShellHistory(history: readonly NormalizedMessage[], turnRunning: boolean): LiveShellMessage[] {
  const items = qualifyingHistory(history.slice(-1000), { turnRunning });
  const result: LiveShellMessage[] = [];
  let bytes = 2;
  for (let i = items.length - 1; i >= 0 && result.length < liveShellLimits.messages; i--) {
    const item = items[i]!;
    const safe = looksLikeSecret(item.text) ? HISTORY_SECRET_PLACEHOLDER : redactSensitiveText(item.text);
    // eslint-disable-next-line no-control-regex -- preserve whitespace but remove terminal control bytes from shared text
    const text = safe.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
    if (text.trim().length === 0) continue;
    const encoded = encoder.encode(text);
    const bounded = encoded.length > liveShellLimits.messageBytes
      ? `${decoder.decode(encoded.subarray(0, liveShellLimits.messageBytes - 8)).replace(/\ufffd$/u, "")}…`
      : text;
    const message: LiveShellMessage = { role: item.role === "agent" ? "assistant" : "user", text: bounded };
    bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes > liveShellLimits.historyBytes) break;
    result.push(message);
  }
  return result.reverse();
}

function replyCommand(value: unknown): LiveShellCommand | null {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, "command")) throw new MachineError("invalid-live-shell-reply");
  const command = (value as { command: unknown }).command;
  if (command === null) return null;
  if (typeof command !== "object") throw new MachineError("invalid-live-shell-reply");
  const fields = command as Record<string, unknown>;
  if (typeof fields.id === "string" && operationIdPattern.test(fields.id)) {
    if (fields.kind === "message" && typeof fields.text === "string" && fields.text.trim() && Buffer.byteLength(fields.text) <= liveShellLimits.messageBytes) {
      return { id: fields.id, kind: "message", text: fields.text };
    }
    if (fields.kind === "stop" && typeof fields.turnId === "string" && turnIdPattern.test(fields.turnId)) {
      return { id: fields.id, kind: "stop", turnId: fields.turnId };
    }
  }
  throw new MachineError("invalid-live-shell-reply");
}

type Ack = NonNullable<LiveShellUpdate["ack"]>;

/** A short-lived remote projection of one native shell, with a fresh identity for every opt-in. */
export class LiveShellShare {
  readonly #sessionId: string;
  readonly #seen = new Map<string, Ack["status"]>();
  #active = true;
  #connected = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #ack: Ack | undefined;
  #lastHistory = "";
  #lastFullAt = 0;
  #lastFailure: string | undefined;

  constructor(
    private readonly host: LiveShellHost,
    private readonly registration: Registration,
  ) {
    this.#sessionId = host.sessionId();
  }

  static open(cwd: string, host: LiveShellHost): LiveShellShare {
    const id = randomUUID();
    return new LiveShellShare(host, registrationFor(cwd, id));
  }

  get active(): boolean { return this.#active && this.host.sessionId() === this.#sessionId; }
  get connected(): boolean { return this.active && this.#connected; }

  start(): void {
    if (!this.#active || this.#inFlight !== undefined || this.#timer !== undefined) return;
    if (!this.active) { void this.close(); return; }
    this.#inFlight = this.#poll().catch((cause: unknown) => {
      if (!this.active) return;
      this.#connected = false;
      const { code } = machineFailure(cause, "hub-unreachable");
      if (this.#lastFailure !== code) this.host.notice(`◇ Hub sharing could not connect (${code}).`);
      this.#lastFailure = code;
    }).finally(() => {
      this.#inFlight = undefined;
      if (!this.active) return;
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.start();
      }, pollMs);
      this.#timer.unref?.();
    });
  }

  close(): Promise<void> {
    if (this.#closing !== undefined) return this.#closing;
    this.#active = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#closing = this.#detach();
    return this.#closing;
  }

  async #poll(): Promise<void> {
    const { url, headers, projectId, checkoutId } = this.registration;
    const turnId = this.host.turnId();
    const messages = liveShellHistory(this.host.history(), turnId !== undefined);
    const snapshot = JSON.stringify(messages);
    const now = Date.now();
    const publish = snapshot !== this.#lastHistory || now - this.#lastFullAt >= fullRefreshMs;
    const update: LiveShellUpdate = {
      projectId, checkoutId, title: `Keryx shell · ${this.#sessionId.slice(0, 8)}`, busy: this.host.isBusy(),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(publish ? { messages } : {}),
      ...(this.#ack !== undefined ? { ack: this.#ack } : {}),
    };
    const response = await fetch(url, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(update),
      redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403, 404, 410].includes(response.status) && this.active) {
        this.host.notice(`◇ Hub sharing ended (HTTP ${response.status}).`);
        void this.close();
        return;
      }
      throw new MachineError(`hub-http-${response.status}`);
    }
    const maxReplyBytes = liveShellLimits.updateBytes;
    const parsed = parseClosedJson(await readBoundedResponse(response, maxReplyBytes), maxReplyBytes);
    if (!parsed.ok) throw new MachineError("invalid-live-shell-reply");
    const command = replyCommand(parsed.value);
    if (!this.active) {
      void this.close();
      return;
    }
    if (!this.#connected) this.host.notice("◇ This shell is available in Team Hub. Use /remote-control hub off to disconnect it.");
    this.#connected = true;
    this.#lastFailure = undefined;
    if (publish) {
      this.#lastHistory = snapshot;
      this.#lastFullAt = now;
    }
    this.#ack = command === null ? undefined : { id: command.id, status: this.#apply(command) };
  }

  #apply(command: LiveShellCommand): Ack["status"] {
    const known = this.#seen.get(command.id);
    if (known !== undefined) return known;
    // Never evict ids during this opt-in: an unconfirmed command must not run twice.
    if (this.#seen.size >= 10_000) return "rejected";
    this.#seen.set(command.id, "rejected");
    const applied = command.kind === "message"
      ? !this.host.isBusy() && this.host.submit(command.text)
      : this.host.turnId() === command.turnId && this.host.stop(command.turnId);
    if (!applied) return "rejected";
    this.#seen.set(command.id, "applied");
    return "applied";
  }

  async #detach(): Promise<void> {
    // A request already in flight must finish before DELETE or it can recreate the advertisement.
    await this.#inFlight;
    try {
      const response = await fetch(this.registration.url, {
        method: "DELETE", headers: this.registration.headers, redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs),
      });
      await response.body?.cancel();
    } catch {
      // The server's heartbeat timeout also retires the advertisement.
    }
  }
}
