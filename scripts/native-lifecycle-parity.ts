/** Bridge-hosted lifecycle parity for scripts/verify-native-coverage.ts. Runs only inside its isolated harness child.
 * The machine bridge applies a lifecycle command only when Hub delivers it, so every path of every variant gets its own real
 * enrolled machine: a real MachineBridge over loopback Hub v2, hosting native sessions whose runtime is the harness's production
 * assembly. Its profile is the shipped production machine profile (resolveProductionMachineProfile) plus the MCP and bus services the
 * run binds locally so their variants can execute; each machine checks that this is its ONLY difference from the production profile.
 * The terminal path parses its line with the real terminal adapter over a Hub client; the headless path sends the typed
 * request to Hub directly. Hub first answers pending or queued, so both outcomes are read from the final operation receipt.
 */
import { randomUUID } from "node:crypto";
import { copyFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest, validateControl, type Control, type ProtocolResult } from "../src/remote-control/protocol";
import { MachineBridge } from "../src/lib/hub-machine/bridge";
import { enrollMachine } from "../src/lib/hub-machine/client";
import { allowCheckout, hubIdentity, loadEnrollment, machineStateDir, saveEnrollment } from "../src/lib/hub-machine/config";
import { MachineError } from "../src/lib/hub-machine/errors";
import { MachineLedger } from "../src/lib/hub-machine/ledger";
import { resolveProductionMachineProfile } from "../src/lib/hub-machine/production";
import { saveShellConfig } from "../src/lib/shell-config";
import { createTerminalSessionAdapter, type TerminalSessionReads } from "../src/session/commands/terminal-adapter";
import type { NativeNormalizedOutcome } from "../src/session/commands/coverage";
import type { SessionLifecyclePort } from "../src/session/host-lifecycle";
import type { SessionHostPort, SessionHostReceipt } from "../src/session/host-types";
import type { NativeSessionRuntime } from "../src/session/native-runtime";
import type { ParityCase, ParityOutcome } from "./verify-native-coverage";

type Json = Control["BoundedJson"];
type Args = { [key: string]: Json };
type Slots = Readonly<Record<string, string>>;
/** The fixture machine maps two committed checkouts: the session's own and the separate clean target a fork needs. */
const CHECKOUTS = ["checkout", "checkout-2"] as const;
const PROFILE = "fixture";
/** The shipped remote profile each machine's own profile is checked against. */
const PRODUCTION_PROFILE = "remote-read-only";
/**
 * No remote production profile binds MCP or bus services today, so their catalogue entries are setup-required there
 * (tasks-integrations.ts capability: availability follows the live service port), while the run subject binds both.
 */
const LOCALLY_BOUND_SERVICE = /^(?:mcp|bus)(?:\.|$)/;
const WORK: Control["FlowAssociation"] = { mode: "ad-hoc", profileConsentVersion: 1 };
/** How long (x 20 ms) a delivered operation may stay pending before the outcome is recorded as unsettled. */
const FINAL_RECEIPT_POLLS = 1500;

export class LifecycleParityError extends Error { constructor(readonly code: string, detail = "") { super(detail.length === 0 ? code : `${code}: ${detail}`); this.name = "LifecycleParityError"; } }
/** Hub refused the request outright, or the machine never settled it: an observed non-application, never a receipt. */
class HubNonApplication extends Error { constructor(readonly status: "hub-refused" | "unsettled", readonly code: string) { super(`${status}: ${code}`); this.name = "HubNonApplication"; } }
type Delivery = { kind: "receipt"; receipt: SessionHostReceipt } | { kind: "refused"; code: string } | { kind: "unsettled" };

/**
 * A machine-hosted session always carries the bridge's lifecycle port, so the parity subject advertises lifecycle. A host the Hub
 * did not deliver a lifecycle command to has no authority for it, exactly as the bridge's own port refuses an undelivered request
 * (`authorization-not-applied`). Lifecycle variants never execute on such a host: they run bridge-hosted below.
 */
export const hubDeliveryOnlyLifecycle: SessionLifecyclePort = {
  apply: async () => ({ ok: false, error: { code: "authorization-not-applied", message: "authorization-not-applied" } }),
  list: async () => ({ ok: false, error: { code: "authorization-not-applied", message: "authorization-not-applied" } }),
  open: async () => ({ ok: false, error: { code: "authorization-not-applied", message: "authorization-not-applied" } }),
};

