// The `runExternal` factory (flow 176, T15).
// Package: docs/requirements/keryx-external-agent-runtime §3, §7.1, §9.
//
// `spawn_subagent` exposes exactly one seam for external children — the optional
// `SpawnSubagentToolDeps.runExternal` hook — and this module is the only thing
// that builds one. It composes what T6-T14 already shipped: the capability gate,
// the user-global config, the real spawn port, the real git worktree port, and
// `runExternalChild` itself.
//
// Two properties matter more than anything else here.
//
//   1. **It returns `undefined` when the capability is unavailable.** Not a
//      closure that refuses — no closure at all. A host that asks for the hook
//      while the feature is disabled simply gets no hook, `spawn_subagent`'s
//      external branch is never entered, and the seam stays provably inert. A
//      stub that returned `Denied` would still be a live code path through the
//      external subsystem on a machine that opted out.
//   2. **Every refusal is named.** The reason the capability was unavailable is
//      handed to `onUnavailable` rather than dropped, because the operator who
//      enabled the feature and sees nothing happen needs to be told why
//      (security-policy §5). The same applies inside the closure: a disabled
//      agent, a missing approver, an unreadable runtime block each produce a
//      `Denied` carrying its own sentence.
//
// This module wires NOTHING into a call site. `commands/shell.ts` and the TUI
// own that; keeping it out of here is what lets the factory be tested with no
// shell, no provider and no process.

import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  agentConfig,
  resolveExternalAgentsCapability,
  type ExternalAgentsConfig,
  type ExternalTransport,
} from "../capability/external-agents";
import { createGitWorktreePort } from "./child/git-worktree-port";
import type { CreatedWorktree, WorktreePort } from "./child/worktree";
import { createBunSpawnPort } from "./external/bun-spawn-port";
import { readRuntimeBlock, type RuntimeBlock } from "./external/dispatch";
import { readExternalDepth } from "./external/env";
import type { DetectionOutcome } from "./external/registry";
import { runExternalChild, type ExternalChildOutcome } from "./external/runtime";
import type { ExternalRunHandle, ExternalSpawnPort } from "./external/supervise";
import type { ExternalEvent } from "./external/types";
import type { SpawnSubagentToolDeps, StructuredSubagentResult, SubagentMode } from "./tool/builtin/spawn-subagent-tool";

const execFileAsync = promisify(execFile);

/** Exactly the hook `spawn_subagent` accepts. Derived, so the two cannot drift. */
export type RunExternalFn = NonNullable<SpawnSubagentToolDeps["runExternal"]>;

/** The request `spawn_subagent` hands the hook. */
export type RunExternalRequest = Parameters<RunExternalFn>[0];

/**
 * Default ceiling on external nesting.
 *
 * `1` means: this keryx may start an external child, and a keryx started from
 * inside that child may not start another. An external CLI has a shell and will
 * find `keryx`, so the depth marker checked on ENTRY is the only control that
 * does not depend on a model complying with the prompt directive.
 */
export const DEFAULT_MAX_EXTERNAL_DEPTH = 1;

/**
 * `allowed_actions` synthesised from the subagent mode.
 *
 * The `runExternal` request carries a mode, not a dispatch, so the consistency
 * check `validateRuntimeBlock` performs needs an action list built here. Neither
 * list contains `write`, `network` or `spawn-subagent`: this release implements
 * only the `read-only` sandbox, and a dispatch that claimed those actions would
 * be refused as self-contradictory — correctly, but with a confusing reason.
 * `run-command` is present for `general` because an external CLI necessarily
 * runs commands inside its own sandbox; that axis is governed by the sandbox
 * flag and the disposable worktree, not by this list.
 */
const ALLOWED_ACTIONS_BY_MODE: Readonly<Record<SubagentMode, readonly string[]>> = {
  read_only: ["read-file"],
  general: ["read-file", "run-command"],
};

/** What a host must decide before a model-initiated spawn may run under `spawnDecision: "ask"`. */
export interface ExternalSpawnApprovalRequest {
  readonly agentId: string;
  readonly label: string;
  readonly task: string;
  readonly sandbox: string | undefined;
}

