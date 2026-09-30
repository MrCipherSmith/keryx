// Flow 346, design §6 — `/external on|off` command matching + rendering.
//
// No modal (see the flow's own AC8 scope note): bare `/external` prints a
// one-line-per-fact status block (state, source, Jev credential
// availability, and what is blocked right now) instead of opening a
// list+detail modal — the same "kept minimal" reasoning `/route` uses
// (`route-command.ts`'s own header). `/external on|off` toggles + persists
// the per-user setting, mirroring `/guard`/`/route` exactly.

import {
  disableExternalAgents,
  enableExternalAgents,
  externalAgentsStatusLines,
  renderExternalAgentsToggle,
} from "../capability/external-agents";
import type { ResolvedExternalSetting } from "../lib/external-switch";
import type { ExternalProvidersConfig } from "../lib/external-providers";

export const EXTERNAL_COMMAND = "/external";

export function isExternalCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === EXTERNAL_COMMAND;
}

/** The sidebar's one-word value — "external: on" / "external: off". */
export function renderExternalSidebarValue(resolved: ResolvedExternalSetting): string {
  return resolved.value;
}

/**
 * Bare `/external`'s full status block: state + source, whether a Jev
 * credential resolves, and the effective block list when external is off
 * (nothing to list when it's on). Shared with `keryx external status`'s
 * non-JSON rendering in spirit, but kept as a separate small function here
 * rather than imported — that CLI renderer lives in `src/commands/
 * external.ts` (ADAPTER zone); this one is CLIENT (`src/tui/`), and an
 * adapter->client edge for a few lines of text formatting is not worth
 * creating.
 */
export function renderExternalStatusLines(resolved: ResolvedExternalSetting, jevAvailable: boolean, config: ExternalProvidersConfig): string[] {
  const lines: string[] = [
    `external: ${resolved.value} (source: ${resolved.source}) — /external on|off to change`,
    `jev credential: ${jevAvailable ? "available" : "not resolved (OPENROUTER_API_KEY / saved key)"}`,
  ];
  if (resolved.value === "off") {
    lines.push("blocked right now:");
    for (const entry of config.providers) {
      lines.push(`  - ${entry.id}${entry.reason.length > 0 ? ` — ${entry.reason}` : ""}`);
    }
    for (const entry of config.modelPatterns) {
      lines.push(`  - ${entry.pattern}${entry.reason.length > 0 ? ` — ${entry.reason}` : ""}`);
    }
  } else {
    lines.push("blocked right now: nothing — external is on.");
  }
  return lines;
}

/**
 * `/external-agents [on|off]` (flow 373): the shell's one-step opt-in to the external
 * agent RUNTIME — the same action as `keryx agents external enable|disable`, through
 * the same functions. It is NOT `/external on|off`, the privacy switch that blocks
 * external PROVIDERS; the two answer different questions and the usage line says so.
 */
export const EXTERNAL_AGENTS_COMMAND = "/external-agents";

export function isExternalAgentsCommand(line: string): boolean {
  const token = line.trim().split(/\s+/)[0] ?? "";
  return token === EXTERNAL_AGENTS_COMMAND;
}

export const EXTERNAL_AGENTS_USAGE = `Usage: ${EXTERNAL_AGENTS_COMMAND} [on|off]  (the agent runtime, not ${EXTERNAL_COMMAND} on|off, the privacy switch)`;

/**
 * Runs the command and returns the text to print. Never throws: a failure to read or
 * write either file is reported in the lines themselves, as the CLI does.
 */
export async function runExternalAgentsCommand(argText: string, cwd: string, dir?: string): Promise<string> {
  const arg = argText.trim().toLowerCase();
  try {
    if (arg === "on" || arg === "off") {
      const result = arg === "on" ? await enableExternalAgents(cwd, dir) : await disableExternalAgents(cwd, dir);
      return `${renderExternalAgentsToggle(result).join("\n")}\n`;
    }
    if (arg.length > 0) return `Unknown ${EXTERNAL_AGENTS_COMMAND} argument '${arg}'. ${EXTERNAL_AGENTS_USAGE}\n`;
    return `${(await externalAgentsStatusLines(cwd, dir)).join("\n")}\n`;
  } catch (error) {
    return `${EXTERNAL_AGENTS_COMMAND}: ${error instanceof Error ? error.message : String(error)}\n`;
  }
}
