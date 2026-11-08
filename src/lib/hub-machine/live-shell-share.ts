import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { NormalizedMessage } from "../../harness/provider/types";
import { HISTORY_SECRET_PLACEHOLDER, qualifyingHistory } from "../../remote/history";
import {
  canShowExactApproval,
  liveShellContextHeader,
  liveShellLimits,
  liveShellChatHeader,
  liveShellStreamHeader,
  validLiveShellQuestionAnswer,
  type LiveShellCommand,
  type LiveShellContext,
  type LiveShellDecision,
  type LiveShellMessage,
  type LiveShellQuestionAnswer,
  type LiveShellUpdate,
} from "../../remote-control/live-shell";
import { parseClosedJson } from "../../remote-control/protocol";
import { looksLikeSecret, redactSensitiveText } from "../../security/service";
import { keryxConfigDir } from "../config-dir";
import { hubAccessHeaders } from "./access";
import { readBoundedResponse } from "./client";
import { listEnrollments, readMachineSecret } from "./config";
import { MachineError, machineFailure } from "./errors";

export interface LiveShellHost {
  sessionId(): string;
  isBusy(): boolean;
  turnId(): string | undefined;
  history(): readonly NormalizedMessage[];
  preview?(): string | undefined;
  submit(text: string): boolean;
  stop(turnId: string): boolean;
  notice(text: string): void;
  inspect?(): LiveShellContext;
  invoke?(name: string): { output?: string } | false | Promise<{ output?: string } | false>;
  selectModel?(candidateId: string): boolean | Promise<boolean>;
  answerApproval?(approvalId: string, decision: LiveShellDecision): boolean;
  answerQuestion?(questionId: string, answer: LiveShellQuestionAnswer): boolean;
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
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const operationIdPattern = /^[0-9a-f]{64}$/;
const commandNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
const candidateIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const pollMs = 1500;
const streamPollMs = 500;
const fullRefreshMs = 10_000;
const requestTimeoutMs = 4000;

function sharedText(input: string, max: number): string {
  const safe = looksLikeSecret(input) ? HISTORY_SECRET_PLACEHOLDER : redactSensitiveText(input);
  // eslint-disable-next-line no-control-regex -- preserve whitespace but remove terminal control bytes from shared text
  const text = safe.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, "");
  const encoded = encoder.encode(text);
  return encoded.length > max
    ? `${decoder.decode(encoded.subarray(0, max - 8)).replace(/\ufffd$/u, "")}…`
    : text;
}

function sharedPreview(input: string): string | undefined {
  // Keep the last word until it has a following word. A token split across
  // provider chunks must be checked as a whole before the Hub can see it.
  const lastWord = input.search(/(?:^|\s)\S+\s*$/u);
  if (lastWord <= 0) return undefined;
  const prefix = input.slice(0, lastWord);
  return sharedText(prefix, liveShellLimits.messageBytes);
}

function sharedContext(context: LiveShellContext, supportsChat = false): LiveShellContext {
  const { question, terminalCommands, ...remaining } = context;
  const safe: LiveShellContext = remaining;
  const { commands, model, approval } = safe;
  if (commands) safe.commands = commands.slice(0, liveShellLimits.commandCount).map(entry => ({
    name: entry.name,
    description: sharedText(entry.description, liveShellLimits.descriptionBytes),
  }));
  if (terminalCommands && supportsChat) {
    safe.terminalCommands = terminalCommands.slice(0, liveShellLimits.terminalCommandCount).map(entry => ({
      name: entry.name,
      description: sharedText(entry.description, liveShellLimits.descriptionBytes),
    }));
  }
  if (model) safe.model = { ...model, candidates: model.candidates.slice(0, liveShellLimits.candidateCount).map(entry => ({
    id: entry.id,
    label: sharedText(entry.label, liveShellLimits.descriptionBytes),
  })) };
  if (approval) {
    const tool = sharedText(approval.tool, liveShellLimits.titleBytes);
    const summary = sharedText(approval.summary, liveShellLimits.approvalSummaryBytes);
    const reason = sharedText(approval.reason, liveShellLimits.descriptionBytes);
    safe.approval = {
      ...approval, tool, summary, reason,
      canAnswer: approval.canAnswer && canShowExactApproval(summary) &&
        tool === approval.tool && summary === approval.summary && reason === approval.reason,
    };
  }
  if (question && supportsChat) {
    const body = sharedText(question.text, liveShellLimits.approvalSummaryBytes);
    let exact = body === question.text && canShowExactApproval(body) &&
      question.options.length >= 2 && question.options.length <= liveShellLimits.questionOptions;
    const options = question.options.slice(0, liveShellLimits.questionOptions).map(option => {
      const label = sharedText(option.label, liveShellLimits.descriptionBytes);
      const description = sharedText(option.description, liveShellLimits.descriptionBytes);
      exact &&= label === option.label && description === option.description && canShowExactApproval(label) &&
        (!description || canShowExactApproval(description));
      return { label, description };
    });
    safe.question = { id: question.id, text: body, options, canAnswer: question.canAnswer && exact };
  }
  return safe;
}

