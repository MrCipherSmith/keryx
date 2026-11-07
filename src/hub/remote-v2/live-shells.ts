import {
  canShowExactApproval,
  liveShellLimits as limits,
  type LiveShellCommand,
  type LiveShellContext,
  type LiveShellDelivery,
  type LiveShellDetail,
  type LiveShellMessage,
  type LiveShellReply,
  type LiveShellSummary,
  type LiveShellUpdate,
  type LiveShellUsage,
} from "../../remote-control/live-shell";
import type { FrameOf } from "../../remote-control/protocol";
import { fail, sha256 } from "../domain";
import { operator, scoped } from "./guards";
import type { RemotePorts } from "./index";
import type { HumanAuthority, MachineRecord, SessionRow } from "./model";
import { redact } from "./results";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const operationIdPattern = /^[0-9a-f]{64}$/;
const bindingId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const commandName = /^[a-z][a-z0-9-]{0,63}$/;
const record = (value: unknown, keys: string[]): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !keys.includes(key))) {
    fail(400, "invalid-arguments", "Invalid live shell payload");
  }
  return value as Record<string, unknown>;
};
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > max) {
    fail(400, "invalid-arguments", "Invalid live shell text");
  }
  return value;
}
function displayText(value: unknown, max: number): string {
  return redact(text(value, max));
}
const identifier = (value: unknown, format: RegExp): string => {
  if (typeof value !== "string" || !format.test(value)) {
    fail(400, "invalid-arguments", "Invalid live shell identifier");
  }
  return value;
};

function usage(value: unknown): LiveShellUsage {
  const keys = ["tokensIn", "tokensOut", "cacheRead", "cacheWrite", "activeMs"] as const;
  const raw = record(value, [...keys]);
  const count = (key: typeof keys[number]): number => {
    const amount = raw[key];
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      fail(400, "invalid-arguments", "Invalid live shell usage");
    }
    return amount;
  };
  return {
    tokensIn: count("tokensIn"), tokensOut: count("tokensOut"),
    cacheRead: count("cacheRead"), cacheWrite: count("cacheWrite"), activeMs: count("activeMs"),
  };
}

function boundedList<T>(value: unknown, max: number, parse: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) {
    fail(400, "invalid-arguments", "Invalid live shell catalogue");
  }
  return value.map(parse);
}

function parseContext(value: unknown): LiveShellContext {
  const raw = record(value, ["model", "commands", "usage", "approval", "phase"]);
  const context: LiveShellContext = {};
  if (raw.model !== undefined) {
    const model = record(raw.model, ["currentId", "candidates"]);
    const candidates = boundedList(model.candidates, limits.candidateCount, value => {
      const candidate = record(value, ["id", "label"]);
      return { id: identifier(candidate.id, bindingId), label: displayText(candidate.label, limits.descriptionBytes) };
    });
    if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) {
      fail(400, "invalid-arguments", "Duplicate live shell model");
    }
    context.model = { currentId: identifier(model.currentId, bindingId), candidates };
  }
  if (raw.commands !== undefined) {
    const commands = boundedList(raw.commands, limits.commandCount, value => {
      const command = record(value, ["name", "description"]);
      return { name: identifier(command.name, commandName), description: displayText(command.description, limits.descriptionBytes) };
    });
    if (new Set(commands.map(command => command.name)).size !== commands.length) {
      fail(400, "invalid-arguments", "Duplicate live shell command");
    }
    context.commands = commands;
  }
  if (raw.usage !== undefined) {
    const counts = record(raw.usage, ["turn", "session"]);
    context.usage = { turn: usage(counts.turn), session: usage(counts.session) };
  }
  if (raw.approval !== undefined) {
    const approval = record(raw.approval, ["id", "tool", "summary", "reason", "canAnswer"]);
    if (typeof approval.canAnswer !== "boolean") fail(400, "invalid-arguments", "Invalid live shell approval");
    const tool = displayText(approval.tool, limits.titleBytes);
    const summary = displayText(approval.summary, limits.approvalSummaryBytes);
    const reason = displayText(approval.reason, limits.descriptionBytes);
    context.approval = {
      id: identifier(approval.id, uuid), tool, summary, reason,
      canAnswer: approval.canAnswer && canShowExactApproval(summary) &&
        tool === approval.tool && summary === approval.summary && reason === approval.reason,
    };
  }
  if (raw.phase !== undefined) {
    if (raw.phase !== "thinking" && raw.phase !== "working" && raw.phase !== "waiting-input") {
      fail(400, "invalid-arguments", "Invalid live shell phase");
    }
    context.phase = raw.phase;
  }
  return context;
}

