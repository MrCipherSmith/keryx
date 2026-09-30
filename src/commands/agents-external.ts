// `keryx agents external` (flow 176, T15).
// Package: docs/requirements/keryx-external-agent-runtime §8.1; security-policy §1.
//
//   keryx agents external list  [--json] [--no-probe]
//   keryx agents external probe <id> [--json]
//   keryx agents external run <id> --task "<text>" [--unattended] [--write]   (flow 292, 357)
//   keryx agents external review <run-id>                                      (flow 370)
//   keryx agents external apply <run-id> [--allow-flagged]                     (flow 370)
//   keryx agents external discard <run-id>                                     (flow 370)
//
// `run` is the one subcommand that starts a real agent, and it spends the
// operator's quota; it drives EITHER transport — an ACP agent with keryx as
// its CLIENT, or a line-stream (codec) agent's one-way stream-json — through
// the SAME `runExternalChild` and every gate the runtime already has (flow
// 357 widened this from ACP-only: `runExternalChild` always drove both, only
// this command's own early refusal did not). `list` and `probe` are read-only
// and neither spends subscription quota: the only process either starts is
// the registry entry's own `detect` argv, which is `--version`. keryx never
// opens a vendor credential store, not even to answer "is the operator logged
// in?" (security-policy §1, `provider-auth` D-01).
//
// `run` ALSO carries two gates specific to a subscription-vendor agent (flow
// 357, AC6): the `/external` block-list (an agent on it is refused before
// anything spawns, the same `ExternalBlockedError` a blocked LLM provider
// already throws) and, for an agent `agentRequiresConsent` names, a one-time
// TTY consent recorded at `externalAgents.consent[id]` — a non-TTY dispatch
// with no recorded consent is refused with `consent-required` rather than
// assuming "yes" on the operator's behalf.
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
  checkExternalAgentVendorGates,
  recordExternalAgentConsent,
  resolveExternalAgentsCapability,
  type ExternalAgentsConfig,
} from "../capability/external-agents";
import { createGitWorktreePort } from "../harness/child/git-worktree-port";
import type { WorktreePort } from "../harness/child/worktree";
import { createBunSpawnPort } from "../harness/external/bun-spawn-port";
import { readExternalDepth } from "../harness/external/env";
import { CODEC_WRITE_AGENT_IDS } from "../harness/external/dispatch";
import { runExternalChild, type ExternalChildOutcome, type RunExternalChildInput } from "../harness/external/runtime";
import { runExternalWriteChild, type ExternalWriteRunResult } from "../harness/external/write-run";
import { discardWriteRun, landWriteRun, viewWriteRun, type WriteRunView } from "../harness/external/write-land";
import type { ExternalSpawnPort } from "../harness/external/supervise";
import type { AcpChildOptions } from "../harness/external/acp-run";
import { DEFAULT_MAX_EXTERNAL_DEPTH } from "../harness/run-external-factory";
import type { AgentIO } from "./agent";
import { VERSION } from "../cli-registry";
import { getProjectPermissionMode } from "../lib/permission-mode-config";
import { optionValue } from "../lib/args";
import { TerminalSafeTracker, terminalSafe, terminalSafeBlock } from "../lib/terminal-safe";
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
  /** Everything ACP-specific the runtime forwards (argv override, context, data dir…). Ignored for a line-stream agent. */
  readonly acp?: AcpChildOptions;
  /** keryx data dir for a write run's stored record (tests). */
  readonly dataDir?: string;
  readonly onOutcome?: (outcome: ExternalChildOutcome) => void;
  /**
   * One-time agent consent (flow 357, AC6). Defaults to a terminal y/N prompt
   * (`terminalConsentApprover`). Only reached for an agent
   * `agentRequiresConsent` names, and only once — a recorded consent short-
   * circuits this entirely.
   */
  readonly requestConsent?: (entry: ExternalAgentEntry) => Promise<boolean>;
  /** Whether stdout is a terminal, for `apply`. Defaults to `process.stdout.isTTY`. `apply` needs `isTTY` (stdin) AND this. */
  readonly stdoutIsTTY?: boolean;
  /** How `apply` asks its one question and reads the answer. Defaults to a readline prompt on the terminal. */
  readonly prompt?: (question: string) => Promise<string>;
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

  if (subcommand === "review" || subcommand === "apply" || subcommand === "discard") {
    if (args.includes("--help") || args.includes("-h")) {
      printExternalHelp();
      return;
    }
    const runId = args.slice(1).find((arg) => !arg.startsWith("-"));
    if (runId === undefined) {
      console.error(`Provide a run id: keryx agents external ${subcommand} <run-id>${subcommand === "apply" ? " [--allow-flagged]" : ""}`);
      process.exitCode = 1;
      return;
    }
    if (subcommand === "review") await reviewCommand(runId, deps, log);
    else if (subcommand === "apply") await applyCommand(runId, args.includes("--allow-flagged"), deps, log);
    else discardCommand(runId, deps, log);
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
 * The consent statement shown once for an agent `agentRequiresConsent` names
 * (flow 357, AC6) — the terms-of-service residual risk and Google's default
 * data collection, stated plainly rather than buried in a flag's `--help`
 * text. `entry.label`/`entry.binary` keep this generic to any future agent
 * that joins {@link agentRequiresConsent}'s set, even though only
 * `antigravity-cli` does today.
 */
export function consentStatement(entry: ExternalAgentEntry): string {
  return (
    `${entry.label} (\`${entry.binary}\`) sends prompts and agent actions to Google by default ` +
    `(Antigravity "Interactions" collection) once keryx drives it. Running the OFFICIAL binary ` +
    `headlessly, the way you would run it by hand, is the boundary keryx stays inside — it never ` +
    `reads, copies or proxies your Google/Antigravity credential (docs/requirements/` +
    `keryx-antigravity-agent/brd.md). Using a third-party client to reach the Antigravity service ` +
    `by other means is a breach of Google's Antigravity terms; driving the official CLI through its ` +
    `own documented headless mode is not that, but the residual risk of Google changing its own terms ` +
    `is yours to accept, not keryx's to absorb silently. Disable Google's own Interactions collection ` +
    `in the Antigravity CLI's own settings if you do not want it, or run \`/external off\` to stop keryx ` +
    `sending this agent anything at all. This is asked once; keryx will not ask again.`
  );
}

/**
 * A consent approver that asks on the terminal (flow 357, AC6): default `N`,
 * same shape as {@link terminalApprover} and for the same reason — a
 * subscription's own terms are not something a timeout or a blank line should
 * be read as accepting.
 */
export function terminalConsentApprover(
  io: { readonly input?: NodeJS.ReadableStream; readonly output?: NodeJS.WritableStream } = {},
): (entry: ExternalAgentEntry) => Promise<boolean> {
  return (entry) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: io.input ?? process.stdin, output: io.output ?? process.stderr });
      rl.question(`\n${consentStatement(entry)}\n\nAccept and continue? [y/N] `, (answer) => {
        rl.close();
        resolve(answer.trim().toLowerCase() === "y");
      });
    });
}

