// The operator loop for external children (flow 176, T18).
// Package: docs/requirements/keryx-external-agent-runtime §7.5, §8.2;
// prd R17, R18, R19, R20, R21, R25.
//
// T16 shipped every PIECE of the operator surface — the run store, the pure
// transcript/Meta/Command formatters, the inspector modal, the per-addressee
// queues and the delivery planner — and wired NONE of them to a live run. This
// module is the wiring, and it is a plain class with no OpenTUI dependency so
// the whole loop is exercisable headless. `tui-shell.ts` (2300 lines, and the
// single most change-averse file in the repo) does four small things with it:
// construct it, attach it, repaint on its hints, and route `/delegate`.
//
// What it owns, and why each piece cannot live anywhere else:
//
//   - THE LIVE HANDLES. `ExternalRunHandle` is handed out ONCE, mid-run, through
//     `onSpawned`; it is not on the outcome and cannot be recovered afterwards.
//     Nothing else in the shell holds a reference, so if this map is not kept,
//     `force` and every supervision kill (§7.6) become impossible for the rest
//     of the run's life.
//   - THE PER-ADDRESSEE QUEUES. `hold` is a real intent: a codex run that has
//     not yet announced its `thread_id` cannot take a message, and the message
//     must WAIT rather than be dropped. Something has to remember it and retry
//     when the handle appears, which is exactly what `flush` below does.
//   - THE OPERATOR-INITIATED RUN SET. `spawnDecision: "ask"` guards
//     MODEL-initiated spawns (the config field's own documentation says so, and
//     R25 says the model's default is `ask`). An operator who typed
//     `/delegate codex-cli …` has already decided; re-prompting them for the
//     command they just typed trains them to dismiss the prompt, which is how a
//     real approval gate stops working. So this module records the ids it minted
//     and auto-approves exactly those — never a run it did not start.
//
// One measured constraint runs through the delivery paths and is worth stating
// where it will be read: the shipped runtime spawns every external child with
// stdin IGNORED (`runExternalChild` calls `superviseExternalRun` without a
// `stdin` field, which defaults to `"ignore"` — §7.4 forbids inheriting it and
// the streaming shape is opt-in). So `launchedStreaming` is false for every run
// today and §7.5's stdin route is unreachable through the shipped runtime, which
// is why `planExternalDelivery` correctly sends every message down the resume
// path. The stdin branch is implemented and tested anyway: the fact is a
// property of the launcher, not of this module, and it flips the day a run is
// spawned steerable.

import { getExternalAgent } from "../harness/external/registry";
import type { ExternalRunHandle } from "../harness/external/supervise";
import type { ExternalRunInput, ExternalSandbox } from "../harness/external/types";
import { createLazyRunExternal } from "../harness/run-external-factory";
import type {
  ExternalRunObserver,
  ExternalSpawnApproval,
  ExternalSpawnApprovalRequest,
  RunExternalFn,
} from "../harness/run-external-factory";
import type { StructuredSubagentResult } from "../harness/tool/builtin/spawn-subagent-tool";
import {
  clearAddresseeQueue,
  editInAddresseeQueue,
  emptyAddresseeQueues,
  enqueueForAddressee,
  planExternalDelivery,
  queueFor,
  reinsertIntoAddresseeQueue,
  removeFromAddresseeQueue,
  type AddresseeQueues,
  type ExternalAddresseeState,
} from "./addressee-queue";
import { executeExternalDelivery, type ExternalDeliveryResult } from "./external-delivery";
import {
  approveExternalSpawn,
  externalRunBridgeObserver,
  setExternalRunListener,
  setExternalSpawnApprover,
  type ExternalRunSignal,
} from "./external-bridge";
import { ExternalRunStore } from "./external-session";
import { emitSubagentFleet } from "./subagent-bridge";
import type { ExternalRunView } from "./external-transcript";
import type { QueuedMainQuestion } from "./main-queue";

/** The sandbox every run in this release uses. `worktree-write` is refused upstream (D-04). */
export const OPERATOR_SANDBOX: ExternalSandbox = "read-only";

/** One queued operator message aimed at an external child. */
export interface QueuedExternalMessage extends QueuedMainQuestion {
  /** The operator used `/queue force`: interrupt now rather than wait your turn. */
  force?: boolean;
}

