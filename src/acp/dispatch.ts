// Method routing for the ACP agent server (flow 285, T6).
//
// One registry, one entry point, and a total function: every incoming line
// produces exactly one of three outcomes — a response to write back, nothing
// (it was a notification), or a response that belongs to a request WE sent.
// There is no fourth "and sometimes it throws" case, because a dispatcher that
// can throw leaves the peer waiting on a reply that will never come, and an
// editor blocked on a request has no way to recover from that but a timeout.
//
// The dispatcher owns routing and error SHAPE. It owns no ACP semantics: it
// does not know what `session/prompt` does, only that something registered to
// answer it, and that an unregistered method gets `-32601`. That is what lets
// the later dispatches of this flow add handlers without touching this file.
//
// Pure: importing this reads nothing and spawns nothing.

import { decodeAcpLine } from "./framing";
import {
  AcpError,
  classifyJsonRpcMessage,
  errorResponse,
  internalError,
  methodNotFound,
  successResponse,
  type JsonRpcErrorObject,
  type JsonRpcId,
  type JsonRpcNotificationMessage,
  type JsonRpcRequestMessage,
  type JsonRpcResponseMessage,
} from "./jsonrpc";
import { ACP_IMPLEMENTED_AGENT_METHODS, ACP_PROTOCOL_VERSION, refusalError } from "./protocol";

export interface AcpRequestContext {
  readonly method: string;
  readonly id: JsonRpcId;
}

export interface AcpNotificationContext {
  readonly method: string;
}

export type AcpRequestHandler = (
  params: unknown,
  context: AcpRequestContext,
) => unknown | Promise<unknown>;

export type AcpNotificationHandler = (
  params: unknown,
  context: AcpNotificationContext,
) => void | Promise<void>;

/**
 * What one incoming message turned into.
 *
 * `incoming-response` is separate from `none` on purpose. Both mean "write
 * nothing", but only one of them carries a payload the connection layer MUST
 * hand to its pending-request table — collapsing them would strand every
 * `session/request_permission` keryx ever asks.
 */
export type AcpDispatchOutcome =
  | { readonly kind: "reply"; readonly message: JsonRpcResponseMessage }
  | { readonly kind: "none" }
  | { readonly kind: "incoming-response"; readonly message: JsonRpcResponseMessage };

export interface AcpDispatcherOptions {
  /**
   * Called for a notification no handler claimed.
   *
   * JSON-RPC forbids replying to a notification, so an unknown one is
   * unreportable ON THE WIRE. It is still a fact worth knowing, and this is the
   * hook that gets it to stderr instead of nowhere.
   */
  readonly onUnhandledNotification?: (method: string, params: unknown) => void;
  /** Called when a handler throws, before the error is shaped into a reply. */
  readonly onHandlerError?: (method: string, error: unknown) => void;
  /**
   * The error for a request method no handler claimed.
   *
   * Defaults to the AGENT side's answer (the refusal table in `protocol.ts`,
   * then a method-not-found listing what `keryx acp` implements). keryx acting
   * as an ACP CLIENT (flow 292) answers different methods, and listing the agent
   * roster to a foreign agent would be a wrong fix to read — so the client side
   * supplies its own.
   */
  readonly unknownMethodError?: (method: string) => JsonRpcErrorObject;
}

export interface AcpHandlers {
  readonly requests?: Readonly<Record<string, AcpRequestHandler>>;
  readonly notifications?: Readonly<Record<string, AcpNotificationHandler>>;
}

export class AcpDispatcher {
  private readonly requests = new Map<string, AcpRequestHandler>();
  private readonly notifications = new Map<string, AcpNotificationHandler>();
  private readonly options: AcpDispatcherOptions;

  constructor(handlers: AcpHandlers = {}, options: AcpDispatcherOptions = {}) {
    for (const [method, handler] of Object.entries(handlers.requests ?? {})) {
      this.requests.set(method, handler);
    }
    for (const [method, handler] of Object.entries(handlers.notifications ?? {})) {
      this.notifications.set(method, handler);
    }
    this.options = options;
  }