/**
 * `keryx agents external run <id> --task "<text>" [--unattended] [--write]`
 * (flow 176, 292, 357): drive one registry agent — ACP (keryx as client) or
 * line-stream (a codec) — through `runExternalChild`.
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
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const isTTY = seams.isTTY ?? process.stdin.isTTY === true;

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

  // AC6: the `/external` block-list and the one-time vendor consent — the
  // SAME check a model-initiated dispatch runs in `run-external-factory.ts`,
  // so neither entry point walks around the other's gate. Consent is asked
  // HERE only, on a TTY: a process with no human attached cannot give
  // informed consent, and assuming "yes" would put the operator's account at
  // risk without them ever seeing the terms.
  const vendorGate = await checkExternalAgentVendorGates({
    agentId: id,
    cwd,
    config: gate.config,
    ...(deps.configDir === undefined ? {} : { configDir: deps.configDir }),
  });
  if (vendorGate !== undefined) {
    if (vendorGate.code !== "consent-required" || !isTTY) {
      console.error(vendorGate.reason);
      process.exitCode = 1;
      return;
    }
    const requestConsent = seams.requestConsent ?? terminalConsentApprover();
    const accepted = await requestConsent(entry);
    if (!accepted) {
      console.error(`refused: consent declined for "${id}"`);
      process.exitCode = 1;
      return;
    }
    recordExternalAgentConsent(id, VERSION, deps.configDir);
  }

  const write = args.includes("--write");
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

  const runInput: RunExternalChildInput = {
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
  };
  const runDeps = {
    spawn: seams.spawn ?? createBunSpawnPort(),
    capability: () => ({ enabled: true }),
    ...(detect === undefined ? {} : { detect }),
    maxExternalDepth: DEFAULT_MAX_EXTERNAL_DEPTH,
    onWarning: (warning: string) => console.error(`warning: ${plain(warning)}`),
  };

  // A claude or codex write run owns its worktree: the diff is captured just before the
  // worktree is removed, and stored for `keryx agents external review`.
  if (write && CODEC_WRITE_AGENT_IDS.includes(id)) {
    let handle: { kill(): void } | undefined;
    let interrupted = false;
    // `on`, not `once`: a second Ctrl-C must not take the default disposition and skip the capture and cleanup.
    const onSigint = (): void => {
      interrupted = true;
      handle?.kill();
    };
    process.on("SIGINT", onSigint);
    const realSpawn = runDeps.spawn;
    let result: ExternalWriteRunResult;
    try {
      result = await runExternalWriteChild(runInput, {
        ...runDeps,
        // A Ctrl-C before the child exists ends the run here, before a paid write child starts.
        spawn: {
          spawn: (argv, opts) => {
            if (interrupted) throw new Error("interrupted before the agent started; no agent was run");
            return realSpawn.spawn(argv, opts);
          },
        },
        onSpawned: (spawned) => {
          handle = spawned;
          if (interrupted) spawned.kill();
        },
        projectRoot: cwd,
        worktreesDir,
        ...(seams.worktree === undefined ? {} : { worktree: seams.worktree }),
        ...(seams.dataDir === undefined ? {} : { dataDir: seams.dataDir }),
      });
    } finally {
      process.off("SIGINT", onSigint);
    }
    seams.onOutcome?.(result.outcome);
    if (json) {
      log(JSON.stringify({ ...result.outcome, write: result.run }, null, 2));
    } else {
      for (const line of renderRunOutcome(result.outcome)) log(line);
      for (const line of renderWriteRun(result)) log(line);
    }
    if (result.outcome.status !== "Completed" || result.captureError !== undefined || result.run?.state === "refused") {
      process.exitCode = 1;
    }
    return;
  }

  const outcome = await runExternalChild(runInput, {
    ...runDeps,
    worktree,
    acp: {
      ...seams.acp,
      mode: seams.acp?.mode ?? getProjectPermissionMode(cwd) ?? "ask",
      unattended,
      ...(requestApproval === undefined ? {} : { requestApproval }),
    },
  });
  seams.onOutcome?.(outcome);

  if (json) {
    log(JSON.stringify(outcome, null, 2));
  } else {
    for (const line of renderRunOutcome(outcome)) log(line);
  }
  if (outcome.status !== "Completed") process.exitCode = 1;
}

/** Shown when anything agent-controlled had to be escaped before printing. */
const ESCAPED_NOTE =
  "note: control characters in this run's paths or patch are shown as \\xNN escapes; the stored patch and its hash are unchanged";

