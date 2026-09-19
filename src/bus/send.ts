// Sending a message on the bus (specification §4.2, §7.3; decisions D-06, D-12).
//
// Three senders share this module: the `keryx bus send` CLI, origin `cli`;
// the interactive bus client's own operator-authored sends (`./client.ts`'s
// `send`/`reply`), origin `operator`; and the interactive agent's own tool
// calls (`./client.ts`'s `sendAsAgent`/`replyAsAgent`, called from
// `./agent-tools.ts`'s `bus_send`), origin `agent`. The CLI has no presence,
// so every call takes a fresh sender id, and the only bound that can hold it
// is clone-wide: at most 30 CLI-origin messages per minute, counted from the
// log itself under `append.lock` so concurrent senders cannot both slip under
// the limit. An operator send carries the caller's own `instanceId`/`name`
// and is bounded per instance instead (D-12): 30 per minute from that one
// instanceId. An agent-origin send is bounded per instance too, but with its
// own, tighter budget (D-12): 10 per minute — counted from the log exactly
// like the other two, so the window survives a `buildBusTools` rebuild
// (review r1 F5) rather than resetting with every new closure. None of the
// three limits is shared with another — a busy operator cannot exhaust the
// clone-wide CLI budget, the CLI cannot exhaust any one instance's budget, and
// the model's own agent-origin sends cannot exhaust (or be exhausted by) that
// same instance's operator budget (review r1 F3).

import { randomUUID } from "node:crypto";
import { BusRefusal } from "./errors";
import { appendEvent, countRecent } from "./log";
import { isBusId } from "./paths";
import { classifyPresence, listPresence, type PresenceClassifyOptions } from "./presence";
import type { BusEvent, BusEventKind, BusSender } from "./schema";

export const SENDABLE_KINDS = ["notice", "question", "handoff", "reply"] as const;
export type SendableKind = (typeof SENDABLE_KINDS)[number];

/** D-12: CLI-origin messages per minute, whole clone. */
export const CLI_RATE_LIMIT_PER_MINUTE = 30;
/** D-12: operator-origin messages per minute, per sending instance. */
export const OPERATOR_RATE_LIMIT_PER_MINUTE = 30;
/**
 * D-12: agent-origin messages per minute, per sending instance — the model's
 * own `bus_send` tool calls (`./agent-tools.ts`), never the operator's own
 * typed `/bus send`. Counted from the log under `append.lock`, exactly like
 * the CLI/operator budgets above, so it survives a `buildBusTools` rebuild
 * (review r1 F5) and is a property of this instance's send history rather
 * than of any one in-memory closure.
 */
export const AGENT_RATE_LIMIT_PER_MINUTE = 10;
const RATE_WINDOW_MS = 60_000;

export interface SendInput {
  /** `@<name>` or `@all`. Always the event's display label, even when `toInstanceId` is set. */
  toLabel: string;
  kind: string;
  body: string;
  replyTo?: string | undefined;
  origin: "cli" | "operator" | "agent";
  /** Required (and used) for `origin: "operator"` and `origin: "agent"`; the CLI path always mints its own. */
  from?: BusSender | undefined;
  now?: (() => number) | undefined;
  /** D-09 inputs for recipient resolution; defaults to this host and `processIsAlive`. */
  liveness?: Omit<PresenceClassifyOptions, "now"> | undefined;
  /** Environment consulted for the test-only rate-limit bypass; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
  /**
   * A `reply` addressed by instance id rather than by current name (review r1
   * F4): bypasses `resolveRecipients`/name lookup entirely, so a sender who
   * renamed between the original message and the reply is still reached.
   * Still requires the instance to be live, else `recipient-not-live` —
   * never `unknown-recipient`, since the id came from a message we actually
   * received rather than from user-typed text. `toLabel` is unaffected: it
   * stays the display label (`@<name at send time>`).
   */
  toInstanceId?: string | undefined;
}

export interface SendResult {
  seq: number;
  id: string;
  /** Instance ids the message was addressed to, or `["*"]`. */
  resolvedTo: string[];
  event: BusEvent;
}

/**
 * TEST-ONLY: `KERYX_TEST_BUS_RATE=off` disables the clone-wide CLI rate limit so
 * the 8-process concurrency test can append 800 events. Honoured only in a test
 * context, exactly like the session-lease timing knobs (`src/session/lease.ts`):
 * `NODE_ENV === "test"` (set by `bun test`) or `KERYX_TEST_BUS === "1"` (set by
 * a subprocess test). Any other value, or the flag outside a test context, is
 * ignored and the limit applies.
 */
export function rateLimitBypassed(env: Readonly<Record<string, string | undefined>>): boolean {
  const testContext = env.NODE_ENV === "test" || env.KERYX_TEST_BUS === "1";
  return testContext && env.KERYX_TEST_BUS_RATE === "off";
}

