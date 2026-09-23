// Flow 295 (AC6-AC9): the one service behind every way a schedule is created
// or changed: `keryx schedule …`, `/schedule`, the `schedule_create` agent tool,
// and the TUI modal's actions.
//
// Creating a schedule has two halves, and nothing is written between them:
//
//   1. DRAFT. Turn the operator's (or the model's) request into a complete
//      `agent-task` entry. That means translating the cadence, resolving each granted
//      program to an absolute path, looking up the account it acts as, and planning
//      the timer install. The draft renders the CONFIRMATION CARD, which lists
//      everything the schedule will be allowed to do and exactly what will be
//      installed. Drafting writes nothing.
//   2. CONFIRM. Only after the operator says yes to that card: store the entry
//      with its content hash (`./store.ts`) and install the timer
//      (`./install.ts`). If the install fails, the stored entry is removed again,
//      so a schedule is either fully present or absent.
//
// The model can propose a draft, but it cannot confirm one. Every caller that confirms
// is an operator surface: a TTY prompt, `--yes` typed by the operator, or a TUI card.

import { execFile } from "node:child_process";
import { accessSync, constants as fsConstants, readdirSync } from "node:fs";
import path from "node:path";
import { loadTriggersConfig, triggerEntryProblems, type AgentTaskAction, type TriggerEntry } from "./config";
import { nextCronRuns, parseCadence } from "./cron";
import { grantedToolSpec } from "./granted-tools";
import {
  installSchedule,
  isScheduleInstalled,
  lingerStatus,
  pauseSchedule,
  planInstall,
  resumeSchedule,
  uninstallSchedule,
  type InstallPlan,
  type ScheduleHost,
} from "./install";
import { latestRunByTrigger, readTriggerRuns, type TriggerRunRecord } from "./record";
import { addConfirmedSchedule, removeStoredSchedule, setScheduleEnabled, triggerReportsDir } from "./store";

/** Shown on the card whenever the shell gets the host network. Kept in step with trigger-dispatch's NETWORK_ON_WARNING. */
export const FULL_NETWORK_CARD_WARNING =
  "NETWORK ON — the agent's shell commands get the host's FULL network: the internet, every service on the host's loopback, and the host's abstract unix sockets.";

/** What a caller asks for. Everything money-shaped is required; the rest has safe defaults. */
export interface ScheduleRequest {
  readonly name: string;
  /** A cron expression or a phrase `parseCadence` understands ("every 4 hours"). */
  readonly cadence: string;
  readonly prompt: string;
  readonly provider: string;
  readonly model: string;
  readonly rates: { readonly inputUsdPerMTok: number; readonly outputUsdPerMTok: number };
  readonly ceilingUsd: number;
  readonly maxSeconds?: number;
  readonly permissionMode?: "ask" | "trust";
  readonly network?: "off" | "full";
  readonly tools?: readonly string[];
  readonly repos?: readonly string[];
}

export interface DraftContext {
  readonly projectRoot: string;
  readonly host?: ScheduleHost;
  readonly now?: () => Date;
  /** Resolve a program to an absolute path. Default: search `PATH`. */
  readonly resolveProgram?: (program: string) => string | undefined;
  /** The account a granted program acts as. Default: `gh api user --jq .login`, run from the project root. */
  readonly accountOf?: (program: string, bin: string) => Promise<string | undefined>;
}

export interface ScheduleDraft {
  /** The exact entry that will be stored if confirmed. */
  readonly entry: Record<string, unknown>;
  readonly cron: string;
  readonly nextRuns: readonly Date[];
  readonly plan: InstallPlan;
  readonly linger: "yes" | "no" | "unknown" | "n/a";
  /** The confirmation card, one line per element. The same text on every surface. */
  readonly card: readonly string[];
}

export type DraftResult = { readonly ok: true; readonly draft: ScheduleDraft } | { readonly ok: false; readonly problems: readonly string[] };