/** The write-run section of the report: patch, hash, files, flagged paths and the next command. Pure. */
export function renderWriteRun(result: ExternalWriteRunResult): string[] {
  const safe = new TerminalSafeTracker();
  const lines = writeRunLines(result, safe);
  if (safe.escaped) lines.push(ESCAPED_NOTE);
  return lines;
}

function writeRunLines(result: ExternalWriteRunResult, safe: TerminalSafeTracker): string[] {
  const lines: string[] = [""];
  if (result.captureError !== undefined) {
    lines.push(`warning: the worktree's changes could not be captured (${safe.render(result.captureError)}); nothing was stored`);
    return lines;
  }
  const run = result.run;
  if (run === undefined) {
    lines.push(
      result.persistError !== undefined
        ? `warning: the write run could not be stored (${safe.render(result.persistError)})`
        : "no changes: the agent left the worktree as it found it",
    );
    return lines;
  }
  if (run.state === "refused") {
    lines.push(`refused: ${run.refusedPaths.length} changed symlink(s) point outside the worktree; no patch was kept`);
    for (const refused of run.refusedPaths) lines.push(`  ${safe.render(refused)}`);
    lines.push(`run: ${safe.render(run.runId)}`);
    return lines;
  }
  lines.push(`patch (never applied): ${safe.render(run.patchPath ?? "")}`);
  lines.push(`patch hash (sha256): ${run.patchHash ?? ""}${run.redacted ? " (redacted; may not apply byte for byte)" : ""}`);
  lines.push(`files (${run.files.length}):`);
  for (const file of run.files) lines.push(`  ${file.status.padEnd(12)} ${safe.render(file.path)}${file.binary === true ? " (binary: noted, not carried)" : ""}`);
  if (run.flaggedPaths.length > 0) {
    lines.push(`flagged paths (${run.flaggedPaths.length}) — look at these first:`);
    for (const flagged of run.flaggedPaths) lines.push(`  ${safe.render(flagged)}`);
  }
  lines.push(`review with: keryx agents external review ${safe.render(run.runId)}`);
  return lines;
}