/** What changed, so a sidebar can repaint without re-reading everything. */
export type ExternalOperatorHint = {
  readonly id: string;
  readonly kind: "start" | "event" | "warning" | "end" | "queue";
};

/** Everything the controller needs. All of it injectable, so tests need no shell. */
export interface ExternalOperatorOptions {
  /**
   * The `runExternal` hook used by `/delegate`.
   *
   * Deliberately the SAME hook shape `spawn_subagent` uses, so an
   * operator-initiated run passes the identical capability gate, per-agent
   * enable check, depth ceiling, worktree containment and prompt assembly. A
   * second spawn path would be a second place for those gates to be forgotten.
   * Omitted means `/delegate` refuses with a named reason instead of pretending.
   */
  readonly runExternal?: RunExternalFn;
  /**
   * Called for every delivery this controller performs ON ITS OWN — i.e. from
   * {@link ExternalOperator.flush}, when a held message finally gets a route.
   *
   * Without it those results have no reader, and a message that turns out to be
   * `undeliverable` while it sat in the queue would be dropped with nobody told.
   * That is the exact failure §7.5 names: an operator who believes a message was
   * delivered stops watching for the reply. Deliveries the host requested
   * directly need no callback — `deliver()` returns the result to the caller.
   */
  readonly onDelivery?: (runId: string, result: ExternalDeliveryResult) => void;
  /** Id generator, injectable so a test's run ids are deterministic. */
  readonly idSeq?: () => string;
  /** Clock, forwarded to the store. */
  readonly now?: () => number;
}

/** What `/delegate` produced. */
export type DelegateOutcome =
  | { readonly ok: true; readonly runId: string; readonly label: string; readonly result: StructuredSubagentResult }
  | { readonly ok: false; readonly reason: string };

/** Per-run bookkeeping the store deliberately does not carry. */
interface RunControl {
  /** Cleared — not deleted — when the run ends, so a dead handle is never written to. */
  handle: ExternalRunHandle | undefined;
  agentId: string;
  label: string;
  sandbox?: ExternalSandbox;
  model?: string;
  worktreePath?: string;
  /** Whether this run was spawned with stdin piped. See the module header. */
  launchedStreaming: boolean;
}

/**
 * The live operator loop: signals in, store + queues + deliveries out.
 *
 * Construct one per TUI session. `attach()` returns the detach function; nothing
 * here registers itself with the module-level bridge on its own, so two shells
 * in one process (tests) cannot silently steal each other's runs.
 */
export class ExternalOperator {
  /** The store the inspector, the Meta view and the Command view all read. */
  readonly store: ExternalRunStore;

  private readonly control = new Map<string, RunControl>();
  private readonly operatorInitiated = new Set<string>();
  private readonly listeners = new Set<(hint: ExternalOperatorHint) => void>();
  private queues: AddresseeQueues = emptyAddresseeQueues();
  private readonly idSeq: () => string;
  private readonly options: ExternalOperatorOptions;

  constructor(options: ExternalOperatorOptions = {}) {
    this.options = options;
    this.store = new ExternalRunStore(options.now ?? (() => Date.now()));
    this.idSeq = options.idSeq ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    // Every store change is also an operator change: the sidebar row and the
    // modal both derive from it, and a second subscription in the shell would
    // just be this one written twice.
    this.store.subscribe((hint) => this.emit({ id: hint.id, kind: hint.kind }));
  }