function isSendableKind(kind: string): kind is SendableKind {
  return (SENDABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Resolve `@name` to the instance ids of LIVE instances holding that name.
 * A name nobody holds is `unknown-recipient`; a name held only by stale or gone
 * instances is `recipient-not-live` (D-06: never queued for a future instance).
 */
export async function resolveRecipients(
  root: string,
  toLabel: string,
  options: PresenceClassifyOptions,
): Promise<string[]> {
  if (toLabel === "@all") return ["*"];
  if (!toLabel.startsWith("@") || toLabel.length < 2) {
    throw new BusRefusal("unknown-recipient", `address ${JSON.stringify(toLabel)} must be @<name> or @all`);
  }
  const name = toLabel.slice(1);
  const holders = (await listPresence(root)).filter((record) => record.name === name);
  if (holders.length === 0) {
    throw new BusRefusal("unknown-recipient", `no instance is named @${name}`);
  }
  const live = holders.filter((record) => classifyPresence(record, options) === "live");
  if (live.length === 0) {
    throw new BusRefusal("recipient-not-live", `@${name} is not live (${holders.length} stale or gone)`);
  }
  return [...new Set(live.map((record) => record.instanceId))].sort();
}

export async function sendMessage(root: string, input: SendInput): Promise<SendResult> {
  const now = input.now ?? Date.now;
  if (!isSendableKind(input.kind)) {
    throw new BusRefusal("invalid-event", `kind "${input.kind}" is not one of ${SENDABLE_KINDS.join(", ")}`);
  }
  const kind: BusEventKind = input.kind;
  if (kind === "reply" && (input.replyTo === undefined || input.replyTo.length === 0)) {
    throw new BusRefusal("reply-without-replyTo", "a reply needs --reply-to <event id>");
  }
  if (input.replyTo !== undefined && !isBusId(input.replyTo)) {
    throw new BusRefusal("invalid-id", `replyTo ${JSON.stringify(input.replyTo)} is not a UUID`);
  }
  if ((input.origin === "operator" || input.origin === "agent") && input.from === undefined) {
    throw new BusRefusal("invalid-event", `a ${input.origin} send needs from: { instanceId, name, origin: "${input.origin}" }`);
  }

  let to: string[];
  if (input.toInstanceId !== undefined) {
    if (!isBusId(input.toInstanceId)) {
      throw new BusRefusal("invalid-id", `toInstanceId ${JSON.stringify(input.toInstanceId)} is not a UUID`);
    }
    const holder = (await listPresence(root)).find((record) => record.instanceId === input.toInstanceId);
    const options: PresenceClassifyOptions = { ...input.liveness, now: now() };
    const isLive = holder !== undefined && classifyPresence(holder, options) === "live";
    if (!isLive) {
      throw new BusRefusal("recipient-not-live", `instance ${input.toInstanceId} is not live`);
    }
    to = [input.toInstanceId];
  } else {
    to = await resolveRecipients(root, input.toLabel, { ...input.liveness, now: now() });
  }
  // review r1 F6: a send whose only resolved recipient is the sender itself
  // (e.g. `@<own-name>`, or a reply addressed back to one's own instance) is
  // refused rather than delivered — `@all` is unaffected, since it resolves
  // to `["*"]`, never to a concrete instance id.
  if (input.from !== undefined && to.length === 1 && to[0] === input.from.instanceId) {
    throw new BusRefusal("recipient-is-self", `${input.toLabel} resolves only to this instance`);
  }
  const env = input.env ?? process.env;
  const from: BusSender = input.origin === "cli" ? { instanceId: randomUUID(), name: "cli", origin: "cli" } : (input.from as BusSender);
  const event = await appendEvent(
    root,
    {
      from,
      to,
      toLabel: input.toLabel,
      kind,
      body: input.body,
      ...(input.replyTo !== undefined ? { refs: { replyTo: input.replyTo } } : {}),
    },
    {
      now,
      underLock: async () => {
        if (rateLimitBypassed(env)) return;
        if (from.origin === "cli") {
          const recent = await countRecent(root, { origin: "cli", sinceMs: RATE_WINDOW_MS, now });
          if (recent >= CLI_RATE_LIMIT_PER_MINUTE) {
            throw new BusRefusal(
              "rate-limited",
              `${recent} CLI messages in the last minute; the clone-wide limit is ${CLI_RATE_LIMIT_PER_MINUTE}`,
            );
          }
        } else if (from.origin === "operator") {
          const recent = await countRecent(root, {
            origin: "operator",
            sinceMs: RATE_WINDOW_MS,
            now,
            instanceId: from.instanceId,
          });
          if (recent >= OPERATOR_RATE_LIMIT_PER_MINUTE) {
            throw new BusRefusal(
              "rate-limited",
              `${recent} operator messages from this instance in the last minute; the limit is ${OPERATOR_RATE_LIMIT_PER_MINUTE}`,
            );
          }
        } else if (from.origin === "agent") {
          // review r1 F3/F5: counted from the log, per instance, so the
          // budget is a property of this instance's send history rather than
          // of any one `buildBusTools` closure's lifetime.
          const recent = await countRecent(root, {
            origin: "agent",
            sinceMs: RATE_WINDOW_MS,
            now,
            instanceId: from.instanceId,
          });
          if (recent >= AGENT_RATE_LIMIT_PER_MINUTE) {
            throw new BusRefusal(
              "rate-limited",
              `${recent} agent messages from this instance in the last minute; the limit is ${AGENT_RATE_LIMIT_PER_MINUTE}`,
            );
          }
        }
      },
    },
  );
  return { seq: event.seq, id: event.id, resolvedTo: to, event };
}