/** How many leading hex characters of the patch hash the operator types back to land a diff. */
const CONFIRM_HASH_CHARS = 12;

/**
 * The review screen for one stored write run: identity, flagged paths first, files, then the redacted patch.
 * Everything the agent controls is printed through the terminal-safe filter (\n and \t stay in the patch). Pure.
 */
export function renderWriteReview(view: WriteRunView): string[] {
  const { record } = view;
  const safe = new TerminalSafeTracker();
  const lines = [
    "# agents external review",
    "",
    `run: ${safe.render(record.runId)}`,
    `agent: ${safe.render(record.agentId)}`,
    `base commit: ${safe.render(record.baseCommit)}`,
    `run status: ${safe.render(record.runStatus)}`,
    `patch hash (sha256): ${record.patchHash === undefined ? "none (no patch was kept)" : record.patchHash}`,
  ];
  const finish = (): string[] => {
    if (safe.escaped) lines.splice(2, 0, ESCAPED_NOTE);
    return lines;
  };
  if (record.state === "refused") {
    lines.push("", `refused: ${record.refusedPaths.length} changed symlink(s) point outside the worktree; no patch was kept`);
    for (const refused of record.refusedPaths) lines.push(`  ! ${safe.render(refused)}`);
    lines.push(`this run can only be discarded: keryx agents external discard ${safe.render(record.runId)}`);
    return finish();
  }
  if (record.redacted) lines.push("note: the patch was redacted, so it may not apply byte for byte and cannot be applied");
  if (record.flaggedPaths.length > 0) {
    lines.push("", `FLAGGED PATHS (${record.flaggedPaths.length}) — repo plumbing, CI, hooks or agent config; look at these first:`);
    for (const flagged of record.flaggedPaths) lines.push(`  ! ${safe.render(flagged)}`);
  }
  lines.push("", `files (${record.files.length}):`);
  for (const file of record.files) lines.push(`  ${file.status.padEnd(12)} ${safe.render(file.path)}${file.binary === true ? " (binary: noted, not carried)" : ""}`);
  lines.push("");
  if (view.patch === undefined) lines.push("patch: unavailable (missing, or changed since it was captured)");
  else lines.push("patch:", safe.renderBlock(view.patch.replace(/\n$/, "")));
  return finish();
}

