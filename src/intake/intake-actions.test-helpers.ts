// Flow 403 (T8/T9): test support for cards and decisions. Nothing here starts keryx, reads the operator's project
// registry or touches a network: the flow runner, the ci-triage runner, the project finder, the model and the Bot
// API are all fakes injected through the same seams production uses.

import type { IntakeCallbackPress } from "../remote/hub";
import type { SentMessageInfo } from "../remote/outbound-queue";
import type { InlineKeyboard } from "../remote/types";
import type { ServiceSendResult } from "../remote/hub";
import { cardIdFor, appendIntakeRecord, registerIntakeCard } from "./store";
import { intakeCallbackData } from "./card";
import type { IntakeActionDeps } from "./actions";
import type { IntakeCiTriageInput, IntakeCiTriagePort, IntakeCiTriageResult, IntakeFlowInit, IntakeFlowInput, IntakeFlowPort } from "./ports";
import type { IntakePressHub } from "./press";
import { INTAKE_ACTIONS_BY_KIND, type IntakeAction, type IntakeCardContent, type IntakeCardKind, type IntakeEventKind } from "./types";
import { OTHER_REPO, REPO, local } from "./intake.test-helpers";

export const PROJECT = "/fake/projects/keryx";
export const CHAT_ID = -1001234567890;
export const THREAD_ID = 77;
export const OWNER = 4242;

export interface FlowRecord {
  readonly project: string;
  readonly flowId: string;
  readonly dir: string;
  readonly source: string;
  readonly input: IntakeFlowInput;
  readonly journal: { at: string; line: string }[];
  readonly description: string[];
}

/** A `keryx flow` runner in memory. A failed init leaves nothing behind; `gate` holds an init open. */
export class FakeFlows implements IntakeFlowPort {
  readonly flows: FlowRecord[] = [];
  readonly initCalls: { project: string; input: IntakeFlowInput }[] = [];
  failWith: string | undefined;
  /** When set, `init` waits for it before it creates anything. */
  gate: Promise<void> | undefined;
  /** When set, `init` creates the flow and then throws, the way a process dying after the work would. */
  dieAfterCreate = false;
  private next = 412;

  async init(project: string, input: IntakeFlowInput): Promise<IntakeFlowInit> {
    this.initCalls.push({ project, input });
    if (this.gate !== undefined) await this.gate;
    if (this.failWith !== undefined) return { ok: false, reason: this.failWith };
    const flowId = String(this.next++);
    const dir = `${flowId}-2026-10-05-from-card`;
    this.flows.push({ project, flowId, dir, source: input.source, input, journal: [], description: [] });
    if (this.dieAfterCreate) throw new Error("the process died");
    return { ok: true, flowId, dir };
  }

  async findByCard(project: string, cardId: string): Promise<{ flowId: string; dir: string } | undefined> {
    const found = this.flows.find((f) => f.project === project && f.source.includes(cardId));
    return found === undefined ? undefined : { flowId: found.flowId, dir: found.dir };
  }

  async journal(project: string, dir: string, at: string, line: string): Promise<void> {
    this.flows.find((f) => f.project === project && f.dir === dir)?.journal.push({ at, line });
  }

  async appendDescription(project: string, dir: string, text: string): Promise<void> {
    this.flows.find((f) => f.project === project && f.dir === dir)?.description.push(text);
  }
}

export class FakeCiTriage implements IntakeCiTriagePort {
  readonly calls: { project: string; input: IntakeCiTriageInput }[] = [];
  result: IntakeCiTriageResult = { ok: true, output: "The failing step is `bun test`: a timeout in src/x.test.ts" };

  async run(project: string, input: IntakeCiTriageInput): Promise<IntakeCiTriageResult> {
    this.calls.push({ project, input });
    return this.result;
  }
}

/** The part of the hub the press handler uses: every edit and every topic message is recorded. */
export class FakePressHub implements IntakePressHub {
  readonly edits: { chatId: number; messageId: number; text: string; keyboard?: InlineKeyboard }[] = [];
  readonly sends: { topic: string; text: string; keyboard?: InlineKeyboard }[] = [];
  editOk = true;
  private n = 500;

  async editServiceMessage(chatId: number, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    if (this.editOk) this.edits.push({ chatId, messageId, text, ...(keyboard !== undefined ? { keyboard } : {}) });
    return this.editOk;
  }

