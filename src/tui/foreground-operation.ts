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