  /** Fold one bridge signal into the store and the local bookkeeping. */
  apply(signal: ExternalRunSignal): void {
    switch (signal.kind) {
      case "start": {
        const agentId = signal.run.agentId ?? "(unnamed)";
        const entry = getExternalAgent(agentId);
        const control = this.control.get(signal.id) ?? {
          agentId,
          label: signal.run.label,
          handle: undefined,
          // False until something spawns a steerable run — see the module header.
          launchedStreaming: false,
        };
        control.agentId = agentId;
        control.label = signal.run.label;
        if (signal.run.sandbox !== undefined) control.sandbox = signal.run.sandbox as ExternalSandbox;
        if (signal.run.model !== undefined) control.model = signal.run.model;
        this.control.set(signal.id, control);
        this.store.start(signal.id, {
          agentId,
          ...(entry === undefined ? {} : { agentLabel: entry.label, reportsCost: entry.reportsCost }),
          ...(control.model === undefined ? {} : { model: control.model }),
          ...(control.sandbox === undefined ? {} : { sandbox: control.sandbox }),
        });
        return;
      }
      case "spawned": {
        const control = this.control.get(signal.id);
        if (control !== undefined) control.handle = signal.handle;
        // A handle appearing can unblock a `hold`ed message (§7.5), so retry now
        // rather than waiting for the next thing the operator types.
        this.flush(signal.id);
        return;
      }
      case "event":
        this.store.event(signal.id, signal.event);
        // codex announces its resume handle on the first event; a message held
        // for exactly that reason becomes deliverable at this instant.
        if (signal.event.kind === "child_started") this.flush(signal.id);
        return;
      case "warning":
        this.store.warn(signal.id, signal.warning);
        return;
      case "outcome": {
        const control = this.control.get(signal.id);
        const outcome = signal.outcome;
        if (control !== undefined && outcome.worktreePath !== undefined) {
          control.worktreePath = outcome.worktreePath;
        }
        this.store.finish(signal.id, {
          status: outcome.status,
          ...(outcome.argv === undefined ? {} : { argv: outcome.argv }),
          ...(outcome.sessionRef === undefined ? {} : { sessionRef: outcome.sessionRef }),
          ...(outcome.costUnits === undefined ? {} : { costUnits: outcome.costUnits }),
          ...(outcome.skippedLines === undefined ? {} : { skippedLines: outcome.skippedLines }),
        });
        if (control !== undefined) control.handle = undefined;
        // A run that ended can still be resumed, so queued messages get one last
        // chance before they are reported as undeliverable.
        this.flush(signal.id);
        return;
      }
      case "result": {
        // Only meaningful for a run that never reached the runtime — a refusal by
        // the gate, a disabled agent, a declined approval. A run that produced an
        // outcome has already been finished above, and `ExternalRunStore.finish`
        // would otherwise overwrite its real status with the folded one.
        if (this.store.isRunning(signal.id)) {
          this.store.finish(signal.id, { status: signal.result.status });
          const control = this.control.get(signal.id);
          if (control !== undefined) control.handle = undefined;
          if (signal.result.isError) this.store.warn(signal.id, signal.result.output);
        }
        return;
      }
      default:
        return;
    }
  }

  /** Every tracked run, in registration order. What the sidebar renders. */
  runs(): ExternalRunView[] {
    return this.store.list();
  }

  /** Whether this id is an external run this controller knows about. */
  has(id: string): boolean {
    return this.store.get(id) !== undefined;
  }

  /** The queue for one run, for the `/queue` surface. */
  queue(runId: string): readonly QueuedExternalMessage[] {
    return queueFor(this.queues, runId) as readonly QueuedExternalMessage[];
  }

  /** Run ids that currently hold at least one queued message. */
  queuedAddressees(): string[] {
    return [...this.queues.keys()].filter((id) => this.store.get(id) !== undefined);
  }

  /**
   * Send one operator message to one external child, executing it immediately
   * where a route exists and QUEUEING it where the route does not exist YET.
   *
   * A `hold` is queued rather than reported as delivered because the two are the
   * whole point of the intent vocabulary: an operator who believes a message was
   * delivered stops watching for the reply (§7.5).
   */
  deliver(runId: string, message: string, options: { force?: boolean } = {}): ExternalDeliveryResult {
    const state = this.addresseeState(runId);
    if (state === undefined) {
      return { ok: false, reason: `no external run "${runId}" is tracked in this session` };
    }
    const intent = planExternalDelivery({
      state,
      message,
      ...(options.force === true ? { force: true } : {}),
    });
    const control = this.control.get(runId);
    const result = executeExternalDelivery(intent, {
      agentId: state.agentId,
      ...(control?.handle === undefined ? {} : { handle: control.handle }),
      ...(this.runInput(runId) === undefined ? {} : { runInput: this.runInput(runId) as ExternalRunInput }),
    });

    if (result.ok && result.event !== undefined) {
      // D-09: the canonical `user_message` lands in the same stream the store and
      // the folded views read, so the transcript shows WHEN the operator spoke
      // relative to the child's work. Single choke point — see `external-delivery`.
      this.store.event(runId, result.event);
    }
    if (result.ok && result.resumeArgv !== undefined) {
      // R21: the Command tab's detach block is the operator's route to carrying a
      // resume out by hand, so recording the argv is what makes the intent usable.
      this.store.setResumeArgv(runId, result.resumeArgv);
    }
    if (result.ok && result.action === "held") {
      this.enqueue(runId, message, options.force === true);
    }
    return result;
  }

