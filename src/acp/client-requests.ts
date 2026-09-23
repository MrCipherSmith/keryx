// Requests keryx sends TO the client, and the table that matches answers back
// to them (flow 285, T9).
//
// Until now every message on this wire flowed one way: the client asked, the
// agent answered, and an incoming response had nowhere to go (`server.ts`
// logged it as unexpected). `session/request_permission` reverses that — keryx
// asks and BLOCKS a tool call on the answer — so something has to remember
// which outstanding question an arriving `id` belongs to. That is this file,
// and it is deliberately ACP-agnostic: it knows JSON-RPC ids and nothing about
// permissions.
//
// THE PROPERTY THAT MATTERS: every request settles exactly once, and never
// hangs. A client may answer, may answer with an error, may answer something
// unparseable, or may simply never answer and close the pipe. The first three
// settle through `resolve`; the last settles through `close`, which the server
// calls when stdin ends. A promise here that could stay pending is a turn that
// never finishes and an editor that waits forever — so `close` is not cleanup,
// it is the last branch of the contract.
//
// Pure: importing this reads nothing and spawns nothing.

import {
  requestMessage,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcRequestMessage,
  type JsonRpcResponseMessage,
} from "./jsonrpc";

/** How one outgoing request ended. Never a throw — the caller must branch on it. */
export type AcpClientRequestOutcome =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "error"; readonly error: JsonRpcErrorObject }
  | { readonly kind: "closed"; readonly reason: string };

export interface AcpClientRequestsOptions {
  /** Writes one framed request to the client. */
  readonly send: (message: JsonRpcRequestMessage) => void;
  /** Id source; ids are prefixed so they can never collide with a tool-call id from the same sequence. */
  readonly idSeq: () => string;
  /**
   * The id prefix. `acp-agent-` by default — the agent side's questions to its
   * client. keryx acting as a CLIENT (flow 292) passes its own, so a transcript
   * of either wire says at a glance which side asked.
   */
  readonly idPrefix?: string;
}

export class AcpClientRequests {
  private readonly pending = new Map<string, (outcome: AcpClientRequestOutcome) => void>();
  private closedReason: string | undefined;

  constructor(private readonly options: AcpClientRequestsOptions) {}

  /** Outstanding questions, for tests and diagnostics. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Asks the client one question and resolves when it answers.
   *
   * After {@link close} this resolves IMMEDIATELY with `closed` rather than
   * sending anything: a connection that has ended cannot answer, and a caller
   * that treats "closed" as a denial (which every caller must) is then denied
   * without a wire round trip nobody could read.
   *
   * `onId`, when given, is called synchronously with the minted request id
   * BEFORE the message is sent — a caller that needs to correlate this
   * specific outstanding question later (flow 285 T10: `session/cancel`
   * settling only the permission ask belonging to the turn it cancels, not
   * every pending question on the connection) has no other way to learn the
   * id, since it is otherwise only ever seen again inside the resolved
   * outcome.
   */
  request(method: string, params: unknown, onId?: (id: string) => void): Promise<AcpClientRequestOutcome> {
    if (this.closedReason !== undefined) {
      return Promise.resolve({ kind: "closed", reason: this.closedReason });
    }
    const id = `${this.options.idPrefix ?? "acp-agent-"}${this.options.idSeq()}`;
    onId?.(id);
    return new Promise<AcpClientRequestOutcome>((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.options.send(requestMessage(id, method, params));
      } catch (error) {
        // A failed write is a question that was never asked. Settle it here
        // rather than leave a pending entry nothing will ever answer.
        this.pending.delete(id);
        resolve({
          kind: "closed",
          reason: `the request could not be written: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
  }

  /**
   * Settles ONE outstanding request as `closed`, without touching any other
   * pending question.
   *
   * The scoped counterpart to {@link close}: `close` ends the whole
   * connection's worth of questions (stdin ended, nobody can answer
   * anything), this ends exactly one (a `session/cancel` for the turn that
   * asked it — every OTHER session's in-flight questions, if any, are
   * untouched). Returns `false` when `id` names nothing pending — already
   * answered, already cancelled, or never asked — so a caller can tell "there
   * was nothing to cancel" from "the cancel landed".
   */
  cancel(id: string, reason: string): boolean {
    const settle = this.pending.get(id);
    if (settle === undefined) {
      return false;
    }
    this.pending.delete(id);
    settle({ kind: "closed", reason });
    return true;
  }

  /**
   * Routes one incoming response to the request that is waiting for it.
   *
   * Returns false when no request owns this id — an unsolicited or duplicate
   * response, which the caller surfaces to stderr rather than dropping.
   */
  resolve(message: JsonRpcResponseMessage): boolean {
    const key = idKey(message.id);
    if (key === undefined) {
      return false;
    }
    const settle = this.pending.get(key);
    if (settle === undefined) {
      return false;
    }
    this.pending.delete(key);
    if ("error" in message) {
      settle({ kind: "error", error: message.error });
      return true;
    }
    settle({ kind: "result", result: message.result });
    return true;
  }

  /** Settles every outstanding request as `closed`. Idempotent; later requests settle the same way. */
  close(reason: string): void {
    this.closedReason ??= reason;
    const outstanding = [...this.pending.values()];
    this.pending.clear();
    for (const settle of outstanding) {
      settle({ kind: "closed", reason });
    }
  }
}

/** Our own ids are always strings; a numeric echo is matched by its text form, `null` never matches. */
function idKey(id: JsonRpcId): string | undefined {
  if (typeof id === "string") {
    return id;
  }
  if (typeof id === "number") {
    return String(id);
  }
  return undefined;
}
