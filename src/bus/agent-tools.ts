// The interactive agent's own bus tools (specification §7.1; decisions D-05,
// D-12, D-13; flow 274 T6, flow 275 T6).
//
// Three tools: `bus_list` and `bus_send`, both `risk: "read"`, and `bus_pause`
// (`risk: "write"`, flow 275/P4), because a tool's risk is static (D-05, read
// once in `executeCall`). `bus_pause` writes through `client.pause`/
// `client.resume` (`./client.ts`), which mint `holder.origin`/`by.origin:
// "agent"` — distinguishing the model's own tool call from the operator's
// `/bus pause`/`keryx bus pause` — and share `createPauseLease`/
// `resumePauseLease`'s refusals (`./pause.ts`).
//
// Offered ONLY to the interactive main agent (`buildInteractiveAgentTools`,
// `../commands/interactive-agent-tools.ts`) — never to a subagent or an
// external child (§7.1: "None of these tools is offered to subagents or
// external children in v1."), and never to a side worker (`bus_pause`'s
// `risk: "write"` alone already excludes it from the side-worker roster,
// which is filtered to `risk === "read"`; see `tui-shell.ts`'s
// `SIDE_WORKER_DENIED_TOOL_NAMES`). Neither tool set is built from this
// factory.
//
// `bus_send` writes through `client.sendAsAgent`/`client.replyAsAgent`
// (`./client.ts`), which mint `from.origin: "agent"` and are counted against
// `send.ts`'s own `AGENT_RATE_LIMIT_PER_MINUTE` (10/minute per instance,
// D-12) from the log itself, under `append.lock` — exactly like the CLI and
// operator budgets. This module used to keep its own in-memory sliding
// window and refuse locally before ever calling the client; that window
// reset on every `buildBusTools` rebuild (a join, `/model`, `/connect`: review
// r1 F5) and wrote agent-origin sends with `from.origin: "operator"`,
// misattributing them and spending the OPERATOR budget instead of its own
// (review r1 F3). Counting from the log instead means the budget is a
// property of this instance's send history, not of any one closure's
// lifetime, and every refusal (including `rate-limited`) now comes back from
// `client.sendAsAgent`/`replyAsAgent` through the generic `BusRefusal`
// mapping below rather than from a check local to this file.

import type { InteractiveTool, InteractiveToolResult } from "../harness/tool/builtin/interactive-tools";
import { quarantinePeerMessage } from "../harness/child/quarantine";
import type { BusClient } from "./client";
import { displaySafe } from "./display";
import { isBusRefusal, type BusRefusalCode } from "./errors";
import { listActiveLeases } from "./leases";
import type { PresenceLiveness } from "./presence";
import { LEASE_SCOPES, type LeaseScope } from "./schema";
import { AGENT_RATE_LIMIT_PER_MINUTE, SENDABLE_KINDS, type SendableKind } from "./send";

export { AGENT_RATE_LIMIT_PER_MINUTE };

export interface BuildBusToolsOptions {
  /** Injectable clock; kept for callers that pass one, though `bus_send`'s own rate limiting now lives in `./send.ts`, counted from the log. */
  now?: () => number;
}

function refusal(toolName: string, code: BusRefusalCode, message: string): InteractiveToolResult {
  return { output: `${toolName}: ${code}: ${displaySafe(message)}`, isError: true };
}

/**
 * A `BusRefusal` thrown by `client.sendAsAgent`/`client.replyAsAgent`,
 * reported the same way a locally-built {@link refusal} is. `BusRefusal`'s
 * own `message` is already `"<code>: <detail>"` (see `./errors.ts`'s
 * constructor) — passing it
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

/** Default scope for `bus_pause` when the model omits one (specification §4.3). */
const DEFAULT_PAUSE_SCOPE: LeaseScope = "turns";

const BUS_PAUSE_DESCRIPTION =
  "Ask peers on the agent bus to pause, or end a pause you hold. Input: " +
  "{ action: 'pause'|'resume', to?, scope?, ttlMinutes?, reason?, leaseId? }. " +
  "For action 'pause': to ('@name'|'@all') and reason are required; scope defaults to 'turns'. " +
  "Scopes: 'turns' (peers start no new turn until you resume — use before a risky shared-branch " +
  "step), 'git-publish' (peers may keep working but must not push/tag/merge/publish until you " +
  "resume — use before your own release/publish/force-push), 'advisory' (peers are informed, " +
  "nothing is enforced). ttlMinutes defaults to 30, maximum 240 (4h). For action 'resume': " +
  "leaseId (a lease this instance holds) is required. Always resume a git-publish lease as soon " +
  "as you are done, including when the operation fails. Refusals: bus-disabled, " +
  "unknown-recipient, recipient-not-live, recipient-is-self, lease-already-held, " +
  "ttl-out-of-range, not-lease-holder. On success returns { seq, leaseId }.";

