// Flow 403: what a decision on an intake card does. The single door every surface (a button press, the TUI,
// the CLI) goes through.
//
// WHAT to do is read from the card registry (the card's kind and link), never from the press: the press brings only
// a card id and an action code, and the code must be one of the card's own buttons. A card moves
//   sent -> taking -> taken | failed      (take, review-flow: a flow is created; ci-triage: decided)
//   sent -> decided                       (decline, later, skip, ignore, understood)
// and the move out of `sent` is one atomic check-and-append in the ledger, so two presses run the action once.
// Nothing here writes to GitHub, and nothing freezes acceptance criteria: a created flow stays `initializing`.

import { redactSensitiveText } from "../security/service";
import { inQuietHours, readIntakeConfig } from "./config";
import { type IntakeCiTriagePort, type IntakeFlowPort, type IntakeProjectFinder, intakeDefaultPorts } from "./ports";
import { appendIntakeIfState, readIntakeCardView, readIntakeCardViews } from "./store";
import { INTAKE_ACTIONS_BY_KIND, INTAKE_OPEN_STATES, type IntakeAction, type IntakeCardState, type IntakeCardView, type IntakeConfig } from "./types";

export interface IntakeActionDeps {
  readonly flows?: IntakeFlowPort;
  readonly ciTriage?: IntakeCiTriagePort;
  /** `owner/name` to the project root that holds a clone of it. */
  readonly projectFor?: IntakeProjectFinder;
  readonly config?: IntakeConfig;
}

export interface IntakeDecideOptions {
  /** A Telegram user id, or `tui`. */
  readonly decidedBy: string;
  readonly now?: Date;
  readonly deps?: IntakeActionDeps;
}

export interface IntakeDecideResult {
  readonly ok: boolean;
  /** One short sentence for the button toast, the modal or the CLI. */
  readonly message: string;
  readonly flowId?: string;
  /** Set only when THIS call settled the card: the line to put under the card text when it is edited. */
  readonly statusLine?: string;
  /** The text a ci-triage produced (truncated and redacted), for the topic. */
  readonly detail?: string;
}

const CI_TRIAGE_TIMEOUT_MS = 120_000;
const CI_TRIAGE_MAX_BYTES = 64_000;
const CI_TRIAGE_DETAIL_CHARS = 3000;
const REMIND_STEP_MS = 15 * 60_000;

const hhmm = (at: Date): string => `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

const refuse = (message: string): IntakeDecideResult => ({ ok: false, message });

function whyNotOpen(state: IntakeCardState | undefined): string {
  switch (state) {
    case "taking":
      return "уже выполняется";
    case "taken":
    case "decided":
      return "уже решено";
    case "expired":
      return "истекло";
    case "queued":
    case "undelivered":
      return "карточка ещё не доставлена";
    case undefined:
      return "карточка не найдена";
    default:
      return "сейчас решить нельзя";
  }
}

/** `now + laterHours`, pushed past the quiet hours in quarter-hour steps (bounded: a day of steps). */
export function remindAtFor(now: Date, config: IntakeConfig): string {
  let at = new Date(now.getTime() + config.laterHours * 3_600_000);
  for (let i = 0; i < 96 && inQuietHours(at, config.quietHours); i += 1) at = new Date(at.getTime() + REMIND_STEP_MS);
  return at.toISOString();
}

function reasonText(text: string): string {
  return redactSensitiveText(text).replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function decideIntakeCard(root: string, cardId: string, action: IntakeAction, options: IntakeDecideOptions): Promise<IntakeDecideResult> {
  const now = options.now ?? new Date();
  const at = now.toISOString();
  const clock = (): Date => now;
  const deps = options.deps ?? {};
  const view = await readIntakeCardView(root, cardId);
  if (view === undefined) return refuse("карточка не найдена");
  if (view.kind === "overflow") return refuse("у этой карточки нет кнопок");
  if (!INTAKE_ACTIONS_BY_KIND[view.kind].includes(action)) return refuse("такой кнопки у карточки нет");
  if (action === "take" && !view.takeAllowed) return refuse("«Взять в работу» отключено для рабочих репозиториев");
  if (!INTAKE_OPEN_STATES.includes(view.state)) return refuse(whyNotOpen(view.state));
  if (Date.parse(view.expiresAt) <= now.getTime()) {
    await appendIntakeIfState(root, cardId, INTAKE_OPEN_STATES, { state: "expired", reason: "buttons expired" }, clock);
    return refuse("истекло");
  }

  const decided = { choice: action, decidedBy: options.decidedBy, decidedAt: at } as const;

  if (action === "take" || action === "review-flow" || action === "ci-triage") {
    const claim = await appendIntakeIfState(root, cardId, INTAKE_OPEN_STATES, { state: "taking", ...decided }, clock);
    if (!claim.ok) return refuse(whyNotOpen(claim.state));
    return action === "ci-triage" ? runCiTriage(root, view, options, deps, clock) : runFlow(root, view, action, options, deps, clock);
  }

  const config = deps.config ?? (await readIntakeConfig(root));
  const remindAt = action === "later" ? remindAtFor(now, config) : undefined;
  const result = await appendIntakeIfState(root, cardId, INTAKE_OPEN_STATES, { state: "decided", ...decided, ...(remindAt !== undefined ? { remindAt } : {}) }, clock);
  if (!result.ok) return refuse(whyNotOpen(result.state));
  const time = hhmm(now);
  switch (action) {
    case "decline":
      return { ok: true, message: "Отклонено", statusLine: `🚫 отклонено ${time}` };
    case "later":
      return { ok: true, message: `Отложено до ${hhmm(new Date(remindAt!))}`, statusLine: `⏰ отложено до ${hhmm(new Date(remindAt!))}` };
    case "skip":
      return { ok: true, message: "Пропущено", statusLine: `⏭ пропущено ${time}` };
    case "ignore":
      return { ok: true, message: "Игнорируем", statusLine: `🔕 игнорируем ${time}` };
    default:
      return { ok: true, message: "Принято", statusLine: `👍 принято ${time}` };
  }
}

async function fail(root: string, view: IntakeCardView, clock: () => Date, reason: string): Promise<IntakeDecideResult> {
  const text = reasonText(reason);
  await appendIntakeIfState(root, view.id, ["taking"], { state: "failed", reason: text }, clock);
  return refuse(`не вышло: ${text}. Можно нажать ещё раз`);
}

async function runFlow(
  root: string,
  view: IntakeCardView,
  action: "take" | "review-flow",
  options: IntakeDecideOptions,
  deps: IntakeActionDeps,
  clock: () => Date,
): Promise<IntakeDecideResult> {
  const now = clock();
  const at = now.toISOString();
  if (view.repo === undefined || view.url === undefined) return fail(root, view, clock, "the card has no repository or link");
  const project = await (deps.projectFor ?? intakeDefaultPorts().projectFor(root))(view.repo);
  if (project === undefined) return fail(root, view, clock, `no project of yours has a clone of ${view.repo}`);
  const flows = deps.flows ?? intakeDefaultPorts().flows();
  const source = `${view.url} card ${view.id}`;
  try {
    // A press that died after the flow was made must not make a second one: adopt it.
    let flow = await flows.findByCard(project, view.id);
    if (flow === undefined) {
      const created = await flows.init(project, action === "take" ? { issueUrl: view.url, source } : { title: `Review ${view.repo}#${view.ref}`, source });
      if (!created.ok) return fail(root, view, clock, created.reason);
      flow = { flowId: created.flowId, dir: created.dir };
      if (action === "review-flow") await flows.appendDescription(project, flow.dir, `Pull request: ${view.url}`).catch(() => undefined);
    }
    const suggestion = view.suggestion !== undefined ? `, suggestion ${view.suggestion}` : "";
    await flows
      .journal(project, flow.dir, at, `intake: ${action} by ${options.decidedBy} at ${at}, card ${view.id}${suggestion}, origin agent-proposal, source ${view.url}`)
      .catch(() => undefined);
    await appendIntakeIfState(root, view.id, ["taking"], { state: "taken", choice: action, decidedBy: options.decidedBy, decidedAt: at, flowId: flow.flowId }, clock);
    const time = hhmm(now);
    return action === "take"
      ? { ok: true, message: `Взято в работу: flow ${flow.flowId}`, flowId: flow.flowId, statusLine: `✅ взято ${time}, flow ${flow.flowId}` }
      : { ok: true, message: `Ревью-flow ${flow.flowId} создан`, flowId: flow.flowId, statusLine: `🔍 ревью-flow ${time}, flow ${flow.flowId}` };
  } catch (error) {
    return fail(root, view, clock, error instanceof Error ? error.message : String(error));
  }
}

