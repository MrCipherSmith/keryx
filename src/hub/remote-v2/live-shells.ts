import {
  liveShellLimits as limits,
  type LiveShellCommand,
  type LiveShellDelivery,
  type LiveShellDetail,
  type LiveShellMessage,
  type LiveShellReply,
  type LiveShellSummary,
  type LiveShellUpdate,
} from "../../remote-control/live-shell";
import type { FrameOf } from "../../remote-control/protocol";
import { redactSensitiveText } from "../../security/redact";
import { fail, sha256 } from "../domain";
import { operator, scoped } from "./guards";
import type { RemotePorts } from "./index";
import type { HumanAuthority, MachineRecord, SessionRow } from "./model";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const operationIdPattern = /^[0-9a-f]{64}$/;
const bindingId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
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
const identifier = (value: unknown, format: RegExp): string => {
  if (typeof value !== "string" || !format.test(value)) {
    fail(400, "invalid-arguments", "Invalid live shell identifier");
  }
  return value;
};

function parseUpdate(value: unknown): LiveShellUpdate {
  const raw = record(value, ["projectId", "checkoutId", "title", "busy", "turnId", "messages", "ack"]);
  const projectId = identifier(raw.projectId, bindingId);
  const checkoutId = identifier(raw.checkoutId, bindingId);
  const title = redactSensitiveText(text(raw.title, limits.titleBytes)).trim();
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
      const safe = redactSensitiveText(text(message.text, limits.messageBytes));
      bytes += Buffer.byteLength(safe);
      if (bytes > limits.historyBytes) fail(413, "quota-exceeded", "Live shell history exceeds quota");
      return { role: message.role, text: safe };
    });
  }
  if (raw.ack !== undefined) {
    const ack = record(raw.ack, ["id", "status"]);
    if (ack.status !== "applied" && ack.status !== "rejected") {
      fail(400, "invalid-arguments", "Invalid live shell acknowledgement");
    }
    update.ack = { id: identifier(ack.id, operationIdPattern), status: ack.status };
  }
  return update;
}

type Lease = { actor: string; clientId: string; expiresAt: number };
type Operation = { actor: string; digest: string; delivery: LiveShellDelivery; offered: boolean };
type Pending = { command: LiveShellCommand; authority: HumanAuthority; operation: Operation; expiresAt: number };
type LiveShell = {
  summary: LiveShellSummary;
  projectId: string;
  machineId: string;
  heartbeatAt: number;
  turnId: string | undefined;
  messages: LiveShellMessage[];
  lease?: Lease;
  operations: Map<string, Operation>;
  pending?: Pending;
};
const actorKey = (auth: HumanAuthority) => sha256(JSON.stringify([auth.actor.id, auth.sessionDigest]));

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
      if (pending && (pending.expiresAt <= now || !shell.lease ||
          !ports.authorityValid(pending.authority, shell.projectId))) {
        pending.operation.delivery.status = pending.operation.offered ? "unconfirmed" : "rejected";
        delete shell.pending;
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
        heartbeatAt: Date.now(), turnId: update.turnId, messages: [], operations: new Map() };
      shells.set(shellId, shell);
    }
    shell.summary = summary;
    shell.turnId = update.turnId;
    shell.heartbeatAt = Date.now();
    if (update.messages) shell.messages = update.messages;
    if (update.ack) {
      const operation = shell.operations.get(update.ack.id);
      if (operation?.offered && (operation.delivery.status === "pending" || operation.delivery.status === "unconfirmed")) {
        operation.delivery.status = update.ack.status;
      }
      if (shell.pending?.command.id === update.ack.id) delete shell.pending;
    }
    const pending = shell.pending;
    if (!pending) return { command: null };
    if (pending.command.kind === "stop" && pending.command.turnId !== shell.turnId) {
      pending.operation.delivery.status = pending.operation.offered ? "unconfirmed" : "rejected";
      delete shell.pending;
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
    return { shell: shell.summary, messages: shell.messages, controllerHeld: !!shell.lease, delivery };
  }

  function mutate(projectId: string, shellId: string, action: string, auth: HumanAuthority, key: string, input: unknown) {
    operator(auth);
    scoped(auth, projectId, ports.store.load());
    expire();
    const shell = shells.get(shellId);
    if (!shell || !visible(shell, projectId)) fail(404, "not-found", "Live shell not found");
    const args = record(input, action === "message" ? ["clientId", "text"] : action === "stop" ? ["clientId", "turnId"] : ["clientId"]);
    const clientId = identifier(args.clientId, uuid);
    const actor = actorKey(auth);
    const ownsLease = shell.lease?.actor === actor && shell.lease.clientId === clientId;
    if (action === "claim" || action === "renew") {
      if (action === "renew" && !ownsLease) fail(409, "controller-expired", "Live shell controller expired");
      if (shell.lease && !ownsLease) fail(409, "controller-conflict", "Another client controls this shell");
      shell.lease = { actor, clientId, expiresAt: Date.now() + limits.controlMs };
      return { ok: true };
    }
    if (action === "release") {
      if (ownsLease) delete shell.lease;
      expire();
      return { ok: true };
    }
    if (action !== "message" && action !== "stop") fail(404, "not-found", "Route not found");
    const message = action === "message" ? text(args.text, limits.messageBytes) : undefined;
    const turnId = action === "stop" ? identifier(args.turnId, uuid) : undefined;
    if (message !== undefined && !message.trim()) fail(400, "invalid-arguments", "Enter a message");
    const operationId = sha256(JSON.stringify([actor, projectId, shellId, action, key]));
    const digest = sha256(JSON.stringify([clientId, message, turnId]));
    const previous = shell.operations.get(operationId);
    if (previous) {
      if (previous.digest !== digest) fail(409, "payload-conflict", "Live shell operation changed");
      return { operationId };
    }
    if (!ownsLease) fail(409, "controller-conflict", "Current live shell controller required");
    if (shell.pending) fail(409, "session-busy", "The shell has not confirmed the previous command");
    if (shell.operations.size >= limits.operations) fail(429, "quota-exceeded", "Share the shell again to accept more commands");
    let command: LiveShellCommand;
    if (action === "message") command = { id: operationId, kind: "message", text: message! };
    else {
      if (!turnId || shell.turnId !== turnId) fail(409, "stale-reference", "The current shell turn changed");
      command = { id: operationId, kind: "stop", turnId };
    }
    const operation: Operation = { actor, digest, delivery: { id: operationId, kind: command.kind, status: "pending" }, offered: false };
    shell.operations.set(operationId, operation);
    shell.pending = { command, authority: auth, operation, expiresAt: Date.now() + limits.deliveryMs };
    return { operationId };
  }

  return { forMachine, read, mutate, expire, checkoutShared, close: () => shells.clear() };
}
