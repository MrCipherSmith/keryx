// Flow 492 T11: the `/task` quick-start form as a plain controller. It owns what the plan's state
// and event matrix is about (what is focused, what is typed, when Start is enabled, which operation
// id a request carries, what an outcome does) and nothing about drawing: `quick-start-modal.ts`
// paints this state and forwards keys, so the whole matrix is testable without a renderer.
//
// Operation id policy (the Hub route is idempotent on it):
//   - a network failure keeps the id, so a retry of the SAME body replays the stored receipt
//     instead of making a second Flow;
//   - a changed body, or any rejection, gets a fresh id, because the old one is either bound to
//     another body (409) or never stored anything.

import { questionsFor, type ClarifyQuestion } from "../hub/work/clarify";
import { getMode, QUICK_MODES, type QuickModeId } from "../hub/work/quick-modes";
import { quickStartSizeProblem } from "../hub/work/quick-start-limits";
import { buildQuickStartRequest, parseCriteriaField, type QuickStartRequestBody } from "./quick-start-request";

/** What one send attempt came to. A 5xx, a dropped connection and an unreadable answer are all `network`: the outcome is unknown. */
export type QuickStartOutcome =
  | { kind: "accepted"; flowId: string; intentId: string }
  | { kind: "rejected"; status: number; code: string; message: string }
  | { kind: "network"; message: string };

export type QuickStartSender = (operationId: string, body: QuickStartRequestBody) => Promise<QuickStartOutcome>;

export type QuickStartSlot = "mode" | "description" | `question:${string}` | "criteria" | "submit";

export type QuickStartPhase = "editing" | "submitting" | "done";

export interface QuickStartError {
  kind: "rejected" | "network";
  message: string;
  /** True when pressing Start again is the right move (the same operation id is reused). */
  retry: boolean;
}

export interface QuickStartDraft {
  mode: QuickModeId;
  description: string;
  answers: Record<string, string>;
  criteria: string;
}

/** An operation whose outcome is unknown: its id and the digest of the exact body it was sent with. */
export interface QuickStartPending {
  operationId: string;
  digest: string;
}

export interface QuickStartFormState extends QuickStartDraft {
  phase: QuickStartPhase;
  focus: QuickStartSlot;
  slots: readonly QuickStartSlot[];
  questions: readonly ClarifyQuestion[];
  canSubmit: boolean;
  error?: QuickStartError;
  /** The operation id of the attempt in flight or awaiting a retry. */
  operationId?: string;
}

export interface QuickStartKey {
  name: string;
  sequence: string;
}

export interface QuickStartForm {
  state(): QuickStartFormState;
  draft(): QuickStartDraft;
  /** The operation in flight or awaiting a retry; keep it across a close and hand it back as `initialPending`. */
  pendingOperation(): QuickStartPending | undefined;
  /** True when the form consumed the key. Escape is never consumed: the modal host closes on it. */
  handleKey(key: QuickStartKey): boolean;
  /** Starts a send if the form may; the request goes out before this returns. */
  submit(): void;
  /** Resolves when the request in flight (if any) has been handled. */
  settled(): Promise<void>;
  subscribe(listener: () => void): () => void;
}

export interface QuickStartFormOptions {
  send: QuickStartSender;
  /** Called once with the Flow when the Hub accepts. */
  onAccepted: (flowId: string, intentId: string) => void;
  /** A fresh operation id; defaults to a random UUID. */
  newOperationId?: () => string;
  initial?: QuickStartDraft;
  /** An operation left unresolved by an earlier form: Start on the same body replays it instead of minting a new id. */
  initialPending?: QuickStartPending;
}

const ENTER_KEYS = new Set(["return", "linefeed", "enter", "kpenter"]);
const NAMED_KEYS = new Set([...ENTER_KEYS, "tab", "up", "down", "left", "right", "backspace", "delete", "escape", "home", "end", "pageup", "pagedown"]);

