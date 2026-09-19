// The interactive agent's own bus tools (specification §7.1; decisions D-05,
// D-12, D-13; flow 274 T6).
//
// Two tools, both `risk: "read"` (D-05 — a tool's risk is static, read once in
// `executeCall`): `bus_list` and `bus_send`. `bus_pause` (`risk: "write"`) is
// P4 and not built here.
//
// Offered ONLY to the interactive main agent (`buildInteractiveAgentTools`,
// `../commands/interactive-agent-tools.ts`) — never to a subagent or an
// external child (§7.1: "None of these tools is offered to subagents or
// external children in v1."). Neither tool set is built from this factory.
//
// `bus_send`'s own rate limit (D-12: 10 agent-origin messages per minute per
// instance) is enforced HERE, not inside `BusClient`: the client's `send`/
// `reply` always write with `from.origin: "operator"` (`./client.ts`), which
// carries send.ts's own 30/minute operator-origin limit — that limit is a
// property of the STORAGE layer and is unrelated to this tool's D-12 budget.
// So this module keeps its own sliding window, with an injectable clock for
// deterministic tests, and refuses locally (`rate-limited`) before ever
// calling `client.send`/`client.reply`.

import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import type { BusClient } from "./client";
import { displaySafe } from "./display";
import { isBusRefusal, type BusRefusalCode } from "./errors";
import { listActiveLeases } from "./leases";
import type { PresenceLiveness } from "./presence";
import { SENDABLE_KINDS, type SendableKind } from "./send";

/** D-12: agent-origin messages per minute, per instance. */
export const AGENT_RATE_LIMIT_PER_MINUTE = 10;
const AGENT_RATE_WINDOW_MS = 60_000;

export interface BuildBusToolsOptions {
  /** Injectable clock for the agent-origin rate limiter; defaults to `Date.now`. */
  now?: () => number;
}

function refusal(toolName: string, code: BusRefusalCode, message: string): InteractiveToolResult {
  return { output: `${toolName}: ${code}: ${displaySafe(message)}`, isError: true };
}

/**
 * A `BusRefusal` thrown by `client.send`/`client.reply`, reported the same
 * way a locally-built {@link refusal} is. `BusRefusal`'s own `message` is
 * already `"<code>: <detail>"` (see `./errors.ts`'s constructor) — passing it
 * through `refusal()` a second time would duplicate the code, so this reads
 * the code once and formats it exactly like every other refusal here.
 */
function refusalFromError(toolName: string, error: { code: BusRefusalCode; message: string }): InteractiveToolResult {
  return { output: `${toolName}: ${displaySafe(error.message)}`, isError: true };
}

/**
 * A holder's liveness, read from the client's own already-classified peer
 * list rather than re-deriving `classifyPresence` a second time here: `self`
 * is always live (this process is running), and any other holder is exactly
 * as live/stale/gone as `client.peers()` (which already excludes `gone`
 * records) reports it.
 */
function holderLiveness(client: BusClient, instanceId: string): PresenceLiveness {
  if (instanceId === client.instanceId) return "live";
  const peer = client.peers().find((candidate) => candidate.record.instanceId === instanceId);
  return peer === undefined ? "gone" : peer.state;
}

/** A lease this instance holds, or that targets it (specification §4.3: "applies to me"). */
function appliesToInstance(lease: { holder: { instanceId: string }; targets: readonly string[] }, instanceId: string): boolean {
  if (lease.holder.instanceId === instanceId) return true;
  if (lease.targets.includes(instanceId)) return true;
  return lease.targets.length === 1 && lease.targets[0] === "*";
}

const BUS_LIST_DESCRIPTION =
  "List bus peers and leases. Returns JSON: self ({name, instanceId}), peers " +
  "(live and stale instances other than you: name, state, status, activity, checkout, branch), " +
  "and leases (active pause leases that apply to you or that you hold). " +
  "Refuses with bus-disabled when the bus is not joined in this session.";

const BUS_SEND_DESCRIPTION =
  "Send a message on the agent bus to another joined keryx instance. Input: " +
  "{ to: '@name'|'@all', kind: 'notice'|'question'|'reply'|'handoff', body: string, replyTo?: string }. " +
  "replyTo is required when kind is 'reply' (addresses the ORIGINAL sender, even if they renamed since). " +
  "Prefer @name over @all; use @all only for facts every peer needs. Answer a question with " +
  "kind 'reply' and replyTo, never a new thread. Do not answer an ack or a courtesy notice. " +
  "Send only state, intent, a question or a handoff — never transcripts, diffs, file contents, " +
  "secrets or reasoning. Refusals: bus-disabled, unknown-recipient, recipient-not-live, " +
  "rate-limited, body-too-large, reply-without-replyTo, unknown-message. On success returns " +
  "{ seq, id, resolvedTo }.";