/** Search PATH for an executable. */
export function resolveOnPath(program: string, pathEnv: string | undefined = process.env["PATH"]): string | undefined {
  for (const dir of (pathEnv ?? "").split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, program);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return undefined;
}

function defaultAccountOf(projectRoot: string): (program: string, bin: string) => Promise<string | undefined> {
  return (program, bin) =>
    program !== "gh"
      ? Promise.resolve(undefined)
      : new Promise((resolve) => {
          execFile(bin, ["api", "user", "--jq", ".login"], { cwd: projectRoot, timeout: 10_000 }, (error, stdout) => {
            resolve(error === null && stdout.trim().length > 0 ? stdout.trim() : undefined);
          });
        });
}

/** Build a draft. Writes nothing and installs nothing. */
export async function draftSchedule(request: ScheduleRequest, ctx: DraftContext): Promise<DraftResult> {
  const cadence = parseCadence(request.cadence);
  if (!cadence.ok) return { ok: false, problems: [`cadence: ${cadence.reason}`] };
  const tools = [...(request.tools ?? [])];
  const programs = [...new Set(tools.map((id) => grantedToolSpec(id)?.program).filter((p): p is string => p !== undefined))];
  const resolve = ctx.resolveProgram ?? ((p: string) => resolveOnPath(p));
  const bins: Record<string, string> = {};
  const problems: string[] = [];
  for (const program of programs) {
    const bin = resolve(program);
    if (bin === undefined) problems.push(`grants: "${program}" is not on PATH, so the granted tools that run it cannot be confirmed`);
    else bins[program] = bin;
  }
  const accountOf = ctx.accountOf ?? defaultAccountOf(ctx.projectRoot);
  const accounts: string[] = [];
  for (const [program, bin] of Object.entries(bins)) {
    const account = await accountOf(program, bin).catch(() => undefined);
    accounts.push(`${program}: ${account ?? "unknown (could not ask it)"}`);
  }
  const action: Record<string, unknown> = {
    kind: "agent-task",
    prompt: request.prompt,
    dispatch: {
      provider: request.provider,
      model: request.model,
      permissionMode: request.permissionMode ?? "ask",
      rates: { inputUsdPerMTok: request.rates.inputUsdPerMTok, outputUsdPerMTok: request.rates.outputUsdPerMTok },
      ceilingUsd: request.ceilingUsd,
      ...(request.maxSeconds !== undefined ? { maxSeconds: request.maxSeconds } : {}),
    },
    grants: {
      network: request.network ?? "off",
      tools,
      repos: [...(request.repos ?? [])],
      bins,
      ...(accounts.length > 0 ? { account: accounts.join("; ") } : {}),
    },
  };
  const entry: Record<string, unknown> = { name: request.name, on: { kind: "schedule", cron: cadence.cron }, action };
  problems.push(...triggerEntryProblems(entry));
  const existing = loadTriggersConfig(ctx.projectRoot).triggers.find((t) => t.name === request.name);
  if (existing !== undefined) problems.push(`name: "${request.name}" is already used by a ${existing.source === "store" ? "schedule" : "trigger"}`);
  if (problems.length > 0) return { ok: false, problems };

  const host = ctx.host ?? {};
  const plan = await planInstall(ctx.projectRoot, request.name, cadence.cron, host);
  if (plan.problem !== undefined) return { ok: false, problems: [`cadence: ${plan.problem}`] };
  const linger = plan.backend === "systemd" ? await lingerStatus(host) : "n/a";
  const now = (ctx.now ?? (() => new Date()))();
  const nextRuns = nextCronRuns(cadence.cron, now, 3);
  const draft: ScheduleDraft = {
    entry,
    cron: cadence.cron,
    nextRuns,
    plan,
    linger,
    card: renderCard({ request, cron: cadence.cron, phrase: cadence.phrase, nextRuns, bins, accounts, plan, linger }),
  };
  return { ok: true, draft };
}

