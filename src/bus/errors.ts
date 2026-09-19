// Named refusals of the agent bus (specification §7.1, §7.3).
//
// Every refusal a caller may need to tell apart carries a stable `code`, so the
// CLI and the agent tools can report it by name instead of by message text.

export type BusRefusalCode =
  | "invalid-id"
  | "invalid-name"
  | "reserved-name"
  | "name-taken"
  | "invalid-event"
  | "invalid-presence"
  | "body-too-large"
  | "bus-disabled"
  | "unknown-recipient"
  | "recipient-not-live"
  | "recipient-is-self"
  | "rate-limited"
  | "reply-without-replyTo"
  | "unknown-message"
  | "use-agent-tool"
  | "lease-already-held"
  | "ttl-out-of-range"
  | "not-lease-holder";

export class BusRefusal extends Error {
  readonly code: BusRefusalCode;

  constructor(code: BusRefusalCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "BusRefusal";
    this.code = code;
  }
}

export function isBusRefusal(error: unknown, code?: BusRefusalCode): error is BusRefusal {
  return error instanceof BusRefusal && (code === undefined || error.code === code);
}