  /** Append a message to a run's queue without attempting delivery. */
  enqueue(runId: string, message: string, force = false): QueuedExternalMessage {
    const item: QueuedExternalMessage = {
      id: `q:${this.idSeq()}`,
      question: message,
      displayQuestion: message,
      ...(force ? { force: true } : {}),
    };
    this.queues = enqueueForAddressee(this.queues, runId, item);
    this.emit({ id: runId, kind: "queue" });
    return item;
  }

  /** `/queue remove` for one addressee. Out of range is a no-op, never a throw. */
  removeQueued(runId: string, index: number): QueuedExternalMessage | undefined {
    const { queues, removed } = removeFromAddresseeQueue(this.queues, runId, index);
    this.queues = queues;
    this.emit({ id: runId, kind: "queue" });
    return removed as QueuedExternalMessage | undefined;
  }

  /** `/queue edit`: pull an item out for the composer, keeping its position. */
  editQueued(runId: string, index: number): { text: string; at: number; item: QueuedExternalMessage } | undefined {
    const edited = editInAddresseeQueue(this.queues, runId, index);
    if (edited === undefined) return undefined;
    this.queues = edited.queues;
    this.emit({ id: runId, kind: "queue" });
    return { text: edited.text, at: index, item: edited.removed as QueuedExternalMessage };
  }

  /** Put an edited item back where it was. */
  reinsertQueued(runId: string, at: number, item: QueuedExternalMessage): void {
    this.queues = reinsertIntoAddresseeQueue(this.queues, runId, at, item);
    this.emit({ id: runId, kind: "queue" });
  }

  /**
   * Retry every held message for one run, oldest first, stopping at the first
   * one that is still held.
   *
   * Order is preserved deliberately: delivering message 2 before message 1
   * because 1 happened to be blocked would reorder the operator's own
   * instructions, which is worse than delivering both a moment later.
   */
  flush(runId: string): ExternalDeliveryResult[] {
    const results: ExternalDeliveryResult[] = [];
    for (;;) {
      const items = queueFor(this.queues, runId) as readonly QueuedExternalMessage[];
      const head = items[0];
      if (head === undefined) break;
      const state = this.addresseeState(runId);
      if (state === undefined) break;
      const intent = planExternalDelivery({
        state,
        message: head.question,
        ...(head.force === true ? { force: true } : {}),
      });
      if (intent.kind === "hold") break;
      // Removed BEFORE execution: a `kill-then-resume` tears the run down, and an
      // item still in the queue at that moment would be retried against a dead
      // run forever.
      this.queues = removeFromAddresseeQueue(this.queues, runId, 0).queues;
      const control = this.control.get(runId);
      const result = executeExternalDelivery(intent, {
        agentId: state.agentId,
        ...(control?.handle === undefined ? {} : { handle: control.handle }),
        ...(this.runInput(runId) === undefined ? {} : { runInput: this.runInput(runId) as ExternalRunInput }),
      });
      if (result.ok && result.event !== undefined) this.store.event(runId, result.event);
      if (result.ok && result.resumeArgv !== undefined) this.store.setResumeArgv(runId, result.resumeArgv);
      // Reported, never dropped: this delivery had no caller to return to.
      this.options.onDelivery?.(runId, result);
      results.push(result);
    }
    if (results.length > 0) this.emit({ id: runId, kind: "queue" });
    return results;
  }

  /**
   * Kill one run outright (§7.6 supervision, and the `/queue force` degradation).
   *
   * A run with no live handle is a named refusal rather than a silent success:
   * "already finished" and "killed" must stay distinguishable.
   */
  kill(runId: string): { ok: true } | { ok: false; reason: string } {
    const control = this.control.get(runId);
    if (control?.handle === undefined) {
      return { ok: false, reason: `external run "${runId}" has no live process to kill` };
    }
    control.handle.kill();
    return { ok: true };
  }

