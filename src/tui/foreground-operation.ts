import type { AgentIO } from "../commands/agent";

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
}

export class ForegroundOperationOwner {
  private active: ActiveForegroundOperation | undefined;
  private disposed = false;

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
    return !this.disposed && this.active?.token === token;
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
    this.active = { token, controller: new AbortController(), settled, resolveSettled };
    return token;
  }

  cancel(reason?: unknown): void {
    const controller = this.active?.controller;
    if (controller !== undefined && !controller.signal.aborted) {
      controller.abort(reason);
    }
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

  get isAwaitingSettlement(): boolean {
    return this.awaitingSettlement;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
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
 * Waits for the current operation once and only dispatches follow-up work when
 * the shell remains live. This is the queue Force handoff boundary.
 */
export async function runAfterForegroundSettlement(
  owner: ForegroundOperationOwner,
  action: () => void,
): Promise<void> {
  await owner.settled();
  if (!owner.isDisposed) {
    action();
  }
}

/**
 * Prevents late events from a completed or disposed foreground turn from
 * mutating the TUI. Each callback reads the current delegate at call time so
 * shell-installed hooks remain live during a valid operation.
 */
export function createForegroundAgentIoFacade(
  owner: ForegroundOperationOwner,
  token: ForegroundOperationToken,
  io: AgentIO,
): AgentIO {
  const accepts = (): boolean => owner.accepts(token);
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
    requestApproval: async (tool, input, meta) => {
      if (!accepts()) return false;
      const response = await io.requestApproval?.(tool, input, meta);
      return accepts() ? response ?? false : false;
    },
    onAutoApproved: (tool, input, meta) => {
      if (accepts()) io.onAutoApproved?.(tool, input, meta);
    },
    permissionMode: () => (accepts() ? io.permissionMode?.() ?? "ask" : "ask"),
  };
}
