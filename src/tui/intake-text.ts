// The pure, OpenTUI-free half of `intake-surface.ts`: the /intake command, deps and status text the
// readline shell and the ACP `shell` profile print. `intake-surface.ts` re-exports it.

import { existsSync } from "node:fs";
import { ensureRealIntakePorts } from "../commands/intake-ports";
import { decideIntakeCard } from "../intake/actions";
import { intakeConfigPath } from "../intake/config";
import { runIntakePoll } from "../intake/poll";
import { buildIntakeStatus, setIntakePaused } from "../intake/status";
import type { IntakeAction, IntakeCardSummary, IntakePollResult, IntakeRecentEvent, IntakeStatus } from "../intake/types";


export const INTAKE_COMMAND = "/intake";
export const INTAKE_USAGE = `Usage: ${INTAKE_COMMAND} [status|list|pause|resume|poll]`;
export const INTAKE_POLL_MS = 5000;

export const INTAKE_TABS = [
  { id: "waiting", label: "Ждут" },
  { id: "decided", label: "Решённые" },
  { id: "deferred", label: "Отложенные" },
  { id: "events", label: "События" },
] as const;
export type IntakeTabId = (typeof INTAKE_TABS)[number]["id"];

export const INTAKE_FOOTER = [
  { key: "↑/↓", label: "выбор" },
  { key: "←/→", label: "вкладки" },
  { key: "t", label: "взять" },
  { key: "d", label: "отклонить" },
  { key: "l", label: "позже" },
  { key: "p", label: "пауза/пуск" },
  { key: "esc", label: "закрыть" },
] as const;

// ---- the command ----------------------------------------------------------------------------------

export function isIntakeCommand(line: string): boolean {
  return (line.trim().split(/\s+/)[0] ?? "") === INTAKE_COMMAND;
}

export type IntakeRequest = { action: "open" } | { action: "status" | "list" | "pause" | "resume" | "poll" } | { action: "invalid"; message: string };

export function parseIntakeArgs(line: string): IntakeRequest {
  const [, sub, ...rest] = line.trim().split(/\s+/);
  if (sub === undefined) return { action: "open" };
  if (rest.length === 0 && (sub === "status" || sub === "list" || sub === "pause" || sub === "resume" || sub === "poll")) return { action: sub };
  return { action: "invalid", message: INTAKE_USAGE };
}

// ---- the seams ------------------------------------------------------------------------------------

export interface IntakeSurfaceDeps {
  readonly root: string;
  /** The one status object. Default: `buildIntakeStatus(root)`. */
  readonly status?: () => Promise<IntakeStatus>;
  /** The door every surface decides through. Default: `decideIntakeCard`. */
  readonly decide?: typeof decideIntakeCard;
  readonly setPaused?: (paused: boolean) => Promise<void>;
  /** One poll by hand. Default: `runIntakePoll(root, { manual: true })`. */
  readonly poll?: () => Promise<IntakePollResult>;
}

interface ResolvedDeps {
  readonly root: string;
  readonly status: () => Promise<IntakeStatus>;
  readonly decide: typeof decideIntakeCard;
  readonly setPaused: (paused: boolean) => Promise<void>;
  readonly poll: () => Promise<IntakePollResult>;
}

/** True when the project has an intake config file; without one the sidebar row and the `/` menu entry stay hidden. */
export function intakeConfiguredSync(root: string): boolean {
  try {
    return existsSync(intakeConfigPath(root));
  } catch {
    return false;
  }
}

/** The default door: the real flow and ci-triage ports are installed on first use, so a press never meets "no ports". */
const decideWithRealPorts: typeof decideIntakeCard = (root, cardId, action, options) => {
  ensureRealIntakePorts();
  return decideIntakeCard(root, cardId, action, options);
};

export function resolveDeps(deps: IntakeSurfaceDeps): ResolvedDeps {
  const { root } = deps;
  return {
    root,
    status: deps.status ?? (() => buildIntakeStatus(root)),
    decide: deps.decide ?? decideWithRealPorts,
    setPaused: deps.setPaused ?? ((paused) => setIntakePaused(root, paused)),
    poll: deps.poll ?? (() => runIntakePoll(root, { manual: true })),
  };
}

// ---- text ---------------------------------------------------------------------------------------

// A title or a repository name comes from GitHub: it may carry terminal control bytes.
// eslint-disable-next-line no-control-regex -- strips terminal control bytes from untrusted text
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

