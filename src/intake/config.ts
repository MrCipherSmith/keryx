// Flow 403: the intake settings, read from `.metaproject/data/intake/config.json`.
// A missing file is the defaults of the PRD; a field of the wrong type falls back to its default, so a
// hand-edited file can never stop the poll from running.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { IntakeConfig } from "./types";

export const INTAKE_DEFAULT_TOPIC = "Intake";

export const DEFAULT_INTAKE_CONFIG: IntakeConfig = {
  enabled: true,
  repos: ["MrCipherSmith/keryx"],
  intervalMinutes: 10,
  topic: INTAKE_DEFAULT_TOPIC,
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
    topic: typeof r["topic"] === "string" && r["topic"].trim().length > 0 ? r["topic"].trim().slice(0, 64) : d.topic,
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

export async function readIntakeConfig(projectRoot: string): Promise<IntakeConfig> {
  try {
    return normalizeIntakeConfig(JSON.parse(await readFile(intakeConfigPath(projectRoot), "utf8")));
  } catch {
    return DEFAULT_INTAKE_CONFIG;
  }
}

/** True when `at` (local time) falls inside the quiet hours. A start later than the end wraps midnight. */
export function inQuietHours(at: Date, quiet: IntakeConfig["quietHours"]): boolean {
  const h = at.getHours();
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false;
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}
