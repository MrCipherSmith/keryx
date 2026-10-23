import type { AgentIO, ApprovalMeta, ApprovalResponse } from "../commands/agent";

/**
 * Owns the single cancellable operation that may keep the interactive shell
 * busy. Tokens make cleanup identity-safe: an older operation cannot clear a
 * newer one after it settles late.
 */
export type ForegroundOperationToken = symbol;

interface ActiveForegroundOperation {
  token: ForegroundOperationToken;
  controller: AbortController;
  settled: Promise<void>;
  resolveSettled: () => void;
  invalidated: boolean;
}

export class ForegroundOperationOwner {
  private active: ActiveForegroundOperation | undefined;
  private disposed = false;
  private sessionGeneration = 0;

  get generation(): number { return this.sessionGeneration; }

  get signal(): AbortSignal {
    if (this.active === undefined) {
      throw new Error("foreground operation has not started");
    }
    return this.active.controller.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get isActive(): boolean {
    return this.active !== undefined;
  }

  accepts(token: ForegroundOperationToken): boolean {
    return !this.disposed && this.active?.token === token && !this.active.invalidated;
  }

  begin(): ForegroundOperationToken {
    if (this.disposed) {
      throw new Error("foreground operation owner is disposed");
    }
    if (this.active !== undefined) {
      throw new Error("a foreground operation is already active");
    }
    const token = Symbol("foreground-operation");
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.active = { token, controller: new AbortController(), settled, resolveSettled, invalidated: false };
    return token;
  }

  /**
   * Abort the operation in flight, if there is one. The return value is the
   * honest answer to "did that interrupt anything": `false` means nothing was
   * active (the shell can still be busy with detached work) or an earlier press
   * already aborted it. A caller that paints an "interrupted" line to the
   * operator must use it rather than assume the abort happened.
   */
  cancel(reason?: unknown): boolean {
    const controller = this.active?.controller;
    if (controller === undefined || controller.signal.aborted) {
      return false;
    }
    controller.abort(reason);
    return true;
  }

  /** Revoke session-bound callbacks immediately, retain busy ownership until settlement. */
  invalidateSession(): void {
    this.sessionGeneration += 1;
    if (this.active !== undefined) this.active.invalidated = true;
    this.cancel("session switched");
  }

  settled(): Promise<void> {
    return this.active?.settled ?? Promise.resolve();
  }

  settle(token: ForegroundOperationToken): void {
    if (this.active?.token !== token) {
      return;
    }
    const active = this.active;
    this.active = undefined;
    active.resolveSettled();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel("renderer disposed");
  }
}

export function createForegroundOperationOwner(): ForegroundOperationOwner {
  return new ForegroundOperationOwner();
}

/**
 * Holds Force selections made while an active foreground operation is settling.
 * The first enqueue owns the settlement handoff; later enqueues retain their
 * FIFO position for the following foreground-operation finalizers.
 */
export class ForegroundForceHandoff<T> {
  private readonly pending: T[] = [];
  private awaitingSettlement = false;

  enqueue(item: T): boolean {
    this.pending.push(item);
    if (this.awaitingSettlement) return false;
    this.awaitingSettlement = true;
    return true;
  }

  clear(): void {
    this.pending.length = 0;
    this.awaitingSettlement = false;
  }

  /**
   * Stop waiting for a settlement without losing what is parked here. The drain
   * sites refuse to work while `isAwaitingSettlement` is true, so a handoff that
   * never settles would stall the queue for the rest of the shell's life.
   */
  releaseAwaitingSettlement(): void {
    this.awaitingSettlement = false;
  }

  /**
   * Take every parked item back — the outcome that loses nothing. A forced line
   * has already been removed from the visible queue, so dropping it from here
   * deletes the operator's message outright; a session switch must re-queue.
   */
  drainPending(): T[] {
    const items = [...this.pending];
    this.pending.length = 0;
    this.awaitingSettlement = false;
    return items;
  }