export const RETRY_NOTICE =
  "The earlier request may have reached the Hub. Press Enter on Start to retry it; it cannot create a second Flow.";
export const EDITED_PENDING_NOTICE =
  "Editing starts a new task; the earlier request may already be running. Put the text back to retry it instead.";

export const HUMAN_REQUIRED_MESSAGE =
  "The Hub only lets a signed-in human start work, and this session is not one. Start it from the web dialog instead.";

/** The text a key adds to a field: its sequence with line breaks flattened, or undefined for control sequences. */
function insertable(key: QuickStartKey): string | undefined {
  if (NAMED_KEYS.has(key.name)) return undefined;
  const flattened = key.sequence.replace(/[\r\n\t]+/g, " ");
  if (flattened.length === 0) return undefined;
  for (const ch of flattened) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code === 127) return undefined;
  }
  return flattened;
}

export function createQuickStartForm(options: QuickStartFormOptions): QuickStartForm {
  const newOperationId = options.newOperationId ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();

  let mode: QuickModeId = options.initial === undefined ? "quick" : getMode(options.initial.mode).id;
  let description = options.initial?.description ?? "";
  let criteria = options.initial?.criteria ?? "";
  let answers: Record<string, string> = { ...(options.initial?.answers ?? {}) };
  let phase: QuickStartPhase = "editing";
  let focus: QuickStartSlot = "mode";
  let error: QuickStartError | undefined;
  /** Set while a request is in flight and after a network failure; cleared by every other outcome. */
  let pending: QuickStartPending | undefined = options.initialPending;
  let inflight: Promise<void> = Promise.resolve();

  const slots = (): QuickStartSlot[] => [
    "mode",
    "description",
    ...questionsFor(mode).map((question): QuickStartSlot => `question:${question.id}`),
    "criteria",
    "submit",
  ];
  const canSubmit = (): boolean => phase === "editing" && description.trim().length > 0;
  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const body = (): QuickStartRequestBody =>
    buildQuickStartRequest({ mode, description, answers, criteria: parseCriteriaField(criteria) });

  /** What an unresolved operation says while the form is idle: retry it as it was, or a warning once the body has moved on. */
  function pendingNotice(): QuickStartError | undefined {
    if (pending === undefined) return undefined;
    const same = pending.digest === JSON.stringify(body());
    return { kind: "network", message: same ? RETRY_NOTICE : EDITED_PENDING_NOTICE, retry: same };
  }
  // A reopened form shows its notice and starts on Start, so the window shows the message and the button together.
  error = pendingNotice();
  if (error?.retry === true) focus = "submit";

  function move(step: 1 | -1): void {
    const all = slots();
    const at = all.indexOf(focus);
    focus = all[(at + step + all.length) % all.length]!;
  }

  function cycleMode(step: 1 | -1): void {
    const at = QUICK_MODES.findIndex((candidate) => candidate.id === mode);
    mode = QUICK_MODES[(at + step + QUICK_MODES.length) % QUICK_MODES.length]!.id;
    edited();
  }

  /** Any edit retires a visible error, except that an unresolved operation keeps speaking until it is accepted or rejected. */
  function edited(): void {
    error = pendingNotice();
  }

  function edit(slot: QuickStartSlot, change: (text: string) => string): void {
    if (slot === "description") description = change(description);
    else if (slot === "criteria") criteria = change(criteria);
    else if (slot.startsWith("question:")) {
      const id = slot.slice("question:".length);
      answers = { ...answers, [id]: change(answers[id] ?? "") };
    }
    edited();
  }

  function submit(): void {
    if (!canSubmit()) return;
    const request = body();
    const tooBig = quickStartSizeProblem(request);
    if (tooBig !== undefined) {
      error = { kind: "rejected", message: tooBig, retry: false };
      emit();
      return;
    }
    const digest = JSON.stringify(request);
    const operationId = pending !== undefined && pending.digest === digest ? pending.operationId : newOperationId();
    pending = { operationId, digest };
    phase = "submitting";
    error = undefined;
    emit();
    inflight = (async () => {
      let outcome: QuickStartOutcome;
      try {
        outcome = await options.send(operationId, request);
      } catch (cause) {
        outcome = { kind: "network", message: cause instanceof Error ? cause.message : String(cause) };
      }
      if (outcome.kind === "accepted") {
        pending = undefined;
        phase = "done";
        emit();
        options.onAccepted(outcome.flowId, outcome.intentId);
        return;
      }
      phase = "editing";
      if (outcome.kind === "rejected") {
        pending = undefined;
        error = {
          kind: "rejected",
          message: outcome.code === "human-required" ? HUMAN_REQUIRED_MESSAGE : outcome.message || outcome.code,
          retry: false,
        };
      } else {
        error = { kind: "network", message: `${outcome.message}. Press Enter on Start to retry.`, retry: true };
      }
      emit();
    })();
  }

  function handleKey(key: QuickStartKey): boolean {
    if (key.name === "escape") return false;
    if (phase === "submitting") return true;
    if (phase === "done") return false;
    const before = JSON.stringify([mode, description, criteria, answers, focus, error]);
    const consumed = route(key);
    if (consumed && JSON.stringify([mode, description, criteria, answers, focus, error]) !== before) emit();
    return consumed;
  }

  function route(key: QuickStartKey): boolean {
    if (key.name === "up") {
      move(-1);
      return true;
    }
    if (key.name === "down" || key.name === "tab") {
      move(1);
      return true;
    }
    if (focus === "mode") {
      if (key.name === "left") cycleMode(-1);
      else if (key.name === "right") cycleMode(1);
      else if (ENTER_KEYS.has(key.name)) move(1);
      else return false;
      return true;
    }
    if (focus === "submit") {
      if (ENTER_KEYS.has(key.name) || key.name === "space") {
        submit();
        return true;
      }
      return false;
    }
    // A text slot takes every key: `x` is a letter here, not the host's close.
    if (ENTER_KEYS.has(key.name)) {
      move(1);
      return true;
    }
    if (key.name === "backspace") {
      edit(focus, (text) => Array.from(text).slice(0, -1).join(""));
      return true;
    }
    const text = insertable(key);
    if (text !== undefined) edit(focus, (current) => current + text);
    return true;
  }

  return {
    state: () => ({
      phase,
      mode,
      description,
      answers: { ...answers },
      criteria,
      focus,
      slots: slots(),
      questions: questionsFor(mode),
      canSubmit: canSubmit(),
      ...(error === undefined ? {} : { error }),
      ...(pending === undefined ? {} : { operationId: pending.operationId }),
    }),
    draft: () => ({ mode, description, answers: { ...answers }, criteria }),
    pendingOperation: () => (pending === undefined ? undefined : { ...pending }),
    handleKey,
    submit,
    settled: () => inflight,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * What `/task` carries from one modal to the next. It follows the form itself and reads it when the next modal opens,
 * so a request that was still in flight at close and later came back rejected, or accepted, is not remembered as it was
 * at close time.
 */
export interface QuickStartMemory {
  /** Make `form` the one to remember. */
  attach(form: QuickStartForm): void;
  /** The options a new form starts from: the unfinished draft and its unresolved operation, or nothing after an accepted request. */
  options(): Pick<QuickStartFormOptions, "initial" | "initialPending">;
}

export function createQuickStartMemory(): QuickStartMemory {
  let current: QuickStartForm | undefined;
  return {
    attach: (form) => {
      current = form;
    },
    options: () => {
      if (current === undefined) return {};
      if (current.state().phase === "done") {
        current = undefined;
        return {};
      }
      const pending = current.pendingOperation();
      return { initial: current.draft(), ...(pending === undefined ? {} : { initialPending: pending }) };
    },
  };
}
