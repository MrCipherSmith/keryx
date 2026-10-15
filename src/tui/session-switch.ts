/** Owns the full picker/preservation/transfer operation, not just foreground turns. */
export class SessionSwitchOwner {
  private readonly controller = new AbortController();
  private tail: Promise<void> = Promise.resolve();
  get stopped(): boolean { return this.controller.signal.aborted; }
  run(action: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const task = this.tail.then(async () => {
      if (!this.stopped) await action(this.controller.signal);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  stop(): Promise<void> {
    this.controller.abort();
    return this.tail;
  }
}
export function assertSessionSwitchActive(signal: AbortSignal, owned: boolean): void {
  signal.throwIfAborted();
  if (!owned) throw new Error("session ownership lost during switch");
}