export function liveShellHistory(history: readonly NormalizedMessage[], turnRunning: boolean): LiveShellMessage[] {
  const items = qualifyingHistory(history.slice(-1000), { turnRunning });
  const result: LiveShellMessage[] = [];
  let bytes = 2;
  for (let i = items.length - 1; i >= 0 && result.length < liveShellLimits.messages; i--) {
    const item = items[i]!;
    const text = sharedText(item.text, liveShellLimits.messageBytes);
    if (text.trim().length === 0) continue;
    const message: LiveShellMessage = { role: item.role === "agent" ? "assistant" : "user", text };
    bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes > liveShellLimits.historyBytes) break;
    result.push(message);
  }
  return result.reverse();
}

function replyCommand(value: unknown, supportsContext: boolean, supportsChat: boolean): LiveShellCommand | null {
  if (value === null || typeof value !== "object" || !Object.hasOwn(value, "command")) throw new MachineError("invalid-live-shell-reply");
  const command = (value as { command: unknown }).command;
  if (command === null) return null;
  if (typeof command !== "object" || Array.isArray(command)) throw new MachineError("invalid-live-shell-reply");
  const fields = command as Record<string, unknown>;
  if (typeof fields.id === "string" && operationIdPattern.test(fields.id)) {
    if (fields.kind === "message" && typeof fields.text === "string" && fields.text.trim() && Buffer.byteLength(fields.text) <= liveShellLimits.messageBytes) {
      return { id: fields.id, kind: "message", text: fields.text };
    }
    if (fields.kind === "stop" && typeof fields.turnId === "string" && uuidPattern.test(fields.turnId)) {
      return { id: fields.id, kind: "stop", turnId: fields.turnId };
    }
    if (supportsContext) {
      if (supportsChat && fields.kind === "answer-question" && typeof fields.questionId === "string" &&
          uuidPattern.test(fields.questionId) && validLiveShellQuestionAnswer(fields.answer)) {
        return { id: fields.id, kind: "answer-question", questionId: fields.questionId, answer: fields.answer };
      }
      if (fields.kind === "invoke" && typeof fields.name === "string" && commandNamePattern.test(fields.name)) {
        return { id: fields.id, kind: "invoke", name: fields.name };
      }
      if (fields.kind === "select-model" && typeof fields.candidateId === "string" && candidateIdPattern.test(fields.candidateId)) {
        return { id: fields.id, kind: "select-model", candidateId: fields.candidateId };
      }
      if (fields.kind === "answer-approval" && typeof fields.approvalId === "string" &&
          uuidPattern.test(fields.approvalId) && (fields.decision === "allow" || fields.decision === "deny")) {
        return { id: fields.id, kind: "answer-approval", approvalId: fields.approvalId, decision: fields.decision };
      }
    }
  }
  throw new MachineError("invalid-live-shell-reply");
}

type Ack = NonNullable<LiveShellUpdate["ack"]>;

