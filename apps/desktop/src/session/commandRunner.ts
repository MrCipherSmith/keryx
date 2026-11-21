// Running one slash command line (spec 3.9.1): which commands the app handles itself, which go to
// keryx as `_keryx/command`, and what lands in the transcript. No React; the hook supplies the deps.

import { COMMAND_METHOD, commandMeta, commandSurface, findCommand } from "../acp/commands";
import type { AvailableCommand, CommandEffect, CommandResult, CommandView, ConfigOption, ConfirmAction, SessionModeState } from "../acp/types";
import { parseReviewDraft, type ReviewDraftHints } from "../../../../src/acp/review-draft";
import type { DelegateLaunch } from "./delegateTerminals";
import type { Action, QueuedPrompt } from "./reducer";

/** What only the window can do: the app's own UI. */
export interface UiActions {
  focusSessions(): void;
  /** Open the mode picker, or set the mode when `arg` names one. */
  mode(arg: string): void;
  model(arg: string): void;
  /** The Providers dialog (`/connect`, `/search-provider`). */
  openRouting?(): void;
  openProviders(name: string, args: string): void;
  /** Move text into the composer (never sends). */
  fillComposer(text: string): void;
  /** One confirmation dialog (`label` on its button); resolves true on a yes. Absent: the answer's text is shown instead. */
  confirm?(ask: { label: string; confirm: string }): Promise<boolean>;
}

export interface RunDeps {
  prepareReview?: (sessionId: string, hints: ReviewDraftHints, prompt?: string) => void;
  client: { request<T>(method: string, params?: unknown): Promise<T> } | null;
  sessionId: string | null;
  /** The shown session's turn is running. */
  busy: boolean;
  commands: readonly AvailableCommand[];
  /** keryx advertised `_keryx/command`. */
  hasCommandMethod: boolean;
  queue: readonly QueuedPrompt[];
  dispatch(a: Action): void;
  /** Starts a prompt turn (the M1 path); false when it was not accepted. */
  sendPrompt(text: string): boolean;
  /** Starts a turn in the session the command ran in (`startTurn`), even if another one is shown by now. */
  startTurn(sessionId: string, text: string): boolean;
  newSession(): void;
  interrupt(): void;
  applyEffects(sessionId: string, effects: readonly CommandEffect[]): void;
  /** `/delegate` answered `openTerminal`: open the run's tab and register it as a subagent of `sessionId`. */
  openTerminal?(sessionId: string, launch: DelegateLaunch): void;
  ui: UiActions;
  /** Marks a command in flight for the session until the returned function is called, so keryx's mid-command questions are admitted. */
  trackCommand?(sessionId: string): () => void;
}

const reviewCommand: AvailableCommand = {
  name: "review", description: "Configure a Keryx pull request review", input: { hint: "[#number or GitHub PR URL]" },
  _meta: { keryx: { group: "Review", surface: "dialog", busy: "run" } },
};

export function desktopReviewCommands(commands: readonly AvailableCommand[]): AvailableCommand[] {
  return [...commands.filter(command => command.name.toLowerCase() !== reviewCommand.name), reviewCommand];
}

/** Recognize direct launch commands before a model can interpret them as an inline review.
 * Keep the whole message in scope: questions and requests with extra work still go to the agent.
 */