  get isAwaitingSettlement(): boolean {
    return this.awaitingSettlement;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  takeAfterSettlement(): T | undefined {
    this.awaitingSettlement = false;
    return this.pending.shift();
  }

  takeNext(): T | undefined {
    return this.pending.shift();
  }
}

export function createForegroundForceHandoff<T>(): ForegroundForceHandoff<T> {
  return new ForegroundForceHandoff<T>();
}

/**
 * Finalizes an in-process wiki operation without conflating user interruption
 * with renderer teardown. A live interrupt must clear busy state, but neither
 * render completion nor dispatch queued work; disposal must touch no renderer
 * callback at all.
 */
export function finalizeWikiForegroundOperation(
  state: { aborted: boolean; disposed: boolean },
  callbacks: { stopBusy: () => void; complete: () => void },
): "disposed" | "aborted" | "completed" {
  if (state.disposed) return "disposed";
  callbacks.stopBusy();
  if (state.aborted) return "aborted";
  callbacks.complete();
  return "completed";
}

/**
 * Waits for the current operation once and only dispatches follow-up work when
 * the shell remains live. This is the queue Force handoff boundary.
 *
 * Returns whether `action` ran: `false` means the shell was disposed or the
 * session changed while the waiter waited, so nothing was dispatched and work
 * held for that moment must be handed back rather than assumed in flight.
 */
export async function runAfterForegroundSettlement(
  owner: ForegroundOperationOwner,
  action: () => void,
): Promise<boolean> {
  const generation = owner.generation;
  await owner.settled();
  if (!owner.isDisposed && owner.generation === generation) {
    action();
    return true;
  }
  return false;
}

/**
 * Force a queued item to run next: enqueue it, cancel the active operation, and
 * dispatch after settlement — but only from the press that owns the handoff.
 *
 * Extracted from `forceMainQueue` in tui-shell.ts because it could not be
 * tested where it lived. `launchTuiAgentShell` has no headless injection seam,
 * so the wiring there was covered only by a source-text audit that reads the
 * file and matches regexes. Review demonstrated the cost: deleting the
 * `if (!ownsSettlement) return;` guard left all four audit assertions passing
 * and the whole 101-test file green, while a second Force press during
 * settlement would dispatch a second item into the operation the first had
 * already re-opened — `begin()` throwing "a foreground operation is already
 * active" out of an async IIFE.
 *
 * That regression is not hypothetical here: the flow's own history records it
 * found and fixed in review twice. A guard with that record should be
 * executable by a test, not merely visible to one.
 */
export async function forceForegroundQueueItem<T>(
  owner: ForegroundOperationOwner,
  handoff: ForegroundForceHandoff<T>,
  item: T,
  deps: {
    readonly announce?: (interrupted: boolean) => void;
    readonly run: (item: T) => void;
    readonly cancelReason?: unknown;
    /** Whether the shell is busy in a way `run` cannot turn into the main turn. */
    readonly isBusy?: () => boolean;
    /** Nudge the drain sites after a line was handed back to the queue. */
    readonly resume?: () => void;
    /** Give lines back to the operator queue — the only outcome that loses nothing. */
    readonly requeue?: (items: readonly T[]) => void;
  },
): Promise<void> {
  const ownsSettlement = handoff.enqueue(item);
  // Only claim an interruption the owner performed. `cancel` answers "did that
  // abort anything": with no operation active it is a no-op, and the old
  // unconditional message told the operator the main turn was interrupted when
  // nothing had been.
  const interrupted = owner.cancel(deps.cancelReason ?? "queue item forced");
  deps.announce?.(interrupted);
  // Only the press that owns the handoff waits. A later press has already put
  // its item in the queue and returns: the settlement handler drains in FIFO
  // order, and a second waiter would dispatch into an operation the first has
  // re-opened.
  if (!ownsSettlement) {
    return;
  }
  const dispatched = await runAfterForegroundSettlement(owner, () => {
    // The operation settled, but something else still owns the busy state (wiki
    // work, detached jobs): `run` would be diverted by the busy branch instead of
    // becoming the main turn. Keep the line queued, unblock the drain sites, and
    // let the next settle dispatch it.
    if (deps.isBusy?.() === true) {
      handoff.releaseAwaitingSettlement();
      deps.resume?.();
      return;
    }
    const next = handoff.takeAfterSettlement();
    if (next !== undefined) {
      deps.run(next);
    }
  });
  if (!dispatched) {
    // Disposed, or the session changed under us: `takeAfterSettlement` never ran,
    // so the parked lines are still here and nothing else can see them.
    deps.requeue?.(handoff.drainPending());
  }
}

/**
 * Prevents late events from a completed or disposed foreground turn from
 * mutating the TUI. Each callback reads the current delegate at call time so
 * shell-installed hooks remain live during a valid operation.
 */
/**
 * The approval-related hooks that belong to ONE turn rather than to the shell (flow 396): a turn that came
 * from Telegram is judged and asked in the topic, a typed one in the dock, and what one turn is must never
 * decide how another piece of work running beside it is judged. The shell's own `io` carries the typed-turn
 * behaviour; a Telegram turn passes its hooks here, so they reach only the calls made inside that turn.
 */
export type TurnScopedIo = Partial<Pick<AgentIO, "requestApproval" | "permissionMode" | "onAutoApproved" | "mcpGrantsApply">>;

/**
 * The shell's `io` with one turn's hooks laid over it, for a model turn that does not go through the
 * foreground facade (a `/goal` from Telegram). Every other hook is read live from `io`, so a hook the shell
 * installs later still applies.
 */
export function withTurnScopedIo(io: AgentIO, turn: TurnScopedIo): AgentIO {
  const scoped: AgentIO = Object.create(io);
  for (const key of Object.keys(turn) as Array<keyof TurnScopedIo>) {
    const hook = turn[key];
    if (hook !== undefined) Object.defineProperty(scoped, key, { value: hook, writable: true, enumerable: true, configurable: true });
  }
  return scoped;
}

export function createForegroundAgentIoFacade(
  owner: ForegroundOperationOwner,
  token: ForegroundOperationToken,
  io: AgentIO,
  turn: TurnScopedIo = {},
): AgentIO {
  const accepts = (): boolean => owner.accepts(token);
  // Read at call time, like every other hook here: the shell may install them after the facade exists.
  const approve = () => turn.requestApproval ?? io.requestApproval;
  const autoApproved = () => turn.onAutoApproved ?? io.onAutoApproved;
  const modeOf = () => turn.permissionMode ?? io.permissionMode;
  const mcpGrantsApply = turn.mcpGrantsApply ?? io.mcpGrantsApply;
  return {
    write: (text) => {
      if (accepts()) io.write(text);
    },
    onHistoryChange: (kind) => {
      if (accepts()) io.onHistoryChange?.(kind);
    },
    onAssistantText: (text) => {
      if (accepts()) io.onAssistantText?.(text);
    },
    onReasoning: (text) => {
      if (accepts()) io.onReasoning?.(text);
    },
    // flow 268 T17 (AC16): forward the live-delta and end-of-span hooks the
    // same guarded way as `onReasoning` above — a stale/disposed turn must
    // not paint a "thinking…" indicator or a finished reasoning block onto
    // whatever operation now owns the screen.
    onAttemptInterrupted: () => { if (accepts()) io.onAttemptInterrupted?.(); },
    onReasoningDelta: (delta) => {
      if (accepts()) io.onReasoningDelta?.(delta);
    },
    onReasoningEnd: (info) => {
      if (accepts()) io.onReasoningEnd?.(info);
    },
    onUsage: (usage) => {
      if (accepts()) io.onUsage?.(usage);
    },
    onToolCall: (name, input) => {
      if (accepts()) io.onToolCall?.(name, input);
    },
    onToolResult: (name, result) => {
      if (accepts()) io.onToolResult?.(name, result);
    },
    onSystem: (text) => {
      if (accepts()) io.onSystem?.(text);
    },
    onTerminalState: (state) => {
      if (accepts()) io.onTerminalState?.(state);
    },
    requestApproval: Object.assign(
      async (tool: string, input: string, meta?: ApprovalMeta): Promise<ApprovalResponse> => {
        if (!accepts()) return false;
        const response = await approve()?.(tool, input, meta);
        return accepts() ? response ?? false : false;
      },
      // A displaced turn's `false` is not the operator saying no.
      { current: accepts },
    ),
    onAutoApproved: (tool, input, meta) => {
      if (accepts()) autoApproved()?.(tool, input, meta);
    },
    onQuestionSelfAnswered: (question, answerLabel) => {
      if (accepts()) io.onQuestionSelfAnswered?.(question, answerLabel);
    },
    permissionMode: () => (accepts() ? modeOf()?.() ?? "ask" : "ask"),
    // Share the session grant set with the shell, but never let a stale turn
    // use it: readOnly denies every mutating tool when ownership is lost.
    ...(io.trustedMcpTools === undefined ? {} : { trustedMcpTools: io.trustedMcpTools }),
    ...(mcpGrantsApply === undefined ? {} : { mcpGrantsApply }),
    ...(io.mcpToolFingerprint === undefined ? {} : { mcpToolFingerprint: io.mcpToolFingerprint }),
    ...(io.mcpToolDestructive === undefined ? {} : { mcpToolDestructive: io.mcpToolDestructive }),
    ...(io.beforeMutation === undefined
      ? {}
      : {
          beforeMutation: async () => {
            if (accepts()) await io.beforeMutation?.();
          },
        }),
    readOnly: () => !accepts() || (io.readOnly?.() ?? false),
  };
}

/** Session effects are valid only before settlement and only in the originating session. */
export function settleForegroundOperation(owner: ForegroundOperationOwner, token: ForegroundOperationToken): boolean {
  const accepted = owner.accepts(token);
  owner.settle(token);
  return accepted;
}