function parseUpdate(value: unknown): LiveShellUpdate {
  const raw = record(value, ["projectId", "checkoutId", "title", "busy", "turnId", "messages", "context", "ack"]);
  const projectId = identifier(raw.projectId, bindingId);
  const checkoutId = identifier(raw.checkoutId, bindingId);
  const title = redact(text(raw.title, limits.titleBytes)).trim();
  const busy = raw.busy;
  if (!title || typeof busy !== "boolean" || (!busy && raw.turnId !== undefined)) {
    fail(400, "invalid-arguments", "Invalid live shell status");
  }
  const update: LiveShellUpdate = { projectId, checkoutId, title, busy };
  if (raw.turnId !== undefined) update.turnId = identifier(raw.turnId, uuid);
  if (raw.messages !== undefined) {
    if (!Array.isArray(raw.messages) || raw.messages.length > limits.messages) {
      fail(400, "invalid-arguments", "Invalid live shell history");
    }
    let bytes = 0;
    update.messages = raw.messages.map(entry => {
      const message = record(entry, ["role", "text"]);
      if (message.role !== "user" && message.role !== "assistant") {
        fail(400, "invalid-arguments", "Invalid live shell message role");
      }
      const safe = redact(text(message.text, limits.messageBytes));
      bytes += Buffer.byteLength(safe);
      if (bytes > limits.historyBytes) fail(413, "quota-exceeded", "Live shell history exceeds quota");
      return { role: message.role, text: safe };
    });
  }
  if (raw.context !== undefined) update.context = parseContext(raw.context);
  if (raw.ack !== undefined) {
    const ack = record(raw.ack, ["id", "status", "output"]);
    if (ack.status !== "applied" && ack.status !== "rejected") {
      fail(400, "invalid-arguments", "Invalid live shell acknowledgement");
    }
    update.ack = { id: identifier(ack.id, operationIdPattern), status: ack.status };
    if (ack.output !== undefined && ack.status === "applied") {
      update.ack.output = displayText(ack.output, limits.outputBytes);
    }
  }
  return update;
}

type Lease = { generation: object; actor: string; clientId: string; expiresAt: number };
type Operation = { actor: string; digest: string; delivery: LiveShellDelivery; offered: boolean };
type Pending = {
  command: LiveShellCommand;
  authority: HumanAuthority;
  leaseGeneration: Lease["generation"];
  operation: Operation;
  expiresAt: number;
};
type LiveShell = {
  summary: LiveShellSummary;
  projectId: string;
  machineId: string;
  heartbeatAt: number;
  turnId: string | undefined;
  context: LiveShellContext | undefined;
  messages: LiveShellMessage[];
  lease?: Lease;
  operations: Map<string, Operation>;
  outputOperations: Operation[];
  pending?: Pending;
};
const actorKey = (auth: HumanAuthority) => sha256(JSON.stringify([auth.actor.id, auth.sessionDigest]));

function parseCommand(action: string, args: Record<string, unknown>, id: string): LiveShellCommand {
  switch (action) {
    case "message": {
      const message = text(args.text, limits.messageBytes);
      if (!message.trim()) fail(400, "invalid-arguments", "Enter a message");
      return { id, kind: "message", text: message };
    }
    case "stop":
      return { id, kind: "stop", turnId: identifier(args.turnId, uuid) };
    case "invoke":
      return { id, kind: "invoke", name: identifier(args.name, commandName) };
    case "select-model":
      return { id, kind: "select-model", candidateId: identifier(args.candidateId, bindingId) };
    case "answer-approval": {
      const { decision } = args;
      if (decision !== "allow" && decision !== "deny") fail(400, "invalid-arguments", "Invalid live shell decision");
      return { id, kind: "answer-approval", approvalId: identifier(args.approvalId, uuid), decision };
    }
    default:
      fail(404, "not-found", "Route not found");
  }
}

const actionKeys: Record<string, string[]> = {
  message: ["text"], stop: ["turnId"], invoke: ["name"],
  "select-model": ["candidateId"], "answer-approval": ["approvalId", "decision"],
};