  /** Registers (or replaces) the handler for one request method. */
  onRequest(method: string, handler: AcpRequestHandler): this {
    this.requests.set(method, handler);
    return this;
  }

  /** Registers (or replaces) the handler for one notification method. */
  onNotification(method: string, handler: AcpNotificationHandler): this {
    this.notifications.set(method, handler);
    return this;
  }

  /** Every request method with a handler, sorted — for tests and diagnostics. */
  registeredRequestMethods(): string[] {
    return [...this.requests.keys()].sort();
  }

  /** Every notification method with a handler, sorted. */
  registeredNotificationMethods(): string[] {
    return [...this.notifications.keys()].sort();
  }

  /**
   * Decodes one framed line and dispatches it.
   *
   * Malformed JSON is answered with `-32700` and id `null`, which is the only
   * id available: the bytes that would have carried one did not parse.
   */
  async handleLine(line: string): Promise<AcpDispatchOutcome> {
    const decoded = decodeAcpLine(line);
    if (!decoded.ok) {
      return { kind: "reply", message: errorResponse(null, decoded.error) };
    }
    return this.handleMessage(decoded.value);
  }

  /** Dispatches one already-decoded JSON value. */
  async handleMessage(value: unknown): Promise<AcpDispatchOutcome> {
    const classified = classifyJsonRpcMessage(value);
    switch (classified.kind) {
      case "invalid":
        return { kind: "reply", message: errorResponse(classified.id, classified.error) };
      case "response":
        return { kind: "incoming-response", message: classified.message };
      case "notification":
        await this.handleNotification(classified.message);
        return { kind: "none" };
      case "request":
        return { kind: "reply", message: await this.handleRequest(classified.message) };
    }
  }

  private async handleRequest(message: JsonRpcRequestMessage): Promise<JsonRpcResponseMessage> {
    const handler = this.requests.get(message.method);
    if (handler === undefined) {
      return errorResponse(message.id, this.unknownMethodError(message.method));
    }

    try {
      const result = await handler(message.params, { method: message.method, id: message.id });
      // `undefined` is not valid JSON, and a handler with nothing to say means
      // an empty result object — which is exactly what ACP's `session/load`,
      // `authenticate` and `fs/write_text_file` responses are.
      return successResponse(message.id, result === undefined ? {} : result);
    } catch (error) {
      this.options.onHandlerError?.(message.method, error);
      if (error instanceof AcpError) {
        return errorResponse(message.id, error.toErrorObject());
      }
      // Deliberately the message only. A stack trace on this wire describes the
      // agent's filesystem to whatever process launched it.
      return errorResponse(
        message.id,
        internalError(error instanceof Error ? error.message : String(error), {
          method: message.method,
        }),
      );
    }
  }

  private async handleNotification(message: JsonRpcNotificationMessage): Promise<void> {
    const handler = this.notifications.get(message.method);
    if (handler === undefined) {
      this.options.onUnhandledNotification?.(message.method, message.params);
      return;
    }
    try {
      await handler(message.params, { method: message.method });
    } catch (error) {
      // There is no reply to carry this. Surfacing it to the host is the only
      // honest option; swallowing it would make a broken cancel look like a
      // working one.
      this.options.onHandlerError?.(message.method, error);
    }
  }

  /**
   * The error for a method with no handler.
   *
   * A method ACP defines and keryx declines gets the specific refusal from
   * `protocol.ts`; anything else gets a plain method-not-found that still says
   * what this agent does answer, so a client author reads the fix rather than
   * guessing at it.
   */
  private unknownMethodError(method: string): JsonRpcErrorObject {
    if (this.options.unknownMethodError !== undefined) {
      return this.options.unknownMethodError(method);
    }
    return (
      refusalError(method) ??
      methodNotFound(method, {
        protocolVersion: ACP_PROTOCOL_VERSION,
        implemented: ACP_IMPLEMENTED_AGENT_METHODS,
      })
    );
  }
}
