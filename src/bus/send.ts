// Sending a message on the bus (specification §4.2, §7.3; decisions D-06, D-12).
//
// P1 has one sender: the `keryx bus send` CLI, origin `cli`. It has no
// presence, so every call takes a fresh sender id, and the only bound that can
// hold it is clone-wide: at most 30 CLI-origin messages per minute, counted
// from the log itself under `append.lock` so concurrent senders cannot both
// slip under the limit.

import { randomUUID } from "node:crypto";
import { BusRefusal } from "./errors";
import { appendEvent, countRecent } from "./log";
import { isBusId } from "./paths";
import { classifyPresence, listPresence, type PresenceClassifyOptions } from "./presence";
import type { BusEvent, BusEventKind } from "./schema";

export const SENDABLE_KINDS = ["notice", "question", "handoff", "reply"] as const;
export type SendableKind = (typeof SENDABLE_KINDS)[number];

/** D-12: CLI-origin messages per minute, whole clone. */
export const CLI_RATE_LIMIT_PER_MINUTE = 30;
const RATE_WINDOW_MS = 60_000;

export interface SendInput {
  /** `@<name>` or `@all`. */
  toLabel: string;
  kind: string;
  body: string;
  replyTo?: string | undefined;
  origin: "cli";
  now?: (() => number) | undefined;
  /** D-09 inputs for recipient resolution; defaults to this host and `processIsAlive`. */
  liveness?: Omit<PresenceClassifyOptions, "now"> | undefined;
  /** Environment consulted for the test-only rate-limit bypass; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>> | undefined;
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

  const to = await resolveRecipients(root, input.toLabel, { ...input.liveness, now: now() });
  const env = input.env ?? process.env;
  const event = await appendEvent(
    root,
    {
      from: { instanceId: randomUUID(), name: "cli", origin: input.origin },
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
        const recent = await countRecent(root, { origin: "cli", sinceMs: RATE_WINDOW_MS, now });
        if (recent >= CLI_RATE_LIMIT_PER_MINUTE) {
          throw new BusRefusal(
            "rate-limited",
            `${recent} CLI messages in the last minute; the clone-wide limit is ${CLI_RATE_LIMIT_PER_MINUTE}`,
          );
        }
      },
    },
  );
  return { seq: event.seq, id: event.id, resolvedTo: to, event };
}