function renderCard(input: {
  request: ScheduleRequest;
  cron: string;
  phrase: string;
  nextRuns: readonly Date[];
  bins: Record<string, string>;
  accounts: readonly string[];
  plan: InstallPlan;
  linger: string;
}): string[] {
  const { request, plan } = input;
  const network = request.network ?? "off";
  const tools = request.tools ?? [];
  const lingerLine =
    plan.backend === "systemd"
      ? input.linger === "yes"
        ? "linger: on — the timer runs even while you are logged out"
        : input.linger === "no"
          ? "linger: off — the timer runs only while you are logged in (keryx never enables linger; `loginctl enable-linger` is yours to run)"
          : "linger: unknown — could not read it; assume the timer runs only while you are logged in"
      : plan.backend === "launchd"
        ? "linger: n/a — a LaunchAgent runs only while you are logged in"
        : "linger: n/a — cron runs while the machine is on; runs missed while it was off are NOT caught up";
  return [
    `Schedule "${request.name}" — confirm to store it and install a background timer`,
    `cadence: ${input.cron}${input.phrase !== input.cron ? ` (${input.phrase})` : ""}`,
    `next runs: ${input.nextRuns.map((d) => d.toISOString()).join(", ") || "none within a year"}`,
    `prompt: ${request.prompt}`,
    `runner: ${request.provider}/${request.model}, mode ${request.permissionMode ?? "ask"}${(request.permissionMode ?? "ask") === "trust" ? " (the agent can run shell commands in the sandbox)" : " (read-only: every command is denied)"}`,
    `budget: ceiling $${request.ceilingUsd} for this schedule (the project-wide ceiling also applies), max ${request.maxSeconds ?? 600}s per run, rates $${request.rates.inputUsdPerMTok}/$${request.rates.outputUsdPerMTok} per M tokens in/out`,
    `network: ${network === "full" ? FULL_NETWORK_CARD_WARNING : "off (the agent's shell has no network)"}`,
    tools.length === 0
      ? "granted tools: none"
      : `granted tools (run by keryx outside the sandbox with YOUR credentials; the model sees only redacted output): ${tools.join(", ")}`,
    ...tools.map((id) => {
      const spec = grantedToolSpec(id);
      return `  - ${id}: ${spec !== undefined ? input.bins[spec.program] ?? "(unresolved)" : "(unknown)"}`;
    }),
    ...(tools.length > 0 ? [`  repositories: ${(request.repos ?? []).join(", ")}`, `  account: ${input.accounts.join("; ") || "unknown"}`] : []),
    `install: ${plan.backend} — ${plan.location}`,
    `runs: ${plan.execStart}`,
    lingerLine,
    "the machine must be on; a missed run is caught up once at the next boot/wake (systemd Persistent=true, launchd) — never by cron",
  ];
}

export interface CreateResult {
  readonly name: string;
  readonly backend: string;
  readonly unit: string;
  readonly confirmedHash: string;
}

/**
 * CONFIRM: store the drafted entry with its content hash and install its timer. Call this only
 * after the operator has said yes to `draft.card`.
 */
export async function confirmSchedule(projectRoot: string, draft: ScheduleDraft, host: ScheduleHost = {}): Promise<CreateResult> {
  const stored = await addConfirmedSchedule(projectRoot, draft.entry);
  try {
    const installed = await installSchedule(projectRoot, stored.name, draft.cron, host);
    return { name: stored.name, backend: installed.backend, unit: installed.unit, confirmedHash: stored.confirmedHash };
  } catch (error) {
    await removeStoredSchedule(projectRoot, stored.name).catch(() => false);
    throw error;
  }
}

/** One row of `keryx schedule list`, `/schedules` and the sidebar. */
export interface ScheduleSummary {
  readonly name: string;
  readonly cron: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly nextRun: Date | undefined;
  readonly last: { readonly at: string; readonly outcome: string; readonly usd: number | undefined; readonly refusal?: string; readonly detail: string } | undefined;
  readonly reportPath: string | undefined;
  readonly entry: TriggerEntry & { action: AgentTaskAction };
}