export interface LifecycleParityContext {
  origin: string; cookie: string; projectId: string; root: string;
  /** The subject catalogue every host of this run computes; each fixture machine advertises exactly it. */
  catalogue: Control["CommandCatalogue"]; digest: string; availability: Control["RoutingAvailability"];
  /** The run's production runtime assembly for one mapped checkout. */
  assemble(cwd: string, sessionId: string): Promise<ProtocolResult<NativeSessionRuntime>>;
  /** The run's isolated keryx config dir holding the loopback provider registry (`llm-providers.json`) every machine copies. */
  configDir: string;
  /** The loopback provider and model each machine saves as its shell selection, the local setup the production profile reads. */
  providerId: string; modelId: string;
  /** The same committed, Keryx-initialized fixture checkout every non-bridge host gets. */
  checkout(name: string): Promise<string>;
  outcome(receipt: unknown, replace: (text: string) => string): NativeNormalizedOutcome;
  bind(value: Json, slots: Slots): Json;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function control<K extends keyof Control>(name: K, value: unknown): Control[K] {
  const checked = validateControl(name, value); if (!checked.ok) throw new LifecycleParityError("invalid-hub-body", `${name}: ${JSON.stringify(value).slice(0, 400)}`); return checked.value;
}
function receiptOf(value: unknown): SessionHostReceipt | undefined {
  for (const name of ["CommandOutcome", "SessionOperationReceipt", "ConfigReceipt", "TurnReceipt"] as const) { const checked = validateControl(name, value); if (checked.ok) return checked.value; }
  return undefined;
}
const errorCode = (body: unknown): string => record(body) && record(body.error) && typeof body.error.code === "string" ? body.error.code : "invalid-hub-error";
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
  let last: T | undefined;
  for (let attempt = 0; attempt < 750; attempt++) { last = await read(); if (done(last)) return last; await Bun.sleep(20); }
  throw new LifecycleParityError("fixture-timeout", `${label}: ${JSON.stringify(last).slice(0, 600)}`);
}

