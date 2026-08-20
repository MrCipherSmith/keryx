// `keryx agents external` (flow 176, T15).
// Package: docs/requirements/keryx-external-agent-runtime §8.1; security-policy §1.
//
//   keryx agents external list  [--json] [--no-probe]
//   keryx agents external probe <id> [--json]
//
// Both are read-only and neither spends subscription quota: the only process
// either starts is the registry entry's own `detect` argv, which is
// `--version`. keryx never opens a vendor credential store, not even to answer
// "is the operator logged in?" (security-policy §1, `provider-auth` D-01).
//
// That prohibition is why this surface exists in the shape it does. Availability
// has THREE states, and the third is not a placeholder:
//
//   available     the binary is on PATH and reported a version. It says NOTHING
//                 about whether the subscription will answer.
//   binary-missing the CLI is not installed.
//   not-probed    nobody asked.
//
// The renderer below therefore refuses to draw a green tick. A tick that means
// "nobody asked" — or "a binary exists" — costs the operator a dispatch that
// cannot run, which is the specific, measured harm the third state was
// introduced to prevent. Every `available` row says "login not verified" in as
// many words, and `resolveAvailability` from the runtime registry is the only
// availability model used; this file adds none of its own.

import { createVersionProbe, type VersionProbe } from "../harness/external-agent-probe";
import {
  EXTERNAL_AGENTS,
  getExternalAgent,
  resolveAvailability,
  type AgentAvailability,
} from "../harness/external/registry";
import type { ExternalAgentEntry } from "../harness/external/types";
import { resolveExternalAgentsCapability } from "../capability/external-agents";
import { helpOptions, helpTitle, helpUsage, style } from "../lib/ui";

/** Injectable seams so the whole surface is testable with no CLI on the machine. */
export interface AgentsExternalDeps {
  /** Runs an agent's `detect` argv. Defaults to the real `--version` probe. */
  readonly probe?: VersionProbe;
  /** Project root for the capability gate. Defaults to `process.cwd()`. */
  readonly cwd?: string;
  /** Environment for transport/CI detection. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Shell-config directory override (tests). */
  readonly configDir?: string;
  /** Line sink. Defaults to `console.log`. */
  readonly log?: (line: string) => void;
}

/** One registry entry paired with what detection was allowed to learn about it. */
export interface ExternalAgentRow {
  readonly entry: ExternalAgentEntry;
  readonly availability: AgentAvailability;
}

/** The capability gate's verdict, rendered alongside the roster. */
export interface ExternalCapabilityState {
  readonly available: boolean;
  readonly reason?: string;
}

/**
 * Human-readable availability, with the three states kept distinct.
 *
 * `available` deliberately reads "installed", never "ready": the only thing a
 * version banner proves is that a binary exists.
 */
export function describeAvailability(entry: ExternalAgentEntry, availability: AgentAvailability): string {
  if (availability.state === "not-probed") {
    return "not probed — run `keryx agents external probe " + entry.id + "`";
  }
  if (availability.state === "binary-missing") {
    return `not installed (\`${entry.binary}\` is not on PATH)`;
  }
  const version = availability.version ?? "unknown version";
  const verdict = availability.verdict;
  const range =
    verdict.state === "in-range"
      ? "within the recorded range"
      : verdict.state === "below-min"
        ? `below the recorded minimum ${verdict.min} — parsing may drift`
        : verdict.state === "above-max"
          ? `above the recorded maximum ${verdict.max} — parsing may drift`
          : "version banner not recognised";
  // The load-bearing clause. Everything before it is about a binary.
  return `installed, ${version} (${range}); login not verified — keryx cannot know`;
}

/** The marker for a row. Never a tick: see the module header. */
function marker(availability: AgentAvailability): string {
  if (availability.state === "available") return style.cyan("●");
  if (availability.state === "binary-missing") return style.gray("○");
  return style.yellow("?");
}

/** Probe every listed entry, or none at all when `probe` is undefined. */
async function collectRows(
  entries: readonly ExternalAgentEntry[],
  probe: VersionProbe | undefined,
): Promise<ExternalAgentRow[]> {
  const rows: ExternalAgentRow[] = [];
  for (const entry of entries) {
    // `resolveAvailability(entry, undefined)` is exactly `not-probed`; passing
    // undefined through rather than branching keeps one availability model.
    const outcome = probe === undefined ? undefined : await probe(entry.binary, entry.detect);
    rows.push({ entry, availability: resolveAvailability(entry, outcome) });
  }
  return rows;
}

/** The JSON document `--json` emits. Shape is stable; `availability` is the runtime's own type. */
export interface ExternalAgentsJson {
  readonly capability: ExternalCapabilityState;
  readonly probed: boolean;
  readonly agents: readonly {
    readonly id: string;
    readonly label: string;
    readonly binary: string;
    readonly detect: readonly string[];
    readonly knownGoodRange: { readonly min: string; readonly max?: string };
    readonly sandboxModes: readonly string[];
    readonly streamingInput: boolean;
    readonly resumable: boolean;
    readonly reportsCost: boolean;
    readonly budgetFlag: boolean;
    readonly availability: AgentAvailability;
  }[];
}