/** One agent- or user-derived string made safe to print. */
const plain = (value: string): string => terminalSafe(value).text;

function landDepsOf(deps: AgentsExternalDeps): { dataDir?: string } {
  return deps.run?.dataDir === undefined ? {} : { dataDir: deps.run.dataDir };
}

async function reviewCommand(runId: string, deps: AgentsExternalDeps, log: (line: string) => void): Promise<void> {
  const view = viewWriteRun(deps.cwd ?? process.cwd(), runId, landDepsOf(deps));
  if (view === undefined) {
    console.error(`no external write run "${plain(runId)}" in this checkout`);
    process.exitCode = 1;
    return;
  }
  for (const line of renderWriteReview(view)) log(line);
}

/** A readline question on the terminal. Resolves to an empty answer when stdin closes first. */
export function terminalPrompt(
  io: { readonly input?: NodeJS.ReadableStream; readonly output?: NodeJS.WritableStream } = {},
): (question: string) => Promise<string> {
  return (question) =>
    new Promise((resolve) => {
      const rl = createInterface({ input: io.input ?? process.stdin, output: io.output ?? process.stdout });
      let answered = false;
      rl.on("close", () => {
        if (!answered) resolve("");
      });
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(answer);
      });
    });
}

/**
 * `apply`: show the review, then land the diff as `external/<run-id>` only when a human types
 * the first 12 hex digits of the patch hash. There is deliberately no flag or environment
 * variable that answers for the operator; without a terminal on both ends nothing lands.
 */
async function applyCommand(runId: string, allowFlagged: boolean, deps: AgentsExternalDeps, log: (line: string) => void): Promise<void> {
  const seams = deps.run ?? {};
  const interactive = (seams.isTTY ?? process.stdin.isTTY === true) && (seams.stdoutIsTTY ?? process.stdout.isTTY === true);
  if (!interactive) {
    console.error("apply needs a terminal: nobody can answer for you");
    process.exitCode = 1;
    return;
  }
  const cwd = deps.cwd ?? process.cwd();
  const landDeps = landDepsOf(deps);
  const view = viewWriteRun(cwd, runId, landDeps);
  if (view === undefined) {
    console.error(`no external write run "${plain(runId)}" in this checkout`);
    process.exitCode = 1;
    return;
  }
  for (const line of renderWriteReview(view)) log(line);
  const { record } = view;
  if (record.state !== "pending-review" || record.patchHash === undefined || view.patch === undefined) {
    console.error(
      record.state === "refused"
        ? `refused: this run can only be discarded (keryx agents external discard ${plain(record.runId)})`
        : "refused: the stored patch is missing or changed since capture; nothing was applied",
    );
    process.exitCode = 1;
    return;
  }
  const expected = record.patchHash.slice(0, CONFIRM_HASH_CHARS);
  const answer = await (seams.prompt ?? terminalPrompt())(
    `\nType the first ${CONFIRM_HASH_CHARS} hex digits of the patch hash (without any sha256: prefix) to land this diff (anything else cancels): `,
  );
  if (answer !== expected) {
    log("cancelled: nothing was applied");
    process.exitCode = 1;
    return;
  }
  const result = await landWriteRun(
    { cwd, runId: record.runId, confirmedPatchHash: record.patchHash, ...(allowFlagged ? { allowFlagged: true } : {}) },
    landDeps,
  );
  if (result.kind === "refused") {
    console.error(`refused (${plain(result.reason)}): ${plain(result.detail)}`);
    process.exitCode = 1;
    return;
  }
  log(`landed: branch ${plain(result.branch)}`);
  log(`commit: ${plain(result.commit)}`);
  log("nothing was applied to your current branch or working tree");
}