  /**
   * Start an OPERATOR-initiated external run (`/delegate`, §8.2, R25).
   *
   * The run id is minted here and recorded as operator-initiated so
   * {@link approver} does not re-ask for the decision the operator just made by
   * typing the command. Everything else goes through the same `runExternal` hook
   * the model uses, so the capability gate and the containment rules are
   * identical on both paths.
   */
  async delegate(input: { agentId: string; task: string; label?: string }): Promise<DelegateOutcome> {
    const hook = this.options.runExternal;
    if (hook === undefined) {
      return {
        ok: false,
        reason:
          "this keryx session has no external agent runtime wired; run `keryx agents external list` " +
          "to see whether the capability is enabled here",
      };
    }
    const entry = getExternalAgent(input.agentId);
    if (entry === undefined) {
      return {
        ok: false,
        reason: `unknown external agent "${input.agentId}"; run \`keryx agents external list\` for the agents keryx can drive`,
      };
    }
    const runId = `ext:${this.idSeq()}`;
    const label = shortLabel(input.label ?? entry.label);
    this.operatorInitiated.add(runId);
    // Operator-initiated runs are announced to the subagent sidebar HERE because
    // nothing else does it: `spawn_subagent` emits the fleet upserts for the
    // model's own dispatches, and `/delegate` never goes through that tool. Same
    // id as the external store's record, so one sidebar row opens the external
    // inspector (specification §8.2).
    emitSubagentFleet({
      kind: "upsert",
      id: runId,
      label,
      status: "running",
      detail: "delegated",
      task: input.task,
      runtime: "external",
      agentId: entry.id,
    });
    try {
      const result = await hook({
        runtime: { kind: "external", agent: entry.id, sandbox: OPERATOR_SANDBOX },
        task: input.task,
        // `read_only` is not a choice this release offers: `worktree-write` is
        // refused upstream (D-04), so offering a mode that cannot run would be a
        // menu item that always fails.
        mode: "read_only",
        workerId: runId,
        label,
      });
      emitSubagentFleet({
        kind: "upsert",
        id: runId,
        label,
        status: result.isError ? "failed" : "done",
        detail: result.status,
        task: input.task,
        runtime: "external",
        agentId: entry.id,
      });
      return { ok: true, runId, label, result };
    } catch (cause) {
      // The hook is written not to throw; a throw is a keryx bug and must not
      // surface as the vendor refusing.
      const message = cause instanceof Error ? cause.message : String(cause);
      emitSubagentFleet({
        kind: "upsert",
        id: runId,
        label,
        status: "failed",
        detail: "error",
        task: input.task,
        runtime: "external",
        agentId: entry.id,
      });
      return { ok: false, reason: `the external runtime failed before the agent could report: ${message}` };
    } finally {
      this.operatorInitiated.delete(runId);
    }
  }

  /**
   * Wrap an interactive approver so operator-initiated runs are not re-asked.
   *
   * `ask` is whatever prompt the host already uses for `risk: "delegate"` tools;
   * omitting it produces an approver that always refuses through `ask`'s absence,
   * which is the correct answer for a host that cannot prompt.
   */
  approver(
    ask: (request: ExternalSpawnApprovalRequest) => Promise<ExternalSpawnApproval>,
  ): (request: ExternalSpawnApprovalRequest) => Promise<ExternalSpawnApproval> {
    return async (request) => {
      if (this.operatorInitiated.has(request.workerId)) {
        // The operator typed `/delegate`; that IS the decision. Re-prompting for
        // it trains them to dismiss the prompt, which is how a real gate stops
        // working. Only ids this controller itself minted qualify.
        return { ok: true };
      }
      return ask(request);
    };
  }

  /** Drop every tracked run and queue (`/clear`, `/new`, a fresh parent turn). */
  clear(): void {
    for (const id of this.control.keys()) this.queues = clearAddresseeQueue(this.queues, id);
    this.control.clear();
    this.operatorInitiated.clear();
    this.store.clear();
  }