function commandCurrent(shell: LiveShell, command: LiveShellCommand): boolean {
  switch (command.kind) {
    case "message":
      return true; // The shell itself accepts or rejects message delivery.
    case "stop":
      return shell.turnId === command.turnId;
    case "invoke":
      return !shell.summary.busy && !!shell.context?.commands?.some(entry => entry.name === command.name);
    case "select-model":
      return !shell.summary.busy && !!shell.context?.model?.candidates.some(entry => entry.id === command.candidateId);
    case "answer-approval":
      return shell.context?.approval?.id === command.approvalId && shell.context.approval.canAnswer;
  }
}

function discardPending(shell: LiveShell, pending: Pending): void {
  pending.operation.delivery.status = pending.operation.offered ? "unconfirmed" : "rejected";
  delete shell.pending;
}

export function createLiveShells(
  ports: Pick<RemotePorts, "store" | "authorityValid">,
  online: (id: string) => boolean,
) {
  const shells = new Map<string, LiveShell>();

  function visible(shell: LiveShell, projectId: string): boolean {
    if (shell.projectId !== projectId || !online(shell.machineId)) return false;
    const machine = ports.store.remote.get<MachineRecord>("remote_machine", shell.machineId);
    return !!machine && !machine.revoked && machine.projectIds.includes(projectId);
  }
  function expire() {
    const now = Date.now();
    for (const [id, shell] of shells) {
      if (now - shell.heartbeatAt >= limits.heartbeatMs) {
        shells.delete(id);
        continue;
      }
      if (shell.lease && shell.lease.expiresAt <= now) delete shell.lease;
      const pending = shell.pending;
      if (pending && (pending.expiresAt <= now || shell.lease?.generation !== pending.leaseGeneration ||
          !ports.authorityValid(pending.authority, shell.projectId))) {
        discardPending(shell, pending);
      }
    }
  }

  function checkoutShared(machineId: string, projectId: string, checkoutId: string): boolean {
    expire();
    return [...shells.values()].some(shell => shell.machineId === machineId &&
      shell.projectId === projectId && shell.summary.checkoutId === checkoutId);
  }

  function forMachine(machine: MachineRecord, shellId: string, method: string, input: unknown): LiveShellReply {
    expire();
    identifier(shellId, uuid);
    let shell = shells.get(shellId);
    if (shell && shell.machineId !== machine.machineId) fail(404, "not-found", "Live shell not found");
    if (method === "DELETE") {
      shells.delete(shellId);
      return { command: null };
    }
    if (method !== "POST") fail(404, "not-found", "Route not found");
    const update = parseUpdate(input);
    const inventory = ports.store.remote.get<FrameOf<"inventory">["payload"]>("remote_inventory", machine.machineId);
    if (!machine.projectIds.includes(update.projectId)) {
      fail(403, "scope-denied", "Live shell requires an enrolled machine and a mapped checkout");
    }
    if (!online(machine.machineId) || machine.inventoryEpoch !== machine.epoch ||
        !inventory || inventory.inventoryVersion !== machine.inventoryVersion) {
      fail(409, "machine-offline", "Wait for the machine inventory to reconnect");
    }
    const checkout = inventory.checkouts.find(item => item.projectId === update.projectId && item.checkoutId === update.checkoutId);
    if (!checkout) {
      fail(403, "scope-denied", "Live shell requires an enrolled machine and a mapped checkout");
    }
    if (shell && (shell.projectId !== update.projectId || shell.summary.checkoutId !== update.checkoutId)) {
      fail(409, "payload-conflict", "Live shell cannot change its project or checkout");
    }
    const summary: LiveShellSummary = {
      id: shellId, machineName: machine.displayName, checkoutId: update.checkoutId,
      title: update.title, busy: update.busy, stopTurnId: update.turnId ?? null,
    };
    if (!shell) {
      if (checkout.busy || checkoutShared(machine.machineId, update.projectId, update.checkoutId) ||
          ports.store.remote.all<SessionRow>("remote_session", { machineId: machine.machineId, projectId: update.projectId })
            .some(row => row.record.checkoutId === update.checkoutId &&
              (row.record.state !== "closed" || row.resumingOperationId))) {
        fail(409, "machine-busy", "A session already uses this checkout");
      }
      if (shells.size >= limits.sessions) fail(429, "quota-exceeded", "Too many shared shells");
      shell = { summary, projectId: update.projectId, machineId: machine.machineId,
        heartbeatAt: Date.now(), turnId: update.turnId, context: update.context,
        messages: [], operations: new Map(), outputOperations: [] };
      shells.set(shellId, shell);
    }
    shell.summary = summary;
    shell.turnId = update.turnId;
    shell.context = update.context;
    shell.heartbeatAt = Date.now();
    if (update.messages) shell.messages = update.messages;
    if (update.ack) {
      const operation = shell.operations.get(update.ack.id);
      if (operation?.offered && (operation.delivery.status === "pending" || operation.delivery.status === "unconfirmed")) {
        operation.delivery.status = update.ack.status;
        if (operation.delivery.kind === "invoke" && update.ack.output !== undefined) {
          operation.delivery.output = update.ack.output;
          shell.outputOperations.push(operation);
          if (shell.outputOperations.length > limits.outputCount) {
            const oldest = shell.outputOperations.shift();
            if (oldest) delete oldest.delivery.output;
          }
        }
      }
      if (shell.pending?.command.id === update.ack.id) delete shell.pending;
    }
    const pending = shell.pending;
    if (!pending) return { command: null };
    if (!commandCurrent(shell, pending.command)) {
      discardPending(shell, pending);
      return { command: null };
    }
    pending.operation.offered = true;
    return { command: pending.command };
  }

  function read(projectId: string, shellId: string | undefined, auth: HumanAuthority, operationId: string | null): { shells: LiveShellSummary[] } | LiveShellDetail {
    scoped(auth, projectId, ports.store.load());
    expire();
    if (!shellId) return { shells: [...shells.values()].filter(shell => visible(shell, projectId)).map(shell => shell.summary) };
    const shell = shells.get(shellId);
    if (!shell || !visible(shell, projectId)) fail(404, "not-found", "Live shell not found");
    const actor = actorKey(auth);
    const operation = operationId
      ? shell.operations.get(identifier(operationId, operationIdPattern))
      : [...shell.operations.values()].reverse().find(operation => operation.actor === actor);
    const delivery = operation?.actor === actor ? operation.delivery : null;
    return {
      shell: shell.summary, messages: shell.messages, controllerHeld: !!shell.lease, delivery,
      ...(shell.context === undefined ? {} : { context: shell.context }),
    };
  }

  function mutate(projectId: string, shellId: string, action: string, auth: HumanAuthority, key: string, input: unknown) {
    operator(auth);
    scoped(auth, projectId, ports.store.load());
    expire();
    const shell = shells.get(shellId);
    if (!shell || !visible(shell, projectId)) fail(404, "not-found", "Live shell not found");
    const args = record(input, ["clientId", ...(Object.hasOwn(actionKeys, action) ? actionKeys[action]! : [])]);
    const clientId = identifier(args.clientId, uuid);
    const actor = actorKey(auth);
    const lease = shell.lease;
    const ownLease = lease?.actor === actor && lease.clientId === clientId ? lease : undefined;
    if (action === "claim" || action === "renew") {
      if (action === "renew" && !ownLease) fail(409, "controller-expired", "Live shell controller expired");
      if (shell.lease && !ownLease) fail(409, "controller-conflict", "Another client controls this shell");
      shell.lease = { generation: ownLease?.generation ?? {}, actor, clientId, expiresAt: Date.now() + limits.controlMs };
      return { ok: true };
    }
    if (action === "release") {
      if (ownLease) delete shell.lease;
      expire();
      return { ok: true };
    }
    const operationId = sha256(JSON.stringify([actor, projectId, shellId, action, key]));
    const command = parseCommand(action, args, operationId);
    const digest = sha256(JSON.stringify([clientId, command]));
    const previous = shell.operations.get(operationId);
    if (previous) {
      if (previous.digest !== digest) fail(409, "payload-conflict", "Live shell operation changed");
      return { operationId };
    }
    if (!ownLease) fail(409, "controller-conflict", "Current live shell controller required");
    if (shell.pending) fail(409, "session-busy", "The shell has not confirmed the previous command");
    if (shell.operations.size >= limits.operations) fail(429, "quota-exceeded", "Share the shell again to accept more commands");
    if (!commandCurrent(shell, command)) fail(409, "stale-reference", "The requested shell action is no longer available");
    const operation: Operation = { actor, digest, delivery: { id: operationId, kind: command.kind, status: "pending" }, offered: false };
    shell.operations.set(operationId, operation);
    shell.pending = {
      command, authority: auth, leaseGeneration: ownLease.generation, operation,
      expiresAt: Date.now() + limits.deliveryMs,
    };
    return { operationId };
  }

  return { forMachine, read, mutate, expire, checkoutShared, close: () => shells.clear() };
}