function discardCommand(runId: string, deps: AgentsExternalDeps, log: (line: string) => void): void {
  const result = discardWriteRun({ cwd: deps.cwd ?? process.cwd(), runId }, landDepsOf(deps));
  if (result.kind === "refused") {
    console.error(`refused (${plain(result.reason)}): ${plain(result.detail)}`);
    process.exitCode = 1;
    return;
  }
  log(`discarded: ${plain(runId)}; the stored patch was deleted`);
}

/** The text report for one run. Pure. */
export function renderRunOutcome(outcome: ExternalChildOutcome): string[] {
  const lines = [`# agents external run`, "", `status: ${outcome.status}`];
  const record = outcome.acp;
  if (record !== undefined) {
    const info = record.agentInfo === "unreported" ? "unreported" : plain(`${record.agentInfo.name} ${record.agentInfo.version}`);
    lines.push(`agent: ${plain(record.agentId)} (${info})`);
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
    if (record.sessionId !== undefined) lines.push(`session: ${plain(record.sessionId)}`);
  } else {
    // Line-stream transport (flow 357): no ACP record, but the codec still
    // reports what it can — the resume handle, usage and the version-drift
    // signal.
    if (outcome.sessionRef !== undefined) lines.push(`conversation: ${plain(outcome.sessionRef)}`);
    if (outcome.costUnits !== undefined) lines.push(`cost: ${outcome.costUnits}`);
    if (outcome.skippedLines !== undefined && outcome.skippedLines > 0) {
      lines.push(`unrecognised lines: ${outcome.skippedLines} (possible version drift)`);
    }
  }
  if (outcome.partial !== undefined) lines.push(`partial output: ${plain(outcome.partial)}`);
  lines.push("", terminalSafeBlock(outcome.output).text);
  return lines;
}

/** `--help` for the external surface. */
export function printExternalHelp(): void {
  helpTitle("keryx agents external", "inspect the external agent registry, or drive one ACP or line-stream agent");
  helpUsage([
    "keryx agents external list [--json] [--no-probe]",
    "keryx agents external probe <id> [--json]",
    'keryx agents external run <id> --task "<text>" [--unattended] [--write] [--timeout <ms>] [--json]',
    "keryx agents external review <run-id>",
    "keryx agents external apply <run-id> [--allow-flagged]",
    "keryx agents external discard <run-id>",
  ]);
  helpOptions([
    { flag: "review", desc: "Show one stored write run: flagged paths first, the file list, then the redacted patch. Nothing is changed." },
    { flag: "apply", desc: "Land a stored write run as the new local branch external/<run-id>. Needs a terminal: you type the first 12 characters of the patch hash. Your current branch and working tree are never touched." },
    { flag: "--allow-flagged", desc: "apply: also land a diff that touches flagged paths (.git, CI, hooks, agent config). It does not skip the hash prompt." },
    { flag: "discard", desc: "Drop a stored write run and delete its patch." },
    { flag: "--json", desc: "Emit the registry + availability document (list/probe) or the run outcome (run) as JSON." },
    { flag: "--no-probe", desc: "Skip detection entirely; every entry reports `not-probed`." },
    { flag: "--task", desc: "run: what the agent should do. It runs in a disposable worktree; your tree is never touched." },
    { flag: "--unattended", desc: "run: refuse every permission that would need a human (also implied without a TTY)." },
    { flag: "--write", desc: "run: writes land in the disposable worktree and leave as a never-applied patch. An ACP agent advertises fs.writeTextFile; for a line-stream agent only claude-cli and codex-cli are supported. claude gets Edit and Write inside the worktree and no shell; codex runs under its OS sandbox (writes confined to the worktree, network closed as far as measured) and keeps a shell that can read any file you can read. codex needs version 0.159.2 or newer but older than 0.160.0. antigravity-cli is refused: its edit tool writes outside the worktree." },
    { flag: "--timeout", desc: "run: wall-clock ceiling in ms (default: externalAgents.defaultTimeoutMs)." },
  ]);
}
