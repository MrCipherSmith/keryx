// Bus enablement and poll interval (specification §5.1, §7.4).

import { detectCi } from "../capability/external-agents";

export type BusEnablement = { enabled: true; reason: null } | { enabled: false; reason: string };

export interface BusEnabledInput {
  env: Readonly<Record<string, string | undefined>>;
  /** The loaded shell config; only `bus.enabled` is read. */
  shellConfig?: object | null;
}

function shellConfigDisables(shellConfig: object | null | undefined): boolean {
  if (shellConfig === null || shellConfig === undefined) return false;
  const bus = (shellConfig as { bus?: unknown }).bus;
  return typeof bus === "object" && bus !== null && (bus as { enabled?: unknown }).enabled === false;
}

/**
 * Whether this process may join and write the bus, with a named reason when not:
 * `KERYX_BUS=off`, shell config `bus.enabled: false`, or a CI environment
 * (the same detection the external-agents capability uses).
 */
export function busEnabled(input: BusEnabledInput): BusEnablement {
  if ((input.env.KERYX_BUS ?? "").trim().toLowerCase() === "off") {
    return { enabled: false, reason: "KERYX_BUS=off" };
  }
  if (shellConfigDisables(input.shellConfig)) {
    return { enabled: false, reason: "shell config bus.enabled is false" };
  }
  const ci = detectCi(input.env);
  if (ci !== undefined) {
    return { enabled: false, reason: `CI environment (${ci} is set)` };
  }
  return { enabled: true, reason: null };
}

export const BUS_POLL_MS_DEFAULT = 1500;
export const BUS_POLL_MS_MIN = 250;
export const BUS_POLL_MS_MAX = 10_000;

/** `KERYX_BUS_POLL_MS`, clamped to 250–10000; 1500 when unset or not a number. */
export function busPollMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.KERYX_BUS_POLL_MS?.trim();
  if (raw === undefined || raw.length === 0 || !/^\d+$/.test(raw)) return BUS_POLL_MS_DEFAULT;
  const value = Number(raw);
  return Math.min(BUS_POLL_MS_MAX, Math.max(BUS_POLL_MS_MIN, value));
}
