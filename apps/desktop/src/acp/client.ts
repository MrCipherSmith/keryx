// Typed JSON-RPC 2.0 client for ACP over an abstract line transport.

export interface Transport {
  send(line: string): Promise<void>;
}

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
    this.name = "RpcError";
  }
}

type Id = number | string;
interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  method: string;
}

export type NotificationHandler = (method: string, params: unknown) => void;
/** Return the result, or throw an RpcError to answer with an error response. */
export type RequestHandler = (method: string, params: unknown, id: Id) => Promise<unknown>;

export class AcpClient {
  private nextId = 1;
  private pending = new Map<Id, Pending>();
  private closed = false;
  private sendChain: Promise<void> = Promise.resolve();
  onNotification: NotificationHandler = () => {};
  onRequest: RequestHandler = async (method) => {
    throw new RpcError(-32601, `Method not found: ${method}`);
  };
  /** A reply to one of keryx's requests could not be sent even after retrying. */
  onReplyFailed: (method: string, error: string) => void = () => {};

  /** Pauses between attempts to send a reply keryx is waiting for (about 6 s in all). */
  constructor(
    private transport: Transport,
    private readonly replyBackoffMs: readonly number[] = [50, 100, 200, 400, 800, 1600, 3000],
  ) {}

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error("keryx is not running"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, method });
      this.write({ jsonrpc: "2.0", id, method, params }).catch((e) => {
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    void this.write({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  /** Feed one line received from keryx. */
  handleLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // not JSON-RPC; keryx logs go to stderr, ignore stray output
    }
    if (typeof msg !== "object" || msg === null) return;
    const hasMethod = typeof msg.method === "string";
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasMethod && hasId) {
      void this.answer(msg.id as Id, msg.method as string, msg.params);
    } else if (hasMethod) {
      try {
        this.onNotification(msg.method as string, msg.params);
      } catch (e) {
        console.error("notification handler failed", e);
      }
    } else if (hasId) {
      const p = this.pending.get(msg.id as Id);
      if (!p) return;
      this.pending.delete(msg.id as Id);
      const err = msg.error as { code?: number; message?: string; data?: unknown } | undefined;
      if (err) p.reject(new RpcError(err.code ?? -32603, err.message ?? "error", err.data));
      else p.resolve(msg.result);
    }
  }

  /** The transport is gone: fail everything in flight. */
  close(reason = "keryx exited"): void {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`${reason} (while waiting for ${p.method})`));
    this.pending.clear();
  }

  private async answer(id: Id, method: string, params: unknown): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const result = await this.onRequest(method, params, id);
      frame = { jsonrpc: "2.0", id, result: result ?? null };
    } catch (e) {
      const err =
        e instanceof RpcError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: -32603, message: e instanceof Error ? e.message : String(e) };
      frame = { jsonrpc: "2.0", id, error: err };
    }
    await this.reply(frame, method);
  }

  /**
   * keryx waits for every reply without a timeout, so a reply is not given up on a full input queue:
   * it is retried with a growing pause while the client is open. Each reply names its id, so a retry
   * never confuses another one. If it still cannot be sent, `onReplyFailed` says so.
   */
  private async reply(frame: Record<string, unknown>, method: string): Promise<void> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < this.replyBackoffMs.length + 1; attempt++) {
      if (this.closed) return;
      try {
        await this.write(frame);
        return;
      } catch (e) {
        lastError = e;
      }
      const pause = this.replyBackoffMs[attempt];
      if (pause === undefined) break;
      await new Promise<void>((r) => setTimeout(r, pause));
    }
    if (!this.closed) this.onReplyFailed(method, lastError instanceof Error ? lastError.message : String(lastError));
  }

  /**
   * Frames reach the transport one at a time, in the order they were issued: the host's send is
   * async and may run concurrent calls in any order, so the next send starts only after the last settled.
   */
  private write(message: unknown): Promise<void> {
    const line = JSON.stringify(message);
    const sent = this.sendChain.then(() => this.transport.send(line));
    this.sendChain = sent.catch(() => {});
    return sent;
  }
}
