// `keryx agents external` (flow 176, T15).
// Package: docs/requirements/keryx-external-agent-runtime §8.1; security-policy §1.
//
//   keryx agents external list  [--json] [--no-probe]
//   keryx agents external probe <id> [--json]
//   keryx agents external run <id> --task "<text>" [--unattended] [--write]   (flow 292)
//
// `run` is the one subcommand that starts a real agent, and it spends the
// operator's quota; it drives an ACP agent with keryx as its CLIENT, through
// `runExternalChild` and every gate the runtime already has. `list` and `probe`
// are read-only and neither spends subscription quota: the only process
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

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { createVersionProbe, type VersionProbe } from "../harness/external-agent-probe";
import {
  EXTERNAL_AGENTS,
  getExternalAgent,
  resolveAvailability,
  transportOf,
  type AgentAvailability,
} from "../harness/external/registry";
import type { ExternalAgentEntry } from "../harness/external/types";
import {
  agentConfig,
  resolveExternalAgentsCapability,
  type ExternalAgentsConfig,
} from "../capability/external-agents";
import { createGitWorktreePort } from "../harness/child/git-worktree-port";
import type { WorktreePort } from "../harness/child/worktree";
import { createBunSpawnPort } from "../harness/external/bun-spawn-port";
import { readExternalDepth } from "../harness/external/env";
import { runExternalChild, type ExternalChildOutcome } from "../harness/external/runtime";
import type { ExternalSpawnPort } from "../harness/external/supervise";
import type { AcpChildOptions } from "../harness/external/acp-run";
import { DEFAULT_MAX_EXTERNAL_DEPTH } from "../harness/run-external-factory";
import type { AgentIO } from "./agent";
import { getProjectPermissionMode } from "../lib/permission-mode-config";
import { optionValue } from "../lib/args";
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
  /** Seams for `run` (flow 292). Every one defaults to the real thing. */
  readonly run?: AgentsExternalRunSeams;
}

/** What `keryx agents external run` can have substituted, for tests. */
export interface AgentsExternalRunSeams {
  readonly config?: ExternalAgentsConfig;
  readonly spawn?: ExternalSpawnPort;
  readonly worktree?: WorktreePort;
  /** `null` skips the version probe (`not-probed`). */
  readonly detect?: VersionProbe | null;
  /** Whether a human is at a terminal. Defaults to `process.stdin.isTTY`. */
  readonly isTTY?: boolean;
  readonly requestApproval?: AgentIO["requestApproval"];
  /** Everything ACP-specific the runtime forwards (argv override, context, data dir…). */
  readonly acp?: AcpChildOptions;
  readonly onOutcome?: (outcome: ExternalChildOutcome) => void;
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
    readonly transport: "line-stream" | "acp";
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
      transport: transportOf(entry),
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
      `      transport: ${transportOf(row.entry)}  sandbox: ${row.entry.sandboxModes.join(", ")}  streaming: ${row.entry.streamingInput}  ` +
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

  if (subcommand === "run") {
    await runCommand(args.slice(1), deps, log);
    return;
  }

  console.error(`Unknown agents external command: ${subcommand}`);
  printExternalHelp();
  process.exitCode = 1;
}

/**
 * An approver that asks on the terminal. The answer is bound to the prompt's
 * fingerprint — the permission bridge accepts nothing less.
 *
 * The readline is closed on EVERY path: an answer, or the bridge abandoning the
 * question (`meta.signal`, aborted when its approval timeout wins). Closing only
 * in the answer callback leaked one open interface per timed-out prompt, each
 * holding stdin — the CLI could hang after the run had ended (flow 292 T13).
 */