export function desktopReviewRequest(line: string): ReviewDraftHints | undefined {
  if (/[\r\n]/.test(line.trim())) return;
  const text = line.trim().replace(/[.!?]$/, "");
  const launch = /^(?:пожалуйста,?\s+)?(?:запусти|начни)\s+(?:(?:адаптивное|фоновое|автономное|автоматическое)\s+)*ревью(?=\s|$)/iu.exec(text)
    ?? /^(?:please\s+)?(?:start|run|launch)\s+(?:(?:an?|the|adaptive|background|autonomous|automatic)\s+)*(?:pr\s+)?review(?=\s|$)/iu.exec(text);
  if (!launch) return;
  const target = text.slice(launch[0].length).trim()
    .replace(/(?:^|\s)(?:в|in)\s+keryx(?:\s+desktop)?$/iu, "")
    .replace(/(?:^|\s)(?:с(?:\s+помощью)?|через|using|with|via)\s+`?review-orchestrator`?$/iu, "")
    .replace(/^(?:этого\s+pr|текущего\s+pr|pr|для|for|of)(?:\s+|$)/iu, "")
    .trim()
    .replace(/^<([^<>]+)>$|^`([^`]+)`$/u, "$1$2");
  const draft = parseReviewDraft(target ? { target } : {});
  return draft.ok ? draft.hints : undefined;
}

export interface RunOptions {
  /** The line to show in the transcript when it must not show the real one (a masked secret). */
  display?: string;
  /** A view's own card: the new result takes its place. */
  replaceId?: number;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Runs `line`. Resolves true when the composer's draft may be cleared: the line was handled, or keryx
 * answered it with a refusal (the refusal is its own card). False when the client itself refused it
 * (busy) or the request failed, so the user can fix and resend the draft.
 */
export async function runCommandLine(line: string, deps: RunDeps, opts: RunOptions = {}): Promise<boolean> {
  if (deps.prepareReview && deps.sessionId && opts.replaceId === undefined) {
    const request = desktopReviewRequest(line);
    if (request) {
      deps.prepareReview(deps.sessionId, request, opts.display ?? line);
      return true;
    }
  }
  if (deps.sessionId && deps.ui.openRouting && /^\/routing\s*$/i.test(line.trim())) {
    deps.ui.openRouting();
    return true;
  }
  const found = findCommand(deps.prepareReview ? desktopReviewCommands(deps.commands) : deps.commands, line);
  // Not an advertised command: ordinary text for the model.
  if (!found) return sendOrQueue(line, deps);
  const { command, parsed } = found;
  const sessionId = deps.sessionId;
  if (!sessionId) return false;
  const shown = opts.display ?? line;
  const card = (text: string, refused = false, view: CommandView | null = null, error = false) =>
    deps.dispatch({ t: "command", sessionId, card: { line: shown, text, refused, view, ...(error ? { error: true } : {}) }, replaceId: opts.replaceId });
  const refuse = (text: string): false => {
    card(text, true);
    return false;
  };

  const meta = commandMeta(command);
  if (meta.busy === "refuse" && deps.busy) {
    return refuse(`/${command.name} is not available while keryx is working. Stop the turn first (Esc), then run it again.`);
  }

  switch (commandSurface(command)) {
    case "client":
    case "dialog":
      return runClient(command.name.toLowerCase(), parsed.args, deps, card, refuse);
    default:
      break;
  }

  // text and view commands go to keryx.
  if (!deps.hasCommandMethod) return sendOrQueue(line, deps);
  if (!deps.client) return false;
  const endCommand = deps.trackCommand?.(sessionId);
  let ask: ConfirmAction | null = null;
  try {
    const r = await deps.client.request<CommandResult>(COMMAND_METHOD, { sessionId, name: parsed.name, args: parsed.args });
    const k = r?._meta?.keryx;
    const refused = k?.refused === true;
    const pending = !refused ? k?.confirmAction : undefined;
    // A draft to confirm: ask at once and leave the transcript (and the form that sent it) as it was.
    if (pending && deps.ui.confirm && validConfirm(pending) && findCommand(deps.commands, pending.command)) ask = pending;
    else card(typeof r?.text === "string" ? r.text : "", refused, k?.view ?? null);
    if (!refused && k?.effects?.length) deps.applyEffects(sessionId, k.effects);
    // `/goal`: keryx did the shell's setup and answers the turn text; the turn is an ordinary prompt, sent once.
    if (!refused && k?.effects?.includes("startTurn") && typeof k.prompt === "string" && k.prompt.trim()) {
      if (!deps.startTurn(sessionId, k.prompt)) {
        deps.dispatch({ t: "notice", sessionId, level: "warn", text: "The goal's turn was not started: the session is busy. Send the goal as a message when it is free." });
      }
    }
    // `/delegate`: keryx handed over the vendor CLI's argv; it runs in the app's terminal.
    if (!refused && k?.effects?.includes("openTerminal") && k.terminal) deps.openTerminal?.(sessionId, k.terminal);
    if (ask === null) return true;
  } catch (e) {
    card(errText(e), true, null, true);
    return false;
  } finally {
    endCommand?.();
  }
  // The question is asked after the request is over: nothing is in flight while the dialog is open.
  if (!(await deps.ui.confirm!({ label: ask.label, confirm: ask.confirm }))) return false;
  return runCommandLine(ask.command, deps, { replaceId: opts.replaceId });
}

const validConfirm = (a: ConfirmAction): boolean => typeof a.label === "string" && typeof a.confirm === "string" && typeof a.command === "string" && a.command.startsWith("/");

/** M1 behaviour, and the path for plain text: a turn when idle, the queue while one runs. */
function sendOrQueue(text: string, deps: RunDeps): boolean {
  if (deps.busy) {
    if (!deps.sessionId || !text.trim()) return false;
    deps.dispatch({ t: "queueAdd", sessionId: deps.sessionId, text });
    return true;
  }
  return deps.sendPrompt(text);
}

type CardFn = (text: string, refused?: boolean) => void;

function runClient(name: string, args: string, deps: RunDeps, card: CardFn, refuse: (text: string) => false): boolean {
  switch (name) {
    case "review": {
      const parsed = parseReviewDraft(args ? { target: args } : {});
      if (!parsed.ok) return refuse(parsed.message);
      if (!deps.prepareReview || !deps.sessionId) return false;
      deps.prepareReview(deps.sessionId, parsed.hints, args ? "/review " + args : "/review");
      return true;
    }
    case "new":
    case "clear":
      deps.newSession();
      return true;
    case "resume":
    case "sessions":
      deps.ui.focusSessions();
      return true;
    case "interrupt":
      if (!deps.busy) card("Nothing is running.");
      else deps.interrupt();
      return true;
    case "mode":
      deps.ui.mode(args);
      return true;
    case "model":
      deps.ui.model(args);
      return true;
    case "connect":
    case "search-provider":
      deps.ui.openProviders(name, args);
      return true;
    case "queue":
      return runQueue(args, deps, card, refuse);
    default:
      return refuse(`/${name} is a command this version of the app cannot run itself.`);
  }
}

/** `/queue` over the shown session's client-side queue. Entries are numbered from 1. */
function runQueue(args: string, deps: RunDeps, card: CardFn, refuse: (text: string) => false): boolean {
  const sessionId = deps.sessionId!;
  const [sub = "", n = "", ...rest] = args.split(/\s+/).filter(Boolean);
  if (sub === "") {
    card(
      deps.queue.length === 0
        ? "The queue is empty."
        : deps.queue.map((q, i) => `${i + 1}. ${q.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n"),
    );
    return true;
  }
  const index = /^\d+$/.test(n) && rest.length === 0 ? Number(n) - 1 : -1;
  if (!["remove", "edit", "force"].includes(sub)) return refuse("Usage: /queue [remove N | edit N | force N]");
  const entry = deps.queue[index];
  if (!entry) return refuse(`There is no queued prompt ${n || "number"}. /queue lists them.`);
  if (sub === "remove") {
    deps.dispatch({ t: "queueRemove", sessionId, index });
    card(`Removed queued prompt ${index + 1}.`);
  } else if (sub === "edit") {
    deps.dispatch({ t: "queueRemove", sessionId, index });
    deps.ui.fillComposer(entry.text);
    card(`Moved queued prompt ${index + 1} into the composer.`);
  } else {
    // It becomes the next prompt; the turn is cancelled and the queue then sends it.
    deps.dispatch({ t: "queueFront", sessionId, index });
    if (deps.busy) deps.interrupt();
    card(`Prompt ${index + 1} will be sent next${deps.busy ? ", after the current turn stops" : ""}.`);
  }
  return true;
}

// ---- /mode and /model arguments ---------------------------------------------------------------

/** The mode `arg` names, by id or name, case-insensitively. */
export function resolveMode(modes: SessionModeState | null, arg: string): string | null {
  const a = arg.trim().toLowerCase();
  if (!modes || !a) return null;
  return modes.availableModes.find((m) => m.id.toLowerCase() === a || m.name.toLowerCase() === a)?.id ?? null;
}

/** The model value `arg` names, by value or name, case-insensitively. */
export function resolveModel(option: ConfigOption | undefined, arg: string): string | null {
  const a = arg.trim().toLowerCase();
  if (!option || !a) return null;
  for (const o of option.options) {
    const list = "group" in o && Array.isArray((o as { options?: unknown }).options) ? (o as { options: Array<{ value: string; name: string }> }).options : [o as { value: string; name: string }];
    const hit = list.find((x) => x.value.toLowerCase() === a || x.name.toLowerCase() === a);
    if (hit) return hit.value;
  }
  return null;
}