async function runCiTriage(root: string, view: IntakeCardView, options: IntakeDecideOptions, deps: IntakeActionDeps, clock: () => Date): Promise<IntakeDecideResult> {
  const now = clock();
  if (view.repo === undefined) return fail(root, view, clock, "the card has no repository");
  const project = (await (deps.projectFor ?? intakeDefaultPorts().projectFor(root))(view.repo)) ?? root;
  try {
    const result = await (deps.ciTriage ?? intakeDefaultPorts().ciTriage()).run(project, { repo: view.repo, runId: view.ref, timeoutMs: CI_TRIAGE_TIMEOUT_MS, maxBytes: CI_TRIAGE_MAX_BYTES });
    if (!result.ok) return fail(root, view, clock, result.reason);
    await appendIntakeIfState(root, view.id, ["taking"], { state: "decided", choice: "ci-triage", decidedBy: options.decidedBy, decidedAt: now.toISOString() }, clock);
    const detail = redactSensitiveText(result.output).slice(0, CI_TRIAGE_DETAIL_CHARS).trim();
    return { ok: true, message: "Разбор готов", statusLine: `🔎 разобран ${hhmm(now)}`, detail };
  } catch (error) {
    return fail(root, view, clock, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Serve start: a card left in `taking` means serve died between accepting a press and finishing it. Nothing is
 * repeated. A flow made for the card is adopted (`taken`); otherwise the card goes to `failed` with a reason, which
 * shows it for review and lets a human press again (a second press adopts a flow that did get made).
 */
export async function recoverIntakeTaking(root: string, options: { readonly deps?: IntakeActionDeps; readonly now?: () => Date } = {}): Promise<number> {
  const clock = options.now ?? (() => new Date());
  const stuck = (await readIntakeCardViews(root)).filter((c) => c.state === "taking");
  const flows = options.deps?.flows ?? intakeDefaultPorts().flows();
  const projectFor = options.deps?.projectFor ?? intakeDefaultPorts().projectFor(root);
  for (const card of stuck) {
    let found: { flowId: string } | undefined;
    if (card.choice !== "ci-triage" && card.repo !== undefined) {
      const project = await projectFor(card.repo);
      if (project !== undefined) found = await flows.findByCard(project, card.id).catch(() => undefined);
    }
    if (found !== undefined) await appendIntakeIfState(root, card.id, ["taking"], { state: "taken", flowId: found.flowId, ...(card.choice !== undefined ? { choice: card.choice } : {}) }, clock);
    else await appendIntakeIfState(root, card.id, ["taking"], { state: "failed", reason: "interrupted by a restart; no flow found, check and press again" }, clock);
  }
  return stuck.length;
}