export function terminalApprover(
  io: { readonly input?: NodeJS.ReadableStream; readonly output?: NodeJS.WritableStream; readonly onInterface?: (rl: Interface) => void } = {},
): NonNullable<AgentIO["requestApproval"]> {
  return (tool, input, meta) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: io.input ?? process.stdin, output: io.output ?? process.stderr });
      io.onInterface?.(rl);
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        meta?.signal?.removeEventListener("abort", onAbort);
        rl.close();
        resolve(meta === undefined ? approved : { approved, fingerprint: meta.fingerprint });
      };
      const onAbort = (): void => finish(false);
      if (meta?.signal?.aborted === true) {
        finish(false);
        return;
      }
      meta?.signal?.addEventListener("abort", onAbort, { once: true });
      const risk = meta?.destructive === true ? " (destructive)" : "";
      rl.question(`\n${tool}${risk}\n  ${input}\nAllow once? [y/N] `, (answer) => {
        finish(answer.trim().toLowerCase() === "y");
      });
    });
}

/**
 * `keryx agents external run <id> --task "<text>" [--unattended] [--write]`
 * (flow 292): drive one registry ACP agent, with keryx as its client.
 *
 * The same gates as every other external run: the capability (with its
 * transport/CI hard disable), the per-agent config, the depth marker, the
 * version probe, the disposable worktree. No human at a terminal, or
 * `--unattended`, means every permission that would need one is refused.
 */
async function runCommand(args: string[], deps: AgentsExternalDeps, log: (line: string) => void): Promise<void> {
  // A question, never a run: `run <id> --task x --help` must not start an agent.
  if (args.includes("--help") || args.includes("-h")) {
    printExternalHelp();
    return;
  }
  const seams = deps.run ?? {};
  const json = args.includes("--json");
  const id = args.find((arg, index) => !arg.startsWith("-") && !["--task", "--timeout"].includes(args[index - 1] ?? ""));
  const task = optionValue(args, "--task");
  if (id === undefined || task === undefined || task.trim().length === 0) {
    console.error('Usage: keryx agents external run <id> --task "<text>" [--unattended] [--write] [--timeout <ms>] [--json]');
    process.exitCode = 1;
    return;
  }
  const entry = getExternalAgent(id);
  if (entry === undefined) {
    console.error(`Unknown external agent "${id}". Known: ${EXTERNAL_AGENTS.map((e) => e.id).join(", ")}`);
    process.exitCode = 1;
    return;
  }
  if (transportOf(entry) !== "acp") {
    console.error(
      `\`run\` drives ACP agents only; "${id}" speaks the one-way line stream. Delegate to it from \`keryx shell\` with /delegate.`,
    );
    process.exitCode = 1;
    return;
  }

  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const gate = await resolveExternalAgentsCapability({
    cwd,
    env,
    ...(seams.config === undefined ? {} : { config: seams.config }),
    ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
  });
  if (!gate.ok) {
    console.error(`refused: ${gate.reason}`);
    process.exitCode = 1;
    return;
  }
  const perAgent = agentConfig(gate.config, id);
  if (!perAgent.enabled) {
    console.error(`refused: external agent "${id}" is disabled; enable it under \`externalAgents.agents.${id}\` in the keryx user config`);
    process.exitCode = 1;
    return;
  }

  const write = args.includes("--write");
  const isTTY = seams.isTTY ?? process.stdin.isTTY === true;
  const unattended = args.includes("--unattended") || !isTTY;
  const requestApproval = unattended ? undefined : (seams.requestApproval ?? terminalApprover());
  const timeoutRaw = optionValue(args, "--timeout");
  const timeoutMs =
    timeoutRaw !== undefined && Number.isInteger(Number(timeoutRaw)) && Number(timeoutRaw) > 0
      ? Number(timeoutRaw)
      : gate.config.defaultTimeoutMs;
  const worktreesDir = path.join(tmpdir(), "keryx-external-worktrees");
  const worktree = seams.worktree ?? createGitWorktreePort({ repoRoot: cwd, worktreesDir });
  if (seams.worktree === undefined) await mkdir(worktreesDir, { recursive: true });
  const detect = seams.detect === null ? undefined : (seams.detect ?? createVersionProbe());

  const outcome = await runExternalChild(
    {
      runtime: {
        kind: "external",
        agent: id,
        sandbox: write ? "worktree-write" : "read-only",
        model: perAgent.model,
      },
      allowedActions: write ? ["read-file", "write"] : ["read-file"],
      taskTitle: task.length > 80 ? `${task.slice(0, 77)}...` : task,
      taskDescription: task,
      acceptanceCriteria: [],
      worktreeId: `acp-${randomUUID()}`,
      maxPromptBytes: gate.config.maxPromptBytes,
      timeoutMs,
      parentEnv: env,
      depth: readExternalDepth(env) + 1,
      projectRoot: cwd,
    },
    {
      spawn: seams.spawn ?? createBunSpawnPort(),
      worktree,
      capability: () => ({ enabled: true }),
      ...(detect === undefined ? {} : { detect }),
      maxExternalDepth: DEFAULT_MAX_EXTERNAL_DEPTH,
      onWarning: (warning) => console.error(`warning: ${warning}`),
      acp: {
        ...seams.acp,
        mode: seams.acp?.mode ?? getProjectPermissionMode(cwd) ?? "ask",
        unattended,
        ...(requestApproval === undefined ? {} : { requestApproval }),
      },
    },
  );
  seams.onOutcome?.(outcome);

  if (json) {
    log(JSON.stringify(outcome, null, 2));
  } else {
    for (const line of renderRunOutcome(outcome)) log(line);
  }
  if (outcome.status !== "Completed") process.exitCode = 1;
}