/** Everything {@link createRunExternal} needs, all of it injectable for offline tests. */
export interface CreateRunExternalOptions {
  /** Project root: the git repository external worktrees are cut from, and the manifest that may veto. */
  readonly cwd: string;
  /** Environment for transport/CI detection and for the child env build. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Explicit transport when the host knows it without an env marker. */
  readonly transport?: ExternalTransport;
  /** Pre-loaded config; omitted means read the user-global shell config. */
  readonly config?: ExternalAgentsConfig;
  /** Shell-config directory override (tests). */
  readonly configDir?: string;
  /** Where disposable worktrees are created. Defaults to a keryx directory under the OS temp dir. */
  readonly worktreesDir?: string;
  /** Process spawn seam. Defaults to the real `Bun.spawn`-backed port. */
  readonly spawn?: ExternalSpawnPort;
  /** Worktree seam. Defaults to a real `git worktree` port rooted at `cwd`. */
  readonly worktree?: WorktreePort;
  /** Version probe. Omitted means the run does not probe — `not-probed` is a real state, never an assumption. */
  readonly detect?: (binary: string, argv: readonly string[]) => Promise<DetectionOutcome>;
  /**
   * Approver for model-initiated spawns. Required in practice while
   * `spawnDecision` is `"ask"` (the default): with no approver the closure
   * refuses every run with a named reason rather than silently self-approving
   * something the operator asked to be asked about (security-policy §6).
   */
  readonly approve?: (request: ExternalSpawnApprovalRequest) => Promise<boolean>;
  /** The operator's uncommitted diff. Defaults to `git diff HEAD` in `cwd`; a detached worktree has none. */
  readonly readWorkingDiff?: () => Promise<string | undefined>;
  /** Ceiling on external nesting. Defaults to {@link DEFAULT_MAX_EXTERNAL_DEPTH}. */
  readonly maxExternalDepth?: number;
  /** Canonical events from the run, for the TUI/monitor folds. */
  readonly onEvent?: (event: ExternalEvent) => void;
  /**
   * The live handle on the running child — `kill()` and `writeStdin()`.
   *
   * Without this the operator surface can COMPUTE a delivery intent (§7.5) and a
   * supervision kill (§7.6) but cannot execute either, because both happen while
   * the run is still in flight and therefore cannot travel through the return
   * value. Forwarded straight to `runExternalChild`; a host that does not steer
   * runs simply omits it.
   */
  readonly onSpawned?: (handle: ExternalRunHandle) => void;
  /** Advisory warnings (version out of range, diff truncated). Recorded, never thrown. */
  readonly onWarning?: (warning: string) => void;
  /**
   * The full outcome, including argv, cost and the parse-skip counter.
   *
   * `StructuredSubagentResult` cannot carry them — it is `spawn_subagent`'s
   * shape and must stay a strict superset of `InteractiveToolResult` — and
   * appending them to `output` would put machine facts into the parent model's
   * context, where cost figures become tokens and argv becomes an instruction.
   */
  readonly onOutcome?: (outcome: ExternalChildOutcome) => void;
  /** Why the capability was unavailable, when {@link createRunExternal} returns undefined. */
  readonly onUnavailable?: (reason: string) => void;
  /** Session-id generator; injectable so a test's argv is deterministic. */
  readonly idSeq?: () => string;
}

/** A refusal that happened before any process existed. */
function denied(reason: string): StructuredSubagentResult {
  return { status: "Denied", output: reason, isError: true };
}

/**
 * Make a worker id safe to use as a directory name.
 *
 * `spawn_subagent` mints ids like `sub:<uuid>`; a colon is legal on Linux and
 * not on every filesystem keryx runs on, and a worktree path that fails to
 * create would surface as the external agent failing rather than as a naming
 * bug.
 */