/** Operator HTTP against the fixture Hub, the way the Hub web client calls it. */
function hubClient(context: LifecycleParityContext) {
  const call = async (path: string, method = "GET", body?: unknown, key?: string): Promise<{ status: number; body: unknown }> => {
    const headers = new Headers({ Origin: context.origin, Cookie: context.cookie });
    if (method !== "GET") headers.set("Idempotency-Key", key ?? randomUUID());
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(`${context.origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  };
  /** Fixture setup only: anything but success fails the harness, it is never an outcome. */
  const ok = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    const response = await call(path, method, body);
    if (response.status !== 200) throw new LifecycleParityError("fixture-hub-refused", `${method} ${path} -> ${response.status} ${JSON.stringify(response.body).slice(0, 400)}`);
    return response.body;
  };
  return { call, ok };
}
type HubClient = ReturnType<typeof hubClient>;

/** One Hub session as an operator client sees it. `deliver` returns the machine's final receipt, or the observed non-application. */
function hubSession(hub: HubClient, projectId: string, sessionId: string) {
  const path = `/hub/v2/projects/${projectId}/sessions/${sessionId}`;
  const read = async () => control("SessionRecord", await hub.ok(path));
  const catalogue = async () => control("CommandCatalogue", await hub.ok(`${path}/commands`));
  const queue = async () => control("QueuePage", await hub.ok(`${path}/queue`));
  const deliver = async (key: string, request: Control["CommandInvoke"]): Promise<Delivery> => {
    const posted = await hub.call(`${path}/commands/invoke`, "POST", request, key);
    if (posted.status !== 200) return { kind: "refused", code: errorCode(posted.body) };
    let receipt = receiptOf(posted.body);
    if (receipt === undefined) throw new LifecycleParityError("invalid-hub-receipt", JSON.stringify(posted.body).slice(0, 400));
    // Hub's own acknowledgement is pending (an identity operation) or queued (a delivered read); only the machine's receipt settles it.
    for (let attempt = 0; attempt < FINAL_RECEIPT_POLLS && (receipt.status === "pending" || receipt.status === "queued"); attempt++) {
      await Bun.sleep(20);
      const current = await hub.call(`${path}/operations/${receipt.operationId}`);
      if (current.status !== 200) return { kind: "refused", code: errorCode(current.body) };
      receipt = receiptOf(current.body);
      if (receipt === undefined) throw new LifecycleParityError("invalid-hub-receipt", JSON.stringify(current.body).slice(0, 400));
    }
    return receipt.status === "pending" || receipt.status === "queued" ? { kind: "unsettled" } : { kind: "receipt", receipt };
  };
  const claim = async (): Promise<Control["ControllerLease"]> => {
    const current = await read();
    const claimed = control("ControllerReceipt", await hub.ok(`${path}/controller/claim`, "POST", { expectedSessionVersion: current.version, expectedControllerVersion: current.controller?.version ?? 0, requestedLeaseSeconds: 60, mode: "claim" }));
    await until(read, (value) => value.controller?.controllerLeaseId === claimed.lease.controllerLeaseId && value.controller.state === "held", "controller claim");
    return claimed.lease;
  };
  /** The exact CommandInvoke a headless client sends against the session's current Hub record and catalogue. */
  const invoke = async (lease: Control["ControllerLease"], commandName: string, args: Args): Promise<Control["CommandInvoke"]> => {
    const current = await read(); const subject = await catalogue();
    return { expectedSessionVersion: current.version, controller: { controllerLeaseId: lease.controllerLeaseId, expectedControllerVersion: lease.version }, expectedConfigVersion: current.config.configVersion,
      catalogueDigest: subject.catalogueDigest, commandName, arguments: args, busyPolicy: "reject" };
  };
  return { sessionId, read, catalogue, queue, deliver, claim, invoke };
}
type HubSession = ReturnType<typeof hubSession>;

/**
 * The terminal adapter's host port backed by Hub: its typed request is delivered through Hub, and it reads the final receipt. A session
 * selection's pins come from the same Hub reads an operator client makes: the selected session's record and this machine's inventory.
 */
function terminalHost(session: HubSession, reads: TerminalSessionReads): Pick<SessionHostPort, "inspect" | "catalogue" | "apply" | "queue"> & TerminalSessionReads {
  return {
    inspect: () => session.read(), catalogue: () => session.catalogue(), queue: () => session.queue(), ...reads,
    async apply(operation) {
      if (operation.kind !== "command") throw new LifecycleParityError("terminal-operation-unsupported", operation.kind);
      const delivered = await session.deliver(operation.operationId, operation.association === undefined ? operation.request : { ...operation.request, association: operation.association });
      if (delivered.kind === "receipt") return delivered.receipt;
      throw new HubNonApplication(delivered.kind === "refused" ? "hub-refused" : "unsettled", delivered.kind === "refused" ? delivered.code : "no-final-receipt");
    },
  };
}

interface MachineInventory { inventoryVersion: number; checkouts: { checkoutId: string; headSha: string }[] }
function inventoryOf(body: unknown): MachineInventory | null {
  const inventory = record(body) ? body.inventory : undefined;
  if (!record(inventory) || typeof inventory.inventoryVersion !== "number" || !Array.isArray(inventory.checkouts)) return null;
  const checkouts = inventory.checkouts.filter(record).flatMap((row) => typeof row.checkoutId === "string" && typeof row.headSha === "string" ? [{ checkoutId: row.checkoutId, headSha: row.headSha }] : []);
  return { inventoryVersion: inventory.inventoryVersion, checkouts };
}

/**
 * A real enrolled machine: Hub pairing and enrollment, local checkout mappings and policy, a started bridge, one idle held session.
 * Hub rate-limits enrollment to 20 per minute per server, and each lifecycle variant enrolls two machines.
 */
async function enrolledMachine(context: LifecycleParityContext, hub: HubClient, name: string) {
  const cwds = await Promise.all(CHECKOUTS.map(async (checkoutId) => realpath(await context.checkout(`${name}-${checkoutId}`))));
  // Machine state refuses any symlinked path component, and the OS temp dir may sit behind one (macOS /tmp, /var).
  const configDir = join(await realpath(context.root), `machine-${name}`); const hubId = hubIdentity(context.origin);
  const pairing = await hub.ok("/hub/v2/machines/pairings", "POST", { displayName: `Lifecycle parity ${name}`, projectIds: [context.projectId] });
  if (!record(pairing) || typeof pairing.code !== "string") throw new LifecycleParityError("fixture-pairing-invalid");
  const ledger = new MachineLedger(join(machineStateDir(configDir, hubId), "control.sqlite")); const ledgerId = ledger.ledgerId; ledger.close();
  const enrolled = await enrollMachine(context.origin, { code: pairing.code, agentVersion: "native-parity", ledgerId });
  saveEnrollment(configDir, { hubUrl: context.origin, ...enrolled });
  CHECKOUTS.forEach((checkoutId, index) => allowCheckout(configDir, { projectId: context.projectId, checkoutId, cwd: cwds[index]!, profileId: PROFILE }));
  const enrollment = loadEnrollment(configDir); if (enrollment === null) throw new LifecycleParityError("fixture-enrollment-missing");
  // The operator's local setup the production profile reads: the saved shell selection and the provider registry it names.
  await copyFile(join(context.configDir, "llm-providers.json"), join(configDir, "llm-providers.json"));
  saveShellConfig({ provider: context.providerId, model: context.modelId }, configDir);
  const production = await resolveProductionMachineProfile({ ...enrollment.mappings[0]!, profileId: PRODUCTION_PROFILE }, { configDir, allowedCandidateIds: [canonicalDigest([context.providerId, context.modelId])] });
  if (!production.ok) throw new LifecycleParityError("production-profile-refused", production.error.code);
  // The catalogue and checkout-sync defects are fixed: the production profile now differs from the run subject only by the locally bound services.
  const differing = [...new Set([...production.value.catalogue.entries, ...context.catalogue.entries].map((entry) => entry.commandName))].filter((name) =>
    JSON.stringify(production.value.catalogue.entries.find((entry) => entry.commandName === name)) !== JSON.stringify(context.catalogue.entries.find((entry) => entry.commandName === name)));
  if (differing.some((name) => !LOCALLY_BOUND_SERVICE.test(name))) throw new LifecycleParityError("production-profile-drift", `the production profile differs from the run subject beyond MCP/bus in: ${differing.join(", ")}`);
  const candidates = context.availability.candidates.map((candidate) => candidate.candidateId);
  const policy: Control["LocalMachinePolicy"] = { version: 2, hubId, enabled: true, maxConcurrentRuns: 2, allowAdHocSessions: true, allowedCandidateIds: candidates,
    checkouts: enrollment.mappings.map((mapping, index) => ({ projectId: mapping.projectId, checkoutId: mapping.checkoutId, localBindingId: `binding-${index}`, path: mapping.cwd, profileIds: [PROFILE] })),
    profiles: [{ profileId: PROFILE, allowAdHocTurns: true, consentVersion: 1, allowedCandidateIds: candidates }] };
  const notices: string[] = [];
  const bridge = new MachineBridge({ configDir, enrollment, policy, onNotice: (code) => { notices.push(code); },
    // The harness's subject profile: the production runtime assembly, advertised with the exact catalogue its hosts compute.
    resolveProfile: async (mapping) => ({ ok: true, value: { profileId: PROFILE, policyDigest: context.digest, capabilityDigest: context.digest, catalogue: context.catalogue, routing: structuredClone(context.availability),
      async createRuntime(sessionId) { const assembled = await context.assemble(mapping.cwd, sessionId); return assembled.ok ? assembled : { ok: false, error: new MachineError(assembled.error.code) }; } } }) });
  await bridge.start();
  try {
    const machinePath = `/hub/v2/machines/${enrolled.machineId}`;
    const inventory = async () => { const value = inventoryOf(await hub.ok(machinePath)); if (value === null) throw new LifecycleParityError("fixture-inventory-missing", notices.join(",")); return value; };
    const ready = await until(async () => inventoryOf(await hub.ok(machinePath)), (value) => value !== null && value.checkouts.length === CHECKOUTS.length, `machine ${name} inventory (notices ${notices.join(",")})`);
    const head = ready?.checkouts.find((checkout) => checkout.checkoutId === "checkout")?.headSha;
    if (ready === null || head === undefined) throw new LifecycleParityError("fixture-inventory-missing", notices.join(","));
    const created = control("SessionOperationReceipt", await hub.ok(`/hub/v2/projects/${context.projectId}/sessions`, "POST", { machineId: enrolled.machineId, checkoutId: "checkout", agentProfileId: PROFILE,
      expectedInventoryVersion: ready.inventoryVersion, expectedHeadSha: head, capabilityDigest: context.digest, policyDigest: context.digest, title: "Parity" }));
    const session = hubSession(hub, context.projectId, created.sessionId);
    await until(session.read, (value) => value.state === "idle", `machine ${name} session (notices ${notices.join(",")})`);
    const lease = await session.claim();
    const replace = (text: string) => cwds.reduce((current, cwd) => current.replaceAll(cwd, "<checkout>"), text)
      .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>").replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<time>");
    return { session, lease, inventory, replace, notices, open: (sessionId: string) => hubSession(hub, context.projectId, sessionId), stop: () => bridge.stop() };
  } catch (cause) { await bridge.stop(); throw cause; }
}
type EnrolledMachine = Awaited<ReturnType<typeof enrolledMachine>>;
interface Prepared { session: HubSession; lease: Control["ControllerLease"]; slots: Record<string, string> }

/** Fixture state a variant selects, built only from typed requests Hub delivers. Never a parity outcome. */
async function prepare(machine: EnrolledMachine, scenario: ParityCase["scenario"]): Promise<Prepared> {
  if (scenario === "bridge-previous-session") {
    // A real `/new` through Hub: the first session closes with its native history, and the operator continues in its successor.
    const previous = machine.session;
    const opened = await previous.deliver(randomUUID(), await previous.invoke(machine.lease, "new", {}));
    if (opened.kind !== "receipt" || opened.receipt.status !== "applied" || !("kind" in opened.receipt) || opened.receipt.kind !== "create-session") throw new LifecycleParityError("fixture-new-not-applied", JSON.stringify(opened).slice(0, 600));
    const session = machine.open(opened.receipt.sessionId);
    await until(session.read, (value) => value.state === "idle", "successor session");
    const lease = await session.claim();
    const prior = await until(previous.read, (value) => value.state === "closed", "previous session closed");
    if (prior.controller === null) throw new LifecycleParityError("fixture-previous-controller-missing");
    return { session, lease, slots: { previousSession: prior.sessionId, previousVersion: String(prior.version), previousLease: prior.controller.controllerLeaseId, previousLeaseVersion: String(prior.controller.version),
      previousHistoryVersion: String(prior.historyVersion), previousBaseline: prior.workspaceBaseline } };
  }
  if (scenario === "bridge-fork-target") {
    const current = await machine.session.read(); const inventory = await machine.inventory();
    const target = inventory.checkouts.find((checkout) => checkout.checkoutId === "checkout-2"); if (target === undefined) throw new LifecycleParityError("fixture-fork-target-missing");
    return { session: machine.session, lease: machine.lease, slots: { historyCursor: String(current.historyCursor), historyVersion: String(current.historyVersion), inventoryVersion: String(inventory.inventoryVersion), forkHead: target.headSha } };
  }
  return { session: machine.session, lease: machine.lease, slots: {} };
}

export function createLifecycleParity(context: LifecycleParityContext) {
  const hub = hubClient(context);
  let serial = 0;
  const settle = (pending: Promise<unknown>, replace: (text: string) => string): Promise<NativeNormalizedOutcome> => pending.then((receipt) => context.outcome(receipt, replace), (cause: unknown) => {
    if (cause instanceof HubNonApplication) return { status: cause.status, errorCode: cause.code, confirmation: false, resultDigest: null };
    throw cause;
  });
  return {
    async run(item: { variantId: string; handlerName: string | null; case: ParityCase }): Promise<ParityOutcome> {
      const n = ++serial;
      const [local, headless] = await Promise.all([enrolledMachine(context, hub, `l${n}`), enrolledMachine(context, hub, `h${n}`)]);
      try {
        for (const machine of [local, headless]) {
          const advertised = await machine.session.catalogue();
          if (advertised.catalogueDigest !== context.catalogue.catalogueDigest) throw new LifecycleParityError("parity-subject-catalogue-changed", `${advertised.catalogueDigest} != ${context.catalogue.catalogueDigest}`);
        }
        const [localState, headlessState] = await Promise.all([prepare(local, item.case.scenario), prepare(headless, item.case.scenario)]);
        const terminal = createTerminalSessionAdapter(terminalHost(localState.session, { readSession: (sessionId) => local.open(sessionId).read(), readInventory: () => local.inventory() }),
          { actorId: "human", controllerLeaseId: localState.lease.controllerLeaseId, controllerVersion: localState.lease.version, work: WORK });
        for (const earlier of item.case.before ?? []) await terminal.execute(String(context.bind(earlier, localState.slots)));
        const typed = item.case.arguments === null || item.handlerName === null ? null : context.bind(item.case.arguments, headlessState.slots) as Args;
        // Both paths start from the same state at the same moment, each on its own machine.
        const [localOutcome, headlessOutcome] = await Promise.all([
          settle(terminal.execute(String(context.bind(item.case.line, localState.slots))), local.replace),
          typed === null || item.handlerName === null ? Promise.resolve(null) : settle((async () => {
            const delivered = await headlessState.session.deliver(randomUUID(), await headlessState.session.invoke(headlessState.lease, item.handlerName!, typed));
            if (delivered.kind === "receipt") return delivered.receipt;
            throw new HubNonApplication(delivered.kind === "refused" ? "hub-refused" : "unsettled", delivered.kind === "refused" ? delivered.code : "no-final-receipt");
          })(), headless.replace),
        ]);
        return { variantId: item.variantId, handlerName: item.handlerName, local: localOutcome, headless: headlessOutcome };
      } finally { await Promise.all([local.stop(), headless.stop()]); }
    },
  };
}