  async sendToServiceTopic(topic: string, text: string, options?: { keyboard?: InlineKeyboard; onSent?: (info: SentMessageInfo) => void }): Promise<ServiceSendResult> {
    this.sends.push({ topic, text, ...(options?.keyboard !== undefined ? { keyboard: options.keyboard } : {}) });
    const messageId = ++this.n;
    options?.onSent?.({ chatId: CHAT_ID, messageId, threadId: THREAD_ID, text });
    return { ok: true, state: "sent", threadId: THREAD_ID };
  }
}

export interface Fakes {
  readonly flows: FakeFlows;
  readonly ci: FakeCiTriage;
  readonly deps: IntakeActionDeps;
}

/** `projectFor` knows only the project of `REPO`; every other repository has no clone. */
export function makeFakes(projects: Record<string, string> = { [REPO]: PROJECT }): Fakes {
  const flows = new FakeFlows();
  const ci = new FakeCiTriage();
  return { flows, ci, deps: { flows, ciTriage: ci, projectFor: (repo) => projects[repo] } };
}

export interface SeedOptions {
  readonly kind?: IntakeEventKind;
  readonly repo?: string;
  readonly ref?: string;
  readonly title?: string;
  readonly url?: string;
  readonly assessment?: string;
  readonly suggestion?: IntakeAction;
  readonly takeAllowed?: boolean;
  readonly account?: "work" | "personal";
  readonly createdAt?: Date;
  readonly ttlHours?: number;
  /** `sent` with these ids, or `queued` (no message yet) with `delivered: false`. */
  readonly delivered?: boolean;
  readonly messageId?: number;
  /** `sent` with no message ids, the way a card the durable queue delivered later is recorded. */
  readonly withoutIds?: boolean;
}

export interface SeededCard {
  readonly id: string;
  readonly content: IntakeCardContent;
  readonly messageId: number;
}

let seq = 0;

/** A card in the registry, with a `sent` record the way the poll leaves it after Telegram took the card. */
export async function seedCard(root: string, options: SeedOptions = {}): Promise<SeededCard> {
  const kind: IntakeEventKind = options.kind ?? "issue";
  const repo = options.repo ?? REPO;
  const ref = options.ref ?? (kind === "ci" ? "9001" : String(100 + ++seq));
  const created = options.createdAt ?? local(10, 0);
  const path = kind === "issue" ? "issues" : kind === "ci" ? "actions/runs" : "pull";
  const eventKey = kind === "ci" ? `ci:${repo}:${ref}` : `${kind}:${repo}#${ref}`;
  const id = cardIdFor(eventKey, created.toISOString());
  const actions = INTAKE_ACTIONS_BY_KIND[kind].filter((a) => a !== "take" || (options.takeAllowed ?? true));
  const content: IntakeCardContent = {
    id,
    eventKey,
    stamp: created.toISOString(),
    kind: kind as IntakeCardKind,
    repo,
    ref,
    title: options.title ?? `Title of ${kind} ${ref}`,
    url: options.url ?? `https://github.com/${repo}/${path}/${ref}`,
    ...(options.assessment !== undefined ? { assessment: options.assessment } : {}),
    ...(options.suggestion !== undefined ? { suggestion: options.suggestion } : {}),
    actions,
    takeAllowed: kind === "issue" && (options.takeAllowed ?? true),
    account: options.account ?? "personal",
    createdAt: created.toISOString(),
    expiresAt: new Date(created.getTime() + (options.ttlHours ?? 24) * 3_600_000).toISOString(),
  };
  await registerIntakeCard(root, content);
  const messageId = options.messageId ?? 900 + seq;
  if (options.delivered !== false) {
    await appendIntakeRecord(root, {
      at: created.toISOString(),
      cardId: id,
      eventKey,
      kind,
      state: "sent",
      ...(options.withoutIds === true ? {} : { chatId: String(CHAT_ID), messageId: String(messageId) }),
    });
  }
  return { id, content, messageId };
}

export function pressFor(card: SeededCard, action: IntakeAction, over: Partial<IntakeCallbackPress> = {}): IntakeCallbackPress {
  return {
    updateId: 1,
    callbackQueryId: "cbq-1",
    chatId: CHAT_ID,
    threadId: THREAD_ID,
    messageId: card.messageId,
    fromId: OWNER,
    data: intakeCallbackData(card.id, action),
    ...over,
  };
}

export { OTHER_REPO, REPO };