function worktreeIdFor(workerId: string): string {
  return `ext-${workerId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

/** `git diff HEAD` in `cwd`; undefined when there is nothing, or when git says no. */
async function defaultWorkingDiff(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "HEAD"], { cwd, maxBuffer: 8 * 1_024 * 1_024 });
    return stdout.trim().length > 0 ? stdout : undefined;
  } catch {
    // Not a repository, a git that failed, or a diff too large for the buffer.
    // The run proceeds against HEAD: a missing diff costs the agent context, and
    // failing the dispatch over it would be a worse trade.
    return undefined;
  }
}

/**
 * A worktree port that creates its parent directory first.
 *
 * `git worktree add` creates the leaf and not the path above it, and the default
 * location is under the OS temp dir, which may not carry a keryx directory yet.
 * Wrapping rather than changing `createGitWorktreePort` keeps that adapter
 * usable by the benchmark runner it was written for.
 */
function ensuringParentDir(port: WorktreePort, worktreesDir: string): WorktreePort {
  return {
    async create(worktreeId: string): Promise<CreatedWorktree> {
      await mkdir(worktreesDir, { recursive: true });
      return port.create(worktreeId);
    },
    remove: (worktreeId) => port.remove(worktreeId),
    merge: (worktreeId, into) => port.merge(worktreeId, into),
  };
}

/** Fold an external outcome onto `spawn_subagent`'s result shape. */
function toStructuredResult(outcome: ExternalChildOutcome): StructuredSubagentResult {
  return {
    status: outcome.status,
    output: outcome.output,
    isError: outcome.isError,
    ...(outcome.partial === undefined ? {} : { partial: outcome.partial }),
  };
}

/**
 * Build the `runExternal` closure, or `undefined` when the capability is
 * unavailable.
 *
 * Resolution happens ONCE, here, and not per call: transport and CI are
 * process-lifetime facts, and the operator's config is read at the moment the
 * host wires its tools — which is also when a refusal can still be shown to
 * them. `onUnavailable` receives the named reason.
 *
 * The returned closure never throws: `spawn_subagent` treats a throwing hook as
 * a keryx bug, so every failure inside it resolves to a `Denied`/`Error` result
 * carrying its own sentence instead.
 */
export async function createRunExternal(
  options: CreateRunExternalOptions,
): Promise<RunExternalFn | undefined> {
  const env = options.env ?? process.env;
  const gate = await resolveExternalAgentsCapability({
    cwd: options.cwd,
    env,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
  });
  if (!gate.ok) {
    options.onUnavailable?.(gate.reason);
    return undefined;
  }

  const config = gate.config;
  const idSeq = options.idSeq ?? (() => randomUUID());
  const worktreesDir = options.worktreesDir ?? path.join(tmpdir(), "keryx-external-worktrees");
  const spawn = options.spawn ?? createBunSpawnPort();
  const worktree =
    options.worktree ??
    ensuringParentDir(createGitWorktreePort({ repoRoot: options.cwd, worktreesDir }), worktreesDir);
  const readWorkingDiff = options.readWorkingDiff ?? (() => defaultWorkingDiff(options.cwd));
  const maxExternalDepth = options.maxExternalDepth ?? DEFAULT_MAX_EXTERNAL_DEPTH;

  return async (request: RunExternalRequest): Promise<StructuredSubagentResult> => {
    // `readRuntimeBlock` expects a dispatch-shaped object; the hook is handed the
    // block itself. Re-wrapping reuses the one defensive reader rather than
    // adding a second, divergent parser of the same contract.
    const block = readRuntimeBlock({ runtime: request.runtime });
    if (block === undefined || block.kind !== "external") {
      return denied("the dispatch's runtime block is missing or is not an external runtime block");
    }

    const agentId = typeof block.agent === "string" ? block.agent : undefined;
    if (agentId !== undefined) {
      const perAgent = agentConfig(config, agentId);
      if (!perAgent.enabled) {
        return denied(
          `external agent "${agentId}" is disabled; enable it under \`externalAgents.agents.${agentId}\` in the keryx user config`,
        );
      }
    }

    if (config.spawnDecision === "ask") {
      if (options.approve === undefined) {
        // Fail-closed on purpose. `ask` is the default precisely because an
        // agent nobody is watching can exhaust paid quota, and a host that
        // wired no approver cannot ask — so it must not proceed as if it had.
        return denied(
          "model-initiated external spawns require approval (`externalAgents.spawnDecision` is \"ask\") " +
            "and this host wired no approver; set it to \"allow\" to permit unattended spawns",
        );
      }
      let approved: boolean;
      try {
        approved = await options.approve({
          agentId: agentId ?? "(unnamed)",
          label: request.label,
          task: request.task,
          sandbox: block.sandbox,
        });
      } catch {
        // An approver that throws has not approved anything.
        approved = false;
      }
      if (!approved) {
        return denied(`the external spawn of "${agentId ?? "(unnamed)"}" was not approved`);
      }
    }

    const perAgentModel = agentId === undefined ? null : agentConfig(config, agentId).model;
    // The dispatch wins over the config, and both may be null — which means "let
    // the CLI resolve its own default under the active subscription". keryx must
    // never pin a model the account may not be entitled to (§3).
    const model = block.model !== undefined && block.model !== null ? block.model : perAgentModel;
    const timeoutMs =
      typeof block.timeoutMs === "number" && Number.isFinite(block.timeoutMs) && block.timeoutMs > 0
        ? block.timeoutMs
        : config.defaultTimeoutMs;

    const runtime: RuntimeBlock = {
      kind: "external",
      ...(agentId === undefined ? {} : { agent: agentId }),
      ...(block.sandbox === undefined ? {} : { sandbox: block.sandbox }),
      model,
      ...(block.maxCostUnits === undefined ? {} : { maxCostUnits: block.maxCostUnits }),
    };

    const workingDiff = await readWorkingDiff();

    try {
      const outcome = await runExternalChild(
        {
          runtime,
          allowedActions: ALLOWED_ACTIONS_BY_MODE[request.mode],
          taskTitle: request.label,
          taskDescription: request.task,
          acceptanceCriteria: [],
          ...(workingDiff === undefined ? {} : { workingDiff }),
          worktreeId: worktreeIdFor(request.workerId),
          sessionId: idSeq(),
          maxPromptBytes: config.maxPromptBytes,
          timeoutMs,
          parentEnv: env,
          // Checked on ENTRY against the inherited marker: this child runs one
          // level deeper than whatever this process already is.
          depth: readExternalDepth(env) + 1,
        },
        {
          spawn,
          worktree,
          capability: () => ({ enabled: true }),
          ...(options.detect === undefined ? {} : { detect: options.detect }),
          maxExternalDepth,
          ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
          ...(options.onWarning === undefined ? {} : { onWarning: options.onWarning }),
          ...(options.onSpawned === undefined ? {} : { onSpawned: options.onSpawned }),
        },
      );
      options.onOutcome?.(outcome);
      return toStructuredResult(outcome);
    } catch (cause) {
      // `runExternalChild` is written not to throw, but its injected ports can.
      // A thrown port must not reach `spawn_subagent` as an exception: that path
      // reports "external runtime failed before the agent could report", which
      // is true but loses which port failed.
      const message = cause instanceof Error ? cause.message : String(cause);
      return { status: "Error", output: `external runtime failed: ${message}`, isError: true };
    }
  };
}