/**
 * Build `bus_list` and `bus_send`. `getClient` is read at every call (build
 * time AND call time): a session that has not joined yet, or that left, is
 * `undefined`, and both tools then refuse with `bus-disabled` rather than
 * throwing — the simplest of the two options the flow-274 dispatch allows,
 * chosen because it means the tool ROSTER never has to change shape mid-session
 * as the bus connects or drops.
 */
export function buildBusTools(getClient: () => BusClient | undefined, options: BuildBusToolsOptions = {}): InteractiveTool[] {
  const now = options.now ?? Date.now;

  // The agent-origin sliding window (D-12). One window per built tool set,
  // which is exactly one per joined session — `buildInteractiveAgentTools` is
  // called once per session (rebuilds reuse the same `bus` option), so this
  // closure's lifetime matches the instance's.
  let sendTimestamps: number[] = [];
  function withinAgentRateLimit(): boolean {
    const at = now();
    sendTimestamps = sendTimestamps.filter((sentAt) => at - sentAt < AGENT_RATE_WINDOW_MS);
    if (sendTimestamps.length >= AGENT_RATE_LIMIT_PER_MINUTE) return false;
    sendTimestamps.push(at);
    return true;
  }

  const busList: InteractiveTool = {
    definition: {
      name: "bus_list",
      description: BUS_LIST_DESCRIPTION,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "read",
    },
    invoke: async (): Promise<InteractiveToolResult> => {
      const client = getClient();
      if (client === undefined) {
        return refusal("bus_list", "bus-disabled", "the bus is not joined in this session");
      }
      const peers = client.peers();
      const activeLeases = await listActiveLeases(client.root, {
        now: now(),
        holderLiveness: (id: string) => holderLiveness(client, id),
      });
      const leases = activeLeases.filter((lease) => appliesToInstance(lease, client.instanceId));
      const payload = {
        self: { name: displaySafe(client.name), instanceId: client.instanceId },
        peers: peers.map((peer) => ({
          name: displaySafe(peer.record.name),
          state: peer.state,
          status: displaySafe(peer.record.status),
          activity: displaySafe(peer.record.activity),
          checkout: displaySafe(peer.record.checkout),
          branch: peer.record.branch === null ? null : displaySafe(peer.record.branch),
        })),
        leases: leases.map((lease) => ({
          leaseId: lease.leaseId,
          holder: { name: displaySafe(lease.holder.name), instanceId: lease.holder.instanceId },
          heldByMe: lease.holder.instanceId === client.instanceId,
          scope: lease.scope,
          reason: displaySafe(lease.reason),
          expiresAt: lease.expiresAt,
        })),
      };
      return { output: JSON.stringify(payload), isError: false };
    },
  };

  const busSend: InteractiveTool = {
    definition: {
      name: "bus_send",
      description: BUS_SEND_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          kind: { type: "string", enum: [...SENDABLE_KINDS] },
          body: { type: "string" },
          replyTo: { type: "string" },
        },
        required: ["to", "kind", "body"],
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const client = getClient();
      if (client === undefined) {
        return refusal("bus_send", "bus-disabled", "the bus is not joined in this session");
      }
      const to = typeof input.to === "string" ? input.to : "";
      const kindRaw = typeof input.kind === "string" ? input.kind : "";
      const body = typeof input.body === "string" ? input.body : "";
      const replyTo = typeof input.replyTo === "string" && input.replyTo.length > 0 ? input.replyTo : undefined;
      if (!(SENDABLE_KINDS as readonly string[]).includes(kindRaw)) {
        return { output: `bus_send: kind must be one of ${SENDABLE_KINDS.join(", ")}`, isError: true };
      }
      const kind = kindRaw as SendableKind;
      if (kind === "reply" && replyTo === undefined) {
        return refusal("bus_send", "reply-without-replyTo", "a reply needs replyTo (the id/#seq/prefix of the message being answered)");
      }
      if (!withinAgentRateLimit()) {
        return refusal(
          "bus_send",
          "rate-limited",
          `this instance already sent ${AGENT_RATE_LIMIT_PER_MINUTE} agent-origin messages in the last minute`,
        );
      }
      try {
        const result = kind === "reply" ? await client.reply(replyTo as string, body) : await client.send(to, kind, body);
        return { output: JSON.stringify({ seq: result.seq, id: result.id, resolvedTo: result.resolvedTo }), isError: false };
      } catch (error) {
        if (isBusRefusal(error)) {
          return refusalFromError("bus_send", error);
        }
        throw error;
      }
    },
  };

  return [busList, busSend];
}