/** A short-lived remote projection of one native shell, with a fresh identity for every opt-in. */
export class LiveShellShare {
  readonly #sessionId: string;
  readonly #seen = new Map<string, Ack>();
  readonly #outputs: Ack[] = [];
  #active = true;
  #connected = false;
  #supportsContext = false;
  #supportsStream = false;
  #supportsChat = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #inFlight: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #applying = false;
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
      const streaming = this.#supportsStream && this.host.turnId() !== undefined && this.host.preview?.();
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.start();
      }, streaming ? streamPollMs : pollMs);
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
    const busy = this.host.isBusy();
    const rawPreview = this.#supportsStream && busy && turnId !== undefined ? this.host.preview?.() : undefined;
    const preview = rawPreview ? sharedPreview(rawPreview) : undefined;
    const messages = liveShellHistory(this.host.history(), turnId !== undefined);
    const snapshot = JSON.stringify(messages);
    const now = Date.now();
    const publish = snapshot !== this.#lastHistory || now - this.#lastFullAt >= fullRefreshMs;
    const ack = this.#ack;
    const context = this.#supportsContext ? this.host.inspect?.() : undefined;
    const wireAck = ack && !this.#supportsContext ? { id: ack.id, status: ack.status } : ack;
    const update: LiveShellUpdate = {
      projectId, checkoutId, title: `Keryx shell · ${this.#sessionId.slice(0, 8)}`, busy,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(preview ? { preview } : {}),
      ...(publish ? { messages } : {}),
      ...(context !== undefined ? { context: sharedContext(context, this.#supportsChat) } : {}),
      ...(wireAck !== undefined ? { ack: wireAck } : {}),
    };
    const response = await fetch(url, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(update),
      redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      // A downgraded Hub rejects the extra fields. An intermittent network
      // error does not drop capability or discard an undelivered result.
      if (response.status === 400 && (context !== undefined || wireAck?.output !== undefined)) {
        this.#supportsContext = false;
        this.#supportsChat = false;
      }
      if (response.status === 400 && preview !== undefined) this.#supportsStream = false;
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
    const supportsContext = response.headers.get(liveShellContextHeader) === "1";
    const supportsChat = response.headers.get(liveShellChatHeader) === "1";
    const command = replyCommand(parsed.value, supportsContext, supportsChat);
    if (!this.active) {
      void this.close();
      return;
    }
    if (!this.#connected) this.host.notice("◇ This shell is available in Team Hub. Use /remote-control hub off to disconnect it.");
    this.#connected = true;
    this.#supportsContext = supportsContext;
    this.#supportsChat = supportsChat;
    this.#supportsStream = response.headers.get(liveShellStreamHeader) === "1";
    this.#lastFailure = undefined;
    if (publish) {
      this.#lastHistory = snapshot;
      this.#lastFullAt = now;
    }
    if (this.#ack === ack) this.#ack = undefined;
    if (command !== null) this.#accept(command);
  }

  #accept(command: LiveShellCommand): void {
    const known = this.#seen.get(command.id);
    if (known !== undefined) {
      this.#ack = known;
      return;
    }
    // A model change can wait on provider setup. Keep heartbeats and lease
    // checks flowing, but allow only one local operation in flight.
    if (this.#applying) return;
    // Never evict ids during this opt-in: an unconfirmed command must not run twice.
    if (this.#seen.size >= 10_000) {
      this.#ack = { id: command.id, status: "rejected" };
      return;
    }
    this.#applying = true;
    const ack: Ack = { id: command.id, status: "rejected" };
    void this.#apply(command).then(result => {
      if (result === false) return;
      ack.status = "applied";
      if (result.output !== undefined) {
        ack.output = sharedText(result.output, liveShellLimits.outputBytes);
        this.#outputs.push(ack);
        if (this.#outputs.length > liveShellLimits.outputCount) {
          const oldest = this.#outputs.shift();
          if (oldest) delete oldest.output;
        }
      }
    }).catch(() => {
      ack.status = "rejected";
    }).finally(() => {
      this.#seen.set(command.id, ack);
      this.#ack = ack;
      this.#applying = false;
    });
  }

  async #apply(command: LiveShellCommand): Promise<{ output?: string } | false> {
    switch (command.kind) {
      case "message":
        return !this.host.isBusy() && this.host.submit(command.text) ? {} : false;
      case "stop":
        return this.host.turnId() === command.turnId && this.host.stop(command.turnId) ? {} : false;
      case "invoke":
        if (this.host.isBusy() || !this.host.inspect?.().commands?.some(entry => entry.name === command.name)) return false;
        return await this.host.invoke?.(command.name) ?? false;
      case "select-model":
        if (this.host.isBusy() || !this.host.inspect?.().model?.candidates.some(entry => entry.id === command.candidateId)) return false;
        return await this.host.selectModel?.(command.candidateId) ? {} : false;
      case "answer-approval": {
        const context = this.host.inspect?.();
        const approval = context && sharedContext(context).approval;
        return approval?.id === command.approvalId && approval.canAnswer &&
          this.host.answerApproval?.(command.approvalId, command.decision) ? {} : false;
      }
      case "answer-question": {
        const context = this.host.inspect?.();
        const question = context && sharedContext(context, true).question;
        return this.#supportsChat && question?.id === command.questionId && question.canAnswer &&
          this.host.answerQuestion?.(command.questionId, command.answer) ? {} : false;
      }
    }
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
