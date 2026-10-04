// Flow 403 (AC15, AC17): the one status object every surface is built from, and the pause switch.
//
// The sidebar line, the `/intake` modal, the readline text and `keryx intake status` all read what
// `buildIntakeStatus` returns; none of them computes a count of its own.

import { ghEnvForProject, type GhAccount } from "../scheduler/digest-gh";
import { inQuietHours, intakeDisabledReason, readIntakeConfigFile } from "./config";
import { nextIntakePollAt } from "./poll";
import { readIntakeCardViews, readIntakeState, updateIntakeState } from "./store";
import type { IntakeCardSummary, IntakeCardView, IntakeConfig, IntakeStatus } from "./types";

export interface IntakeStatusDeps {
  readonly now?: () => Date;
  readonly env?: Record<string, string | undefined>;
  readonly config?: IntakeConfig;
}

const WAITING_STATES = new Set(["sent", "collapsed", "failed"]);
const SUMMARY_CAP = 50;

function summary(c: IntakeCardView): IntakeCardSummary {
  return {
    id: c.id,
    kind: c.kind,
    ...(c.repo !== undefined ? { repo: c.repo } : {}),
    title: c.title,
    ...(c.url !== undefined ? { url: c.url } : {}),
    state: c.state,
    ...(c.suggestion !== undefined ? { suggestion: c.suggestion } : {}),
    actions: c.actions,
    createdAt: c.createdAt,
    ...(c.choice !== undefined ? { choice: c.choice } : {}),
    ...(c.decidedBy !== undefined ? { decidedBy: c.decidedBy } : {}),
    ...(c.decidedAt !== undefined ? { decidedAt: c.decidedAt } : {}),
    ...(c.flowId !== undefined ? { flowId: c.flowId } : {}),
    ...(c.remindAt !== undefined ? { remindAt: c.remindAt } : {}),
  };
}

function clock(iso: string | null): string {
  if (iso === null) return "ещё не опрашивался";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Newest first, so the surfaces show what just happened. */
const newestFirst = (a: IntakeCardView, b: IntakeCardView): number => b.updatedAt.localeCompare(a.updatedAt);

export async function buildIntakeStatus(root: string, deps: IntakeStatusDeps = {}): Promise<IntakeStatus> {
  const now = (deps.now ?? (() => new Date()))();
  const env = deps.env ?? process.env;
  const file = deps.config !== undefined ? { present: true, config: deps.config, problems: [] as readonly string[] } : await readIntakeConfigFile(root);
  const config = file.config;
  const state = await readIntakeState(root);
  // An overflow card is a courtesy message: the cards it folded are what a human decides on.
  const views = (await readIntakeCardViews(root)).filter((c) => c.kind !== "overflow").sort(newestFirst);

  const waiting = views.filter((c) => WAITING_STATES.has(c.state));
  const queued = views.filter((c) => c.state === "queued");
  const deferred = views.filter((c) => c.state === "decided" && c.choice === "later");
  const decided = views.filter((c) => (c.state === "decided" && c.choice !== "later") || c.state === "taking" || c.state === "taken");
  const nextPollAt = nextIntakePollAt(config, state);
  const ghAccount: GhAccount = ghEnvForProject(root, env)["GH_ACCOUNT"] === "work" ? "work" : "personal";

  const disabledReason = intakeDisabledReason(file);
  const line = !file.present
    ? "Intake: не настроен"
    : !config.enabled
      ? "Intake: выкл"
      : state.paused
        ? `Intake: ${waiting.length} ждут | пауза`
        : `Intake: ${waiting.length} ждут | следующий опрос ${clock(nextPollAt)}`;

  return {
    configured: file.present,
    enabled: config.enabled,
    ...(disabledReason !== undefined ? { disabledReason } : {}),
    problems: file.problems,
    paused: state.paused,
    waiting: waiting.length,
    queued: queued.length,
    deferred: deferred.length,
    decided: decided.length,
    lastPollAt: state.lastPollAt ?? null,
    nextPollAt,
    quiet: inQuietHours(now, config.quietHours),
    repos: config.repos,
    ghAccount,
    line,
    tabs: {
      waiting: waiting.slice(0, SUMMARY_CAP).map(summary),
      decided: decided.slice(0, SUMMARY_CAP).map(summary),
      deferred: deferred.slice(0, SUMMARY_CAP).map(summary),
      events: state.recent.slice(-SUMMARY_CAP).reverse(),
    },
    ...(state.lastRun !== undefined ? { lastRun: state.lastRun } : {}),
  };
}

/** Pause or resume the automatic poll. Cards already queued are still delivered; a poll by hand still runs. */
export async function setIntakePaused(root: string, paused: boolean): Promise<void> {
  await updateIntakeState(root, (s) => ({ ...s, paused }));
}