const BUS_SEND_DESCRIPTION =
  "Send a message on the agent bus to another joined keryx instance. Input: " +
  "{ to: '@name'|'@all', kind: 'notice'|'question'|'reply'|'handoff', body: string, replyTo?: string }. " +
  "replyTo is required when kind is 'reply' (addresses the ORIGINAL sender, even if they renamed since). " +
  "Prefer @name over @all; use @all only for facts every peer needs. Answer a question with " +
  "kind 'reply' and replyTo, never a new thread. Do not answer an ack or a courtesy notice. " +
  "Send only state, intent, a question or a handoff — never transcripts, diffs, file contents, " +
  "secrets or reasoning. Refusals: bus-disabled, unknown-recipient, recipient-not-live, " +
  "recipient-is-self, rate-limited, body-too-large, reply-without-replyTo, unknown-message. " +
  "On success returns { seq, id, resolvedTo }.";

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
        // review r1 F12: `status`/`activity` are free text another instance
        // wrote (`writeCurrentPresence`'s `opts.status()`, `./client.ts`) and
        // reach the model here — `displaySafe` alone strips control
        // characters but does not flag instruction-shaped text the way a bus
        // message body already is (`quarantinePeerMessage`, shared with
        // `../harness/child/quarantine.ts`'s child-summary quarantine).
        peers: peers.map((peer) => ({
          name: displaySafe(peer.record.name),
          state: peer.state,
          status: quarantinePeerMessage(displaySafe(peer.record.status)).text,
          activity: quarantinePeerMessage(displaySafe(peer.record.activity)).text,
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
      try {
        // review r1 F3: written with `from.origin: "agent"` and counted
        // against `./send.ts`'s own AGENT_RATE_LIMIT_PER_MINUTE budget, never
        // the operator's `send`/`reply` (D-12).
        const result =
          kind === "reply" ? await client.replyAsAgent(replyTo as string, body) : await client.sendAsAgent(to, kind, body);
        return { output: JSON.stringify({ seq: result.seq, id: result.id, resolvedTo: result.resolvedTo }), isError: false };
      } catch (error) {
        if (isBusRefusal(error)) {
          return refusalFromError("bus_send", error);
        }
        throw error;
      }
    },
  };

  const busPause: InteractiveTool = {
    definition: {
      name: "bus_pause",
      description: BUS_PAUSE_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["pause", "resume"] },
          to: { type: "string" },
          scope: { type: "string", enum: [...LEASE_SCOPES] },
          ttlMinutes: { type: "number" },
          reason: { type: "string" },
          leaseId: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      // D-05: risk is static per tool. `bus_pause` mutates every OTHER
      // instance's turn/publish behavior, unlike `bus_send`'s read-risk
      // notices — it goes through `resolveApprovalDecision` like any other
      // write (`executeCall`'s write branch, `../commands/agent.ts`), with no
      // escalation dimension of its own (specification §7.1).
      risk: "write",
    },
    invoke: async (input): Promise<InteractiveToolResult> => {
      const client = getClient();
      if (client === undefined) {
        return refusal("bus_pause", "bus-disabled", "the bus is not joined in this session");
      }
      const action = typeof input.action === "string" ? input.action : "";

      if (action === "pause") {
        const to = typeof input.to === "string" ? input.to : "";
        const reason = typeof input.reason === "string" ? input.reason : "";
        if (to.length === 0) {
          return { output: 'bus_pause: "to" is required for action "pause"', isError: true };
        }
        if (reason.length === 0) {
          return { output: 'bus_pause: "reason" is required for action "pause"', isError: true };
        }
        const scopeRaw = typeof input.scope === "string" && input.scope.length > 0 ? input.scope : DEFAULT_PAUSE_SCOPE;
        if (!(LEASE_SCOPES as readonly string[]).includes(scopeRaw)) {
          return { output: `bus_pause: scope must be one of ${LEASE_SCOPES.join(", ")}`, isError: true };
        }
        const scope = scopeRaw as LeaseScope;
        const ttlMinutes = typeof input.ttlMinutes === "number" ? input.ttlMinutes : undefined;
        const ttlMs = ttlMinutes === undefined ? undefined : ttlMinutes * 60_000;
        try {
          const lease = await client.pause(to, scope, reason, ttlMs, "agent");
          return { output: JSON.stringify({ seq: lease.requestEventSeq, leaseId: lease.leaseId }), isError: false };
        } catch (error) {
          if (isBusRefusal(error)) {
            return refusalFromError("bus_pause", error);
          }
          throw error;
        }
      }

      if (action === "resume") {
        const leaseId = typeof input.leaseId === "string" ? input.leaseId : "";
        if (leaseId.length === 0) {
          return { output: 'bus_pause: "leaseId" is required for action "resume"', isError: true };
        }
        try {
          await client.resume(leaseId, "agent");
          return { output: JSON.stringify({ leaseId }), isError: false };
        } catch (error) {
          if (isBusRefusal(error)) {
            return refusalFromError("bus_pause", error);
          }
          throw error;
        }
      }

      return { output: 'bus_pause: action must be "pause" or "resume"', isError: true };
    },
  };

  return [busList, busSend, busPause];
}