export function clean(text: string, max = 90): string {
  const flat = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

export const ACTION_LABEL: Readonly<Record<IntakeAction, string>> = {
  take: "взять",
  decline: "отклонить",
  later: "позже",
  "review-flow": "ревью",
  skip: "пропустить",
  "ci-triage": "разобрать CI",
  ignore: "игнорировать",
  understood: "понятно",
};

const KEY_ACTIONS = {
  t: ["take", "review-flow", "ci-triage", "understood"],
  d: ["decline", "skip", "ignore"],
  l: ["later"],
} as const satisfies Record<string, readonly IntakeAction[]>;
export type IntakeKey = keyof typeof KEY_ACTIONS;

/** What `t`, `d` and `l` mean for this card: the first of their actions its buttons offer. */
export function intakeActionsFor(card: Pick<IntakeCardSummary, "actions">): Partial<Record<IntakeKey, IntakeAction>> {
  const out: Partial<Record<IntakeKey, IntakeAction>> = {};
  for (const key of Object.keys(KEY_ACTIONS) as IntakeKey[]) {
    const hit = KEY_ACTIONS[key].find((action) => card.actions.includes(action));
    if (hit !== undefined) out[key] = hit;
  }
  return out;
}

export function cardHeadline(c: IntakeCardSummary): string {
  return `${c.kind.padEnd(7)} ${c.repo !== undefined ? `${clean(c.repo, 40)} ` : ""}${clean(c.title)}`;
}

export function cardDetail(c: IntakeCardSummary, tab: IntakeTabId): string {
  if (tab === "waiting") {
    const keys = Object.entries(intakeActionsFor(c)).map(([key, action]) => `${key} ${ACTION_LABEL[action as IntakeAction]}`);
    const hint = c.suggestion !== undefined ? `предложено: ${ACTION_LABEL[c.suggestion]}; ` : "";
    return `${hint}${c.state === "failed" ? "прошлая попытка не удалась; " : ""}${keys.join(", ")}`;
  }
  if (tab === "deferred") return `напомнить: ${c.remindAt ?? "—"}`;
  const choice = c.choice !== undefined ? ACTION_LABEL[c.choice] : c.state;
  return `→ ${choice}${c.decidedBy !== undefined ? ` (${clean(c.decidedBy, 24)})` : ""}${c.decidedAt !== undefined ? ` ${c.decidedAt}` : ""}${c.flowId !== undefined ? `; flow ${clean(c.flowId, 24)}` : ""}`;
}

export function eventLine(e: IntakeRecentEvent): string {
  return `${e.at}  ${e.kind.padEnd(7)} ${clean(e.key, 60)}  → ${e.cardId}`;
}

export function intakeStatusText(status: IntakeStatus): string {
  const lines = [
    status.line,
    ...(status.disabledReason !== undefined && !status.configured ? [`  ${status.disabledReason}`] : []),
    ...status.problems.map((p) => `  внимание: ${p}`),
    `  включён: ${status.enabled ? "да" : "нет"}${status.paused ? " (пауза)" : ""}${status.quiet ? "; сейчас тихие часы" : ""}`,
    `  ждут решения: ${status.waiting}; в очереди на отправку: ${status.queued}; отложено: ${status.deferred}; решено: ${status.decided}`,
    `  репозитории: ${status.repos.join(", ") || "не заданы"}; аккаунт GitHub по пути проекта: ${status.ghAccount}`,
    `  последний опрос: ${status.lastPollAt ?? "ещё не было"}`,
  ];
  if (status.lastRun !== undefined) lines.push(`  итог последнего: ${status.lastRun.outcome} — ${status.lastRun.detail}`);
  return `${lines.join("\n")}\n`;
}

export function intakeListText(status: IntakeStatus): string {
  const groups: Array<[string, readonly IntakeCardSummary[], IntakeTabId]> = [
    ["Ждут", status.tabs.waiting, "waiting"],
    ["Отложенные", status.tabs.deferred, "deferred"],
    ["Решённые", status.tabs.decided, "decided"],
  ];
  const lines: string[] = [];
  for (const [label, cards, tab] of groups) {
    if (cards.length === 0) continue;
    lines.push(`${label} (${cards.length}):`);
    for (const c of cards) lines.push(`  ${c.id}  ${cardHeadline(c)}`, `      ${cardDetail(c, tab)}`);
  }
  return lines.length === 0 ? "Карточек пока нет.\n" : `${lines.join("\n")}\n`;
}

function pollText(result: IntakePollResult): string {
  const lines = [`Intake: ${result.outcome} — ${result.detail}`];
  for (const f of result.failures) lines.push(`  ${f.source}: ${f.detail}`);
  return `${lines.join("\n")}\n`;
}

/** `/intake status|list|pause|resume|poll` as text, for the transcript and the readline shell. Never throws. */
export async function runIntakeText(request: Exclude<IntakeRequest, { action: "open" }>, input: IntakeSurfaceDeps): Promise<string> {
  const deps = resolveDeps(input);
  try {
    if (request.action === "invalid") return `${request.message}\n`;
    if (request.action === "status") return intakeStatusText(await deps.status());
    if (request.action === "list") return intakeListText(await deps.status());
    if (request.action === "pause" || request.action === "resume") {
      await deps.setPaused(request.action === "pause");
      const status = await deps.status();
      return `${request.action === "pause" ? "Intake: автоматический опрос на паузе." : "Intake: опрос возобновлён."}\n${status.line}\n`;
    }
    const text = pollText(await deps.poll());
    return `${text}${(await deps.status()).line}\n`;
  } catch (cause) {
    return `/intake ${request.action}: ${cause instanceof Error ? cause.message : String(cause)}\n`;
  }
}

/** The readline shell has no modal: the bare command prints the status and what is waiting. */
export async function readlineIntakeText(line: string, input: IntakeSurfaceDeps): Promise<string> {
  const request = parseIntakeArgs(line);
  if (request.action !== "open") return runIntakeText(request, input);
  try {
    const status = await resolveDeps(input).status();
    return `${intakeStatusText(status)}${intakeListText(status)}Решить карточку: кнопки в Telegram, либо /intake в полноэкранном шелле.\n`;
  } catch (cause) {
    return `/intake: ${cause instanceof Error ? cause.message : String(cause)}\n`;
  }
}