/** The text report for one run. Pure. */
export function renderRunOutcome(outcome: ExternalChildOutcome): string[] {
  const lines = [`# agents external run`, "", `status: ${outcome.status}`];
  const record = outcome.acp;
  if (record !== undefined) {
    const info = record.agentInfo === "unreported" ? "unreported" : `${record.agentInfo.name} ${record.agentInfo.version}`;
    lines.push(`agent: ${record.agentId} (${info})`);
    lines.push(
      `mode: ${record.mode.effective}${record.mode.clamped ? ` (lowered from ${record.mode.requested}: a foreign agent's tool calls are self-described)` : ""}` +
        `${record.unattended ? ", unattended — every permission that needs a human is refused" : ""}`,
    );
    lines.push(`context: ${record.context.offered ? "keryx serve-mcp --read-only offered" : `not offered — ${record.context.reason}`}`);
    const denied = record.decisions.filter((d) => d.verdict === "deny").length;
    lines.push(`permissions: ${record.decisions.length} asked, ${denied} refused`);
    lines.push(`fs/terminal requests: ${record.fsRequests.length} (${record.fsRequests.filter((r) => r.outcome === "refused").length} refused)`);
    lines.push(`cost: ${record.cost === "missing" ? "missing (not reported by the agent)" : `${record.cost.amount} ${record.cost.currency}`}`);
    if (record.patchArtifact !== undefined) lines.push(`patch (never applied): ${record.patchArtifact}`);
    if (record.sessionId !== undefined) lines.push(`session: ${record.sessionId}`);
  }
  lines.push("", outcome.output);
  return lines;
}

/** `--help` for the external surface. */
export function printExternalHelp(): void {
  helpTitle("keryx agents external", "inspect the external agent registry, or drive one ACP agent");
  helpUsage([
    "keryx agents external list [--json] [--no-probe]",
    "keryx agents external probe <id> [--json]",
    'keryx agents external run <id> --task "<text>" [--unattended] [--write] [--timeout <ms>] [--json]',
  ]);
  helpOptions([
    { flag: "--json", desc: "Emit the registry + availability document (list/probe) or the run outcome (run) as JSON." },
    { flag: "--no-probe", desc: "Skip detection entirely; every entry reports `not-probed`." },
    { flag: "--task", desc: "run: what the agent should do. It runs in a disposable worktree; your tree is never touched." },
    { flag: "--unattended", desc: "run: refuse every permission that would need a human (also implied without a TTY)." },
    { flag: "--write", desc: "run: advertise fs.writeTextFile; writes land in the worktree and leave as a never-applied patch." },
    { flag: "--timeout", desc: "run: wall-clock ceiling in ms (default: externalAgents.defaultTimeoutMs)." },
  ]);
}