function scheduleEntries(projectRoot: string): (TriggerEntry & { action: AgentTaskAction; fire: { kind: "schedule"; cron: string } })[] {
  return loadTriggersConfig(projectRoot).triggers.filter(
    (t): t is TriggerEntry & { action: AgentTaskAction; fire: { kind: "schedule"; cron: string } } =>
      t.source === "store" && t.action.kind === "agent-task" && t.fire.kind === "schedule",
  );
}

/** The newest report file for `name`, repo-relative. */
export function latestReportPath(projectRoot: string, name: string): string | undefined {
  const dir = path.join(triggerReportsDir(projectRoot), name);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return undefined;
  }
  const newest = names[names.length - 1];
  return newest === undefined ? undefined : path.relative(projectRoot, path.join(dir, newest));
}

/** Every stored schedule, with its install state, next run and last outcome. */
export async function listSchedules(projectRoot: string, options: { host?: ScheduleHost; now?: () => Date; records?: readonly TriggerRunRecord[] } = {}): Promise<ScheduleSummary[]> {
  let records = options.records;
  if (records === undefined) {
    const read = await readTriggerRuns(projectRoot);
    records = read.state === "present" ? read.records : [];
  }
  const outcomes = latestRunByTrigger(records.filter((r) => r.outcome !== "reserved"));
  const now = (options.now ?? (() => new Date()))();
  const out: ScheduleSummary[] = [];
  for (const entry of scheduleEntries(projectRoot)) {
    const record = outcomes.get(entry.name);
    const installed = await isScheduleInstalled(projectRoot, entry.name, entry.fire.cron, options.host ?? {}).catch(() => false);
    out.push({
      name: entry.name,
      cron: entry.fire.cron,
      enabled: entry.enabled,
      installed,
      nextRun: entry.enabled ? nextCronRuns(entry.fire.cron, now, 1)[0] : undefined,
      last:
        record === undefined
          ? undefined
          : {
              at: record.at,
              outcome: record.outcome,
              usd: record.cost.recorded ? record.cost.usd : undefined,
              ...(record.agentTask?.refusal !== undefined ? { refusal: record.agentTask.refusal } : {}),
              detail: record.detail,
            },
      reportPath: record?.agentTask?.reportPath ?? latestReportPath(projectRoot, entry.name),
      entry,
    });
  }
  return out;
}

function findSchedule(projectRoot: string, name: string): TriggerEntry & { action: AgentTaskAction; fire: { kind: "schedule"; cron: string } } {
  const entry = scheduleEntries(projectRoot).find((e) => e.name === name);
  if (entry === undefined) throw new Error(`no schedule named "${name}" (keryx schedule list shows them)`);
  return entry;
}

/** Pause: disable the timer and mark the entry disabled. A fire while paused records `no-op`. */
export async function pauseStoredSchedule(projectRoot: string, name: string, host: ScheduleHost = {}): Promise<void> {
  const entry = findSchedule(projectRoot, name);
  await setScheduleEnabled(projectRoot, name, false);
  await pauseSchedule(projectRoot, name, entry.fire.cron, host);
}

/** Resume: re-enable both. The content (and its confirmed hash) is unchanged, so no new confirmation is needed. */
export async function resumeStoredSchedule(projectRoot: string, name: string, host: ScheduleHost = {}): Promise<void> {
  const entry = findSchedule(projectRoot, name);
  await resumeSchedule(projectRoot, name, entry.fire.cron, host);
  await setScheduleEnabled(projectRoot, name, true);
}

/** Remove: uninstall the timer (only our own files) and delete the entry. Callers confirm first. */
export async function removeSchedule(projectRoot: string, name: string, host: ScheduleHost = {}): Promise<{ removed: readonly string[]; skipped: readonly string[] }> {
  const entry = findSchedule(projectRoot, name);
  const result = await uninstallSchedule(projectRoot, name, entry.fire.cron, host);
  await removeStoredSchedule(projectRoot, name);
  return result;
}