/**
 * A `runExternal` hook that resolves the capability on FIRST USE and caches it.
 *
 * {@link createRunExternal} is async — the gate reads config and the project
 * manifest — while `createSpawnSubagentTool` is constructed synchronously, and
 * both shells build their tool set before anything is awaited. Making the hosts
 * restructure their startup for a feature that is off by default would be the
 * tail wagging the dog, so the await moves here instead.
 *
 * Two consequences worth stating. The gate is evaluated when the first external
 * dispatch arrives, not at boot, so an operator who enables the capability
 * mid-session gets it on their next dispatch rather than after a restart. And an
 * unavailable capability answers `Denied` with a named reason — never silence,
 * because a silent no-op would leave the operator believing an agent ran
 * (security-policy §5).
 */
export function createLazyRunExternal(options: CreateRunExternalOptions): RunExternalFn {
  let resolved: Promise<RunExternalFn | undefined> | undefined;
  return async (request) => {
    resolved ??= createRunExternal(options);
    let hook: RunExternalFn | undefined;
    try {
      hook = await resolved;
    } catch (cause) {
      // A gate that throws must not surface as the vendor refusing. Clearing the
      // cache lets a transient config-read failure be retried on the next call.
      resolved = undefined;
      const message = cause instanceof Error ? cause.message : String(cause);
      return denied(`the external agent runtime could not be resolved: ${message}`);
    }
    if (hook === undefined) {
      return denied('the external agent runtime is unavailable; run `keryx agents external list` for the reason');
    }
    return hook(request);
  };
}
