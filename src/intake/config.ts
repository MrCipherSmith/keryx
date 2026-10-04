// Flow 403: the intake settings, read from `.metaproject/data/intake/config.json`.
// Intake is opt-in: a project with no config file has intake OFF and no repositories, so nothing polls a
// repository the operator never named. A field of the wrong type falls back to its default, so a hand-edited
// file can never stop the poll from running. `repos` has no default: an enabled file without any is reported.
// The Telegram topic is fixed (`INTAKE_SERVICE_TOPIC`): the hub routes presses only from that topic, so a
// configurable name would make every card dead. A legacy `topic` key is ignored and reported.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IntakeConfig } from "./types";

export const DEFAULT_INTAKE_CONFIG: IntakeConfig = {
  enabled: false,
  repos: [],
  intervalMinutes: 10,
  quietHours: { startHour: 22, endHour: 8 },
  cardsPerHour: 6,
  buttonTtlHours: 24,
  laterHours: 4,
  budgetUsd: 0.5,
  maxSeconds: 300,
  memoryLimitMb: 512,
  rows: 100,
  allowTakeInWork: false,
};

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function intakeDataDir(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "data", "intake");
}

export function intakeConfigPath(projectRoot: string): string {
  return path.join(intakeDataDir(projectRoot), "config.json");
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : fallback;
}

function hour(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 23 ? value : fallback;
}

/** What is wrong with a config file, in one line each. Empty means it is usable as it stands. */
export function intakeConfigProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return ["config.json is not a JSON object"];
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  if ("topic" in r) problems.push('"topic" is no longer configurable and is ignored: cards always go to the "Intake" topic');
  const repos = r["repos"];
  const listed = Array.isArray(repos) ? repos.filter((x): x is string => typeof x === "string" && REPO.test(x)) : [];
  if (listed.length === 0) problems.push('"repos" is required: list the repositories to poll, as owner/name');
  else if (Array.isArray(repos) && listed.length !== repos.length) problems.push('"repos" has entries that are not owner/name; they are ignored');
  return problems;
}

/** Validate a parsed config object field by field. Anything unusable keeps its default. */
export function normalizeIntakeConfig(raw: unknown): IntakeConfig {
  const d = DEFAULT_INTAKE_CONFIG;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return d;
  const r = raw as Record<string, unknown>;
  const quiet = typeof r["quietHours"] === "object" && r["quietHours"] !== null ? (r["quietHours"] as Record<string, unknown>) : {};
  const repos = Array.isArray(r["repos"]) ? r["repos"].filter((x): x is string => typeof x === "string" && REPO.test(x)) : undefined;
  return {
    enabled: typeof r["enabled"] === "boolean" ? r["enabled"] : d.enabled,
    repos: repos !== undefined ? repos : d.repos,
    intervalMinutes: num(r["intervalMinutes"], d.intervalMinutes, 1, 24 * 60),
    quietHours: { startHour: hour(quiet["startHour"], d.quietHours.startHour), endHour: hour(quiet["endHour"], d.quietHours.endHour) },
    cardsPerHour: Math.floor(num(r["cardsPerHour"], d.cardsPerHour, 1, 100)),
    buttonTtlHours: num(r["buttonTtlHours"], d.buttonTtlHours, 1, 24 * 14),
    laterHours: num(r["laterHours"], d.laterHours, 1, 24 * 14),
    budgetUsd: num(r["budgetUsd"], d.budgetUsd, 0, 100),
    maxSeconds: Math.floor(num(r["maxSeconds"], d.maxSeconds, 5, 3600)),
    memoryLimitMb: Math.floor(num(r["memoryLimitMb"], d.memoryLimitMb, 16, 16384)),
    rows: Math.floor(num(r["rows"], d.rows, 1, 999)),
    allowTakeInWork: typeof r["allowTakeInWork"] === "boolean" ? r["allowTakeInWork"] : d.allowTakeInWork,
  };
}

export interface IntakeConfigFile {
  /** False when the project has no (readable) config file: intake is off there. */
  readonly present: boolean;
  readonly config: IntakeConfig;
  readonly problems: readonly string[];
}

export async function readIntakeConfigFile(projectRoot: string): Promise<IntakeConfigFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(intakeConfigPath(projectRoot), "utf8"));
  } catch {
    return { present: false, config: DEFAULT_INTAKE_CONFIG, problems: [] };
  }
  return { present: true, config: normalizeIntakeConfig(raw), problems: intakeConfigProblems(raw) };
}

export async function readIntakeConfig(projectRoot: string): Promise<IntakeConfig> {
  return (await readIntakeConfigFile(projectRoot)).config;
}

/** How to turn intake on in a project, for the one-line refusal of a manual poll and the status. */
export const INTAKE_ENABLE_HINT = 'create .metaproject/data/intake/config.json with {"enabled": true, "repos": ["owner/name"]}';

/** Why intake cannot run in this project, or undefined when it is on and has repositories. */
export function intakeDisabledReason(file: IntakeConfigFile): string | undefined {
  if (!file.present) return `intake не настроен в этом проекте: ${INTAKE_ENABLE_HINT}`;
  if (!file.config.enabled) return 'intake выключен ("enabled": false в config.json)';
  if (file.config.repos.length === 0) return 'в config.json не указан "repos": добавьте репозитории owner/name';
  return undefined;
}

/** True when `at` (local time) falls inside the quiet hours. A start later than the end wraps midnight. */
export function inQuietHours(at: Date, quiet: IntakeConfig["quietHours"]): boolean {
  const h = at.getHours();
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}