/** Build the machine-readable document. Pure. */
export function buildExternalAgentsJson(
  rows: readonly ExternalAgentRow[],
  capability: ExternalCapabilityState,
  probed: boolean,
): ExternalAgentsJson {
  return {
    capability,
    probed,
    agents: rows.map(({ entry, availability }) => ({
      id: entry.id,
      label: entry.label,
      binary: entry.binary,
      detect: entry.detect,
      knownGoodRange: entry.knownGoodRange,
      sandboxModes: entry.sandboxModes,
      streamingInput: entry.streamingInput,
      resumable: entry.resumable,
      reportsCost: entry.reportsCost,
      budgetFlag: entry.budgetFlag,
      availability,
    })),
  };
}

/** Render the text report. Pure — returns lines so a test never captures stdout. */
export function renderExternalAgents(
  rows: readonly ExternalAgentRow[],
  capability: ExternalCapabilityState,
): string[] {
  const lines: string[] = ["# agents external", ""];
  lines.push(
    capability.available
      ? "capability: enabled"
      : `capability: unavailable — ${capability.reason ?? "no reason given"}`,
  );
  lines.push("");
  for (const row of rows) {
    lines.push(`  ${marker(row.availability)} ${row.entry.id}  ${row.entry.label}`);
    lines.push(`      ${describeAvailability(row.entry, row.availability)}`);
    lines.push(
      `      sandbox: ${row.entry.sandboxModes.join(", ")}  streaming: ${row.entry.streamingInput}  ` +
        `resumable: ${row.entry.resumable}  reports cost: ${row.entry.reportsCost}`,
    );
  }
  lines.push("");
  lines.push("A version proves a binary, not a login. keryx never reads a vendor credential store.");
  return lines;
}

/** Resolve the capability gate into the small shape this surface renders. */
async function capabilityState(deps: AgentsExternalDeps): Promise<ExternalCapabilityState> {
  const gate = await resolveExternalAgentsCapability({
    cwd: deps.cwd ?? process.cwd(),
    ...(deps.env === undefined ? {} : { env: deps.env }),
    ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
  });
  return gate.ok ? { available: true } : { available: false, reason: gate.reason };
}

/**
 * `keryx agents external <list|probe>`.
 *
 * Returns nothing and sets `process.exitCode` on a usage error, matching every
 * other command in this directory.
 */
export async function agentsExternalCommand(args: string[], deps: AgentsExternalDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const subcommand = args[0];

  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    printExternalHelp();
    return;
  }

  const json = args.includes("--json");

  if (subcommand === "list") {
    // Probing is on by default because a roster with nothing detected is not a
    // roster; `--no-probe` exists for a scripted caller that wants the registry
    // alone, and it renders every entry honestly as `not-probed`.
    const probe = args.includes("--no-probe") ? undefined : (deps.probe ?? createVersionProbe());
    const rows = await collectRows(EXTERNAL_AGENTS, probe);
    const capability = await capabilityState(deps);
    if (json) {
      log(JSON.stringify(buildExternalAgentsJson(rows, capability, probe !== undefined), null, 2));
      return;
    }
    for (const line of renderExternalAgents(rows, capability)) log(line);
    return;
  }

  if (subcommand === "probe") {
    const id = args.slice(1).find((arg) => !arg.startsWith("-"));
    if (id === undefined) {
      console.error("Provide an agent id: keryx agents external probe <id> [--json]");
      process.exitCode = 1;
      return;
    }
    const entry = getExternalAgent(id);
    if (entry === undefined) {
      console.error(`Unknown external agent "${id}". Known: ${EXTERNAL_AGENTS.map((e) => e.id).join(", ")}`);
      process.exitCode = 1;
      return;
    }
    const probe = deps.probe ?? createVersionProbe();
    const rows = await collectRows([entry], probe);
    const capability = await capabilityState(deps);
    if (json) {
      log(JSON.stringify(buildExternalAgentsJson(rows, capability, true), null, 2));
      return;
    }
    for (const line of renderExternalAgents(rows, capability)) log(line);
    return;
  }

  console.error(`Unknown agents external command: ${subcommand}`);
  printExternalHelp();
  process.exitCode = 1;
}

/** `--help` for the external surface. */
export function printExternalHelp(): void {
  helpTitle("keryx agents external", "inspect the external agent registry (read-only, spends no quota)");
  helpUsage(["keryx agents external list [--json] [--no-probe]", "keryx agents external probe <id> [--json]"]);
  helpOptions([
    { flag: "--json", desc: "Emit the registry + availability document as JSON." },
    { flag: "--no-probe", desc: "Skip detection entirely; every entry reports `not-probed`." },
  ]);
}