  /** Subscribe to change hints. Returns the unsubscribe. */
  subscribe(listener: (hint: ExternalOperatorHint) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * The registry facts plus the two spawn-time facts `planExternalDelivery`
   * needs. Undefined for an id this controller never saw.
   */
  addresseeState(runId: string): ExternalAddresseeState | undefined {
    const view = this.store.get(runId);
    if (view === undefined) return undefined;
    const control = this.control.get(runId);
    const entry = getExternalAgent(view.agentId);
    const sessionRef = view.sessionRef;
    return {
      agentId: view.agentId,
      // An agent absent from the registry can do neither: refusing to guess is
      // what keeps a wrong route from being attempted on an unknown CLI.
      streamingInput: entry?.streamingInput ?? false,
      launchedStreaming: control?.launchedStreaming ?? false,
      resumable: entry?.resumable ?? false,
      ...(sessionRef === undefined ? {} : { sessionRef }),
      running: this.store.isRunning(runId),
    };
  }

  /**
   * Reconstruct the codec input a resume argv needs.
   *
   * `runExternalChild` builds the real `ExternalRunInput` internally and does not
   * report it, so this rebuilds the fields both shipped `buildResumeArgv`
   * implementations actually read: `codex-cli` reads NONE of them, and
   * `claude-cli` reads `maxCostUnits`, `resultSchemaPath`, `cwd` and `model`. The
   * prompt is not among them — a resume carries the operator's message, not the
   * original prompt — so an empty one here cannot produce a wrong command.
   */
  private runInput(runId: string): ExternalRunInput | undefined {
    const control = this.control.get(runId);
    if (control === undefined) return undefined;
    return {
      prompt: "",
      cwd: control.worktreePath ?? "",
      sandbox: control.sandbox ?? OPERATOR_SANDBOX,
      ...(control.model === undefined ? {} : { model: control.model }),
    };
  }

  private emit(hint: ExternalOperatorHint): void {
    for (const listener of this.listeners) {
      try {
        listener(hint);
      } catch {
        // A broken subscriber must never break the run it is watching.
      }
    }
  }
}

/** Clip a sidebar label to the same 18-character budget `spawn_subagent` uses. */
function shortLabel(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "external";
  return trimmed.length > 18 ? `${trimmed.slice(0, 15)}…` : trimmed;
}

/** Convenience for a host that just wants a sink to hand `setExternalRunListener`. */
export function externalOperatorListener(operator: ExternalOperator): (signal: ExternalRunSignal) => void {
  return (signal) => operator.apply(signal);
}

/** What {@link attachExternalOperator} needs from its host. */
export interface AttachExternalOperatorOptions {
  /** Project root the operator-initiated runs are cut from. */
  readonly cwd: string;
  /**
   * The host's interactive approval prompt — the SAME one it already uses for
   * `risk: "delegate"` tools. Omitted means the host cannot ask, and every
   * model-initiated spawn keeps being refused with the bridge's named reason.
   */
  readonly ask?: (request: ExternalSpawnApprovalRequest) => Promise<ExternalSpawnApproval>;
  /** Factory seam, injected by tests so attaching starts no capability resolution. */
  readonly makeRunExternal?: (options: { cwd: string; observer: ExternalRunObserver }) => RunExternalFn;
  /** See {@link ExternalOperatorOptions.onDelivery}. */
  readonly onDelivery?: (runId: string, result: ExternalDeliveryResult) => void;
  readonly idSeq?: () => string;
  readonly now?: () => number;
}

/**
 * Build an {@link ExternalOperator}, register it on the module-level bridge, and
 * hand back the detach.
 *
 * Exists so `tui-shell.ts` — 2300 lines and the most change-averse file in the
 * repo — spends three lines on this instead of twenty. Registration is explicit
 * rather than automatic on construction so two shells in one process (which the
 * test suite creates routinely) cannot silently steal each other's runs.
 */
export function attachExternalOperator(options: AttachExternalOperatorOptions): {
  operator: ExternalOperator;
  detach: () => void;
} {
  const make =
    options.makeRunExternal ??
    ((input: { cwd: string; observer: ExternalRunObserver }) =>
      createLazyRunExternal({ cwd: input.cwd, observer: input.observer, approve: approveExternalSpawn }));
  const operator = new ExternalOperator({
    runExternal: make({ cwd: options.cwd, observer: externalRunBridgeObserver }),
    ...(options.onDelivery === undefined ? {} : { onDelivery: options.onDelivery }),
    ...(options.idSeq === undefined ? {} : { idSeq: options.idSeq }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  setExternalRunListener(externalOperatorListener(operator));
  const ask = options.ask;
  if (ask !== undefined) setExternalSpawnApprover(operator.approver(ask));
  return {
    operator,
    detach: () => {
      setExternalRunListener(undefined);
      setExternalSpawnApprover(undefined);
    },
  };
}
