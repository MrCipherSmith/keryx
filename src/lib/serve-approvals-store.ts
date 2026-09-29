// The durable approval store (flow 369 / R4d).
//
// An approval is a question a running turn asked and a person, somewhere else,
// answers. Everything about it must survive the process, and three properties
// carry the safety argument, so each one is a file rather than a field:
//
//   approvals/<id>.json              the request. Written once, atomically.
//   approvals/<id>.resolution.json   the answer. Created O_EXCL, so exactly one
//                                    writer wins across concurrent POSTs and
//                                    across processes (the local CLI answers too).
//   approvals/<id>.consumed          the execution. Created O_EXCL, so a call runs
//                                    at most once per approval, restart included.
//   approvals/events.jsonl           append-only evidence, one line per transition.
//
// The state of an approval is DERIVED: the resolution file's state, or `pending`
// when there is none. There is no mutable status field to disagree with the files.
//
// What is stored is a fingerprint of the call, never its arguments. A caller who
// can read this directory learns which tool asked and how risky it is, and cannot
// reconstruct the command. The fingerprint and floors stay out of the public
// projection (`toPublicApproval`), which is the shape `pending-approval.schema.json`
// closes.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  appendOwnerOnlyLine,
  type ConfigReadFailure,
  createOwnerOnlyFileExclusive,
  ensureKeryxSubdir,
  keryxConfigDir,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "./config-dir";

export const APPROVAL_SCHEMA_VERSION = "1.0.0";

export type ApprovalState = "pending" | "allowed" | "denied" | "expired" | "undeliverable";
export type ResolvedState = Exclude<ApprovalState, "pending">;

const SUMMARY_MAX = 500;
const SCOPE_MAX = 300;
const CONSEQUENCE_MAX = 300;
const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isApprovalId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export interface NewApproval {
  approvalId: string;
  turnId: string;
  sessionId: string;
  summary: string;
  scope: string;
  consequence: string;
  expiresAt: Date;
  correlationId: string;
  /** sha256 of the canonical call. Compared, never displayed. */
  callFingerprint: string;
  /** Names of the floors this call sits under; an allow never lifts them. */
  floors: readonly string[];
}

export interface ApprovalView {
  approvalId: string;
  turnId: string;
  sessionId: string;
  summary: string;
  scope: string;
  consequence: string;
  createdAt: string;
  expiresAt: string;
  correlationId: string;
  callFingerprint: string;
  floors: string[];
  state: ApprovalState;
  resolvedAt?: string;
  answeredBy?: string;
  reason?: string;
  consumed: boolean;
}

/** The shape `pending-approval.schema.json` closes. */
export interface PublicApproval {
  schemaVersion: typeof APPROVAL_SCHEMA_VERSION;
  approvalId: string;
  turnId: string;
  sessionId: string;
  summary: string;
  scope: string;
  consequence: string;
  createdAt: string;
  expiresAt: string;
  state: ApprovalState;
  correlationId: string;
  resolvedAt?: string;
  answeredBy?: string;
}

export type ApprovalReadFailure = ConfigReadFailure | "not-an-approval-id" | "malformed";
export type ApprovalReadResult = { ok: true; value: ApprovalView } | { ok: false; reason: ApprovalReadFailure };

export interface ApprovalEvidence {
  at: string;
  kind: "created" | "resolved" | "consumed" | "abandoned";
  approvalId: string;
  turnId: string;
  state?: ApprovalState;
  reason?: string;
  answeredBy?: string;
}

interface StoredRequest {
  schemaVersion: string;
  approvalId: string;
  turnId: string;
  sessionId: string;
  summary: string;
  scope: string;
  consequence: string;
  createdAt: string;
  expiresAt: string;
  correlationId: string;
  callFingerprint: string;
  floors: string[];
}

interface StoredResolution {
  state: ResolvedState;
  resolvedAt: string;
  answeredBy?: string;
  reason?: string;
}

function root(dir?: string): string {
  return path.join(keryxConfigDir(dir), "approvals");
}

function requestFile(id: string, dir?: string): string {
  return path.join(root(dir), `${id}.json`);
}

function resolutionFile(id: string, dir?: string): string {
  return path.join(root(dir), `${id}.resolution.json`);
}

function consumedFile(id: string, dir?: string): string {
  return path.join(root(dir), `${id}.consumed`);
}

function ledgerFile(dir?: string): string {
  return path.join(root(dir), "events.jsonl");
}

function bound(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function appendEvidence(event: ApprovalEvidence, dir?: string): void {
  ensureKeryxSubdir(["approvals"], dir);
  appendOwnerOnlyLine(ledgerFile(dir), JSON.stringify(event));
}

/** Create the record for a question that is about to be asked. Throws when the ledger cannot be appended. */
export function createApproval(input: NewApproval, dir?: string, now: Date = new Date()): ApprovalView {
  if (!isApprovalId(input.approvalId)) {
    throw new Error("approvalId is not an approval id");
  }
  ensureKeryxSubdir(["approvals"], dir);
  const stored: StoredRequest = {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: input.approvalId,
    turnId: input.turnId,
    sessionId: input.sessionId,
    summary: bound(input.summary, SUMMARY_MAX),
    scope: bound(input.scope, SCOPE_MAX),
    consequence: bound(input.consequence, CONSEQUENCE_MAX),
    createdAt: now.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    correlationId: input.correlationId,
    callFingerprint: input.callFingerprint,
    floors: [...input.floors],
  };
  writeOwnerOnlyFileAtomic(requestFile(input.approvalId, dir), `${JSON.stringify(stored, null, 2)}\n`);
  appendEvidence({ at: stored.createdAt, kind: "created", approvalId: stored.approvalId, turnId: stored.turnId, state: "pending" }, dir);
  return toView(stored, undefined, false);
}

function toView(request: StoredRequest, resolution: StoredResolution | undefined, consumed: boolean): ApprovalView {
  return {
    approvalId: request.approvalId,
    turnId: request.turnId,
    sessionId: request.sessionId,
    summary: request.summary,
    scope: request.scope,
    consequence: request.consequence,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
    correlationId: request.correlationId,
    callFingerprint: request.callFingerprint,
    floors: request.floors,
    state: resolution?.state ?? "pending",
    ...(resolution !== undefined ? { resolvedAt: resolution.resolvedAt } : {}),
    ...(resolution?.answeredBy !== undefined ? { answeredBy: resolution.answeredBy } : {}),
    ...(resolution?.reason !== undefined ? { reason: resolution.reason } : {}),
    consumed,
  };
}

function parseRequest(text: string, id: string): StoredRequest | undefined {
  try {
    const value = JSON.parse(text) as Partial<StoredRequest>;
    if (
      value.approvalId !== id ||
      typeof value.turnId !== "string" ||
      typeof value.sessionId !== "string" ||
      typeof value.summary !== "string" ||
      typeof value.scope !== "string" ||
      typeof value.consequence !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.expiresAt !== "string" ||
      typeof value.correlationId !== "string" ||
      typeof value.callFingerprint !== "string" ||
      !Array.isArray(value.floors)
    ) {
      return undefined;
    }
    return value as StoredRequest;
  } catch {
    return undefined;
  }
}

function parseResolution(text: string): StoredResolution | undefined {
  try {
    const value = JSON.parse(text) as Partial<StoredResolution>;
    const states: readonly string[] = ["allowed", "denied", "expired", "undeliverable"];
    if (typeof value.state !== "string" || !states.includes(value.state) || typeof value.resolvedAt !== "string") {
      return undefined;
    }
    return value as StoredResolution;
  } catch {
    return undefined;
  }
}

function readRaw(id: string, dir?: string): { ok: true; value: ApprovalView } | { ok: false; reason: ApprovalReadFailure } {
  if (!isApprovalId(id)) {
    return { ok: false, reason: "not-an-approval-id" };
  }
  const read = readConfigFile(requestFile(id, dir));
  if (!read.ok) {
    return { ok: false, reason: read.reason };
  }
  const request = parseRequest(read.text, id);
  if (request === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const resolutionRead = readConfigFile(resolutionFile(id, dir));
  let resolution: StoredResolution | undefined;
  if (resolutionRead.ok) {
    resolution = parseResolution(resolutionRead.text);
    if (resolution === undefined) {
      // A resolution file that exists and cannot be read is closed, not open: an
      // unreadable answer must never leave the question answerable a second time.
      resolution = { state: "denied", resolvedAt: request.createdAt, reason: "resolution-unreadable" };
    }
  }
  return { ok: true, value: toView(request, resolution, existsSync(consumedFile(id, dir))) };
}

/**
 * Read one approval. Given `now`, a pending record past its expiry is first
 * resolved as `expired`, so a reader never sees a stale `pending`.
 */
export function readApproval(id: string, dir?: string, now?: Date): ApprovalReadResult {
  const read = readRaw(id, dir);
  if (!read.ok || now === undefined) {
    return read;
  }
  if (read.value.state === "pending" && now.getTime() >= Date.parse(read.value.expiresAt)) {
    return { ok: true, value: resolveApproval(id, { state: "expired", reason: "expired" }, dir, now).view };
  }
  return read;
}

export interface Resolution {
  state: ResolvedState;
  answeredBy?: string;
  reason?: string;
}

/**
 * Resolve an approval exactly once. `applied` is true only for the call whose
 * exclusive create won; every other caller gets the winner's view back.
 */
export function resolveApproval(id: string, resolution: Resolution, dir?: string, now: Date = new Date()): { applied: boolean; view: ApprovalView } {
  const before = readRaw(id, dir);
  if (!before.ok) {
    throw new Error(`approval ${id} cannot be resolved: ${before.reason}`);
  }
  const stored: StoredResolution = {
    state: resolution.state,
    resolvedAt: now.toISOString(),
    ...(resolution.answeredBy !== undefined ? { answeredBy: resolution.answeredBy } : {}),
    ...(resolution.reason !== undefined ? { reason: resolution.reason } : {}),
  };
  const applied = createOwnerOnlyFileExclusive(resolutionFile(id, dir), `${JSON.stringify(stored, null, 2)}\n`);
  if (applied) {
    appendEvidence(
      {
        at: stored.resolvedAt,
        kind: "resolved",
        approvalId: id,
        turnId: before.value.turnId,
        state: stored.state,
        ...(stored.reason !== undefined ? { reason: stored.reason } : {}),
        ...(stored.answeredBy !== undefined ? { answeredBy: stored.answeredBy } : {}),
      },
      dir,
    );
  }
  const after = readRaw(id, dir);
  return { applied, view: after.ok ? after.value : before.value };
}

export type AnswerOutcome =
  | { kind: "applied"; view: ApprovalView }
  | { kind: "replay"; view: ApprovalView }
  | { kind: "expired"; view: ApprovalView }
  | { kind: "not-found"; view?: undefined };

/** A person's answer. First valid answer applies; later ones read it back. */
export function answerApproval(id: string, decision: "allow" | "deny", answeredBy: string, dir?: string, now: Date = new Date()): AnswerOutcome {
  const read = readRaw(id, dir);
  if (!read.ok) {
    return { kind: "not-found" };
  }
  let view = read.value;
  if (view.state === "pending" && now.getTime() >= Date.parse(view.expiresAt)) {
    view = resolveApproval(id, { state: "expired", reason: "expired" }, dir, now).view;
    return { kind: "expired", view };
  }
  if (view.state === "pending") {
    const result = resolveApproval(id, { state: decision === "allow" ? "allowed" : "denied", answeredBy }, dir, now);
    view = result.view;
    if (result.applied) {
      return { kind: "applied", view };
    }
  }
  return view.state === "expired" || view.state === "undeliverable" ? { kind: "expired", view } : { kind: "replay", view };
}

export type ConsumeOutcome = "consumed" | "already-consumed" | "not-allowed" | "fingerprint-mismatch" | "not-found";

/**
 * Spend an allow against the one call it was given for.
 *
 * The fingerprint is checked BEFORE the consumed file is created, so a wrong
 * call cannot burn an approval a right call still needs.
 */
export function consumeApproval(id: string, fingerprint: string, dir?: string, now: Date = new Date()): ConsumeOutcome {
  const read = readRaw(id, dir);
  if (!read.ok) {
    return "not-found";
  }
  if (read.value.state !== "allowed") {
    return "not-allowed";
  }
  if (read.value.consumed) {
    return "already-consumed";
  }
  if (read.value.callFingerprint !== fingerprint) {
    return "fingerprint-mismatch";
  }
  const won = createOwnerOnlyFileExclusive(consumedFile(id, dir), `${JSON.stringify({ at: now.toISOString() })}\n`);
  if (!won) {
    return "already-consumed";
  }
  appendEvidence({ at: now.toISOString(), kind: "consumed", approvalId: id, turnId: read.value.turnId }, dir);
  return "consumed";
}

function approvalIds(dir?: string): string[] {
  const base = root(dir);
  if (!existsSync(base)) {
    return [];
  }
  return readdirSync(base)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".resolution.json"))
    .map((name) => name.slice(0, -".json".length))
    .filter(isApprovalId);
}

/** Every readable approval, oldest first. Given `now`, due pending records are resolved as expired first. */
export function listApprovals(dir?: string, options: { now?: Date } = {}): ApprovalView[] {
  const views: ApprovalView[] = [];
  for (const id of approvalIds(dir)) {
    const read = readApproval(id, dir, options.now);
    if (read.ok) {
      views.push(read.value);
    }
  }
  return views.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.approvalId.localeCompare(b.approvalId));
}

export function countPending(dir?: string, sessionId?: string, now?: Date): number {
  return listApprovals(dir, now !== undefined ? { now } : {}).filter(
    (view) => view.state === "pending" && (sessionId === undefined || view.sessionId === sessionId),
  ).length;
}

export interface ReconcileReport {
  expired: string[];
  abandoned: string[];
}

/**
 * Startup: settle what a previous process left behind.
 *
 * A pending record whose turn is not running here has no one waiting for the
 * answer, so it resolves as an expired deny. An allowed record that was never
 * consumed and whose turn is gone is closed by consuming it as abandoned: the
 * call it was for is never re-executed.
 */
export function reconcileApprovals(dir: string | undefined, options: { isTurnLive: (turnId: string) => boolean; now?: Date }): ReconcileReport {
  const now = options.now ?? new Date();
  const report: ReconcileReport = { expired: [], abandoned: [] };
  for (const id of approvalIds(dir)) {
    const read = readRaw(id, dir);
    if (!read.ok || options.isTurnLive(read.value.turnId)) {
      continue;
    }
    if (read.value.state === "pending") {
      const result = resolveApproval(id, { state: "expired", reason: "turn-not-running-at-startup" }, dir, now);
      if (result.applied) {
        report.expired.push(id);
      }
    } else if (read.value.state === "allowed" && !read.value.consumed) {
      if (createOwnerOnlyFileExclusive(consumedFile(id, dir), `${JSON.stringify({ at: now.toISOString(), reason: "abandoned-at-startup" })}\n`)) {
        appendEvidence({ at: now.toISOString(), kind: "abandoned", approvalId: id, turnId: read.value.turnId, reason: "turn-not-running-at-startup" }, dir);
        report.abandoned.push(id);
      }
    }
  }
  return report;
}

export function readApprovalEvidence(dir?: string): ApprovalEvidence[] {
  const read = readConfigFile(ledgerFile(dir));
  if (!read.ok) {
    return [];
  }
  const events: ApprovalEvidence[] = [];
  for (const line of read.text.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(JSON.parse(line) as ApprovalEvidence);
    } catch {
      continue;
    }
  }
  return events;
}

export function toPublicApproval(view: ApprovalView): PublicApproval {
  return {
    schemaVersion: APPROVAL_SCHEMA_VERSION,
    approvalId: view.approvalId,
    turnId: view.turnId,
    sessionId: view.sessionId,
    summary: view.summary,
    scope: view.scope,
    consequence: view.consequence,
    createdAt: view.createdAt,
    expiresAt: view.expiresAt,
    state: view.state,
    correlationId: view.correlationId,
    ...(view.resolvedAt !== undefined ? { resolvedAt: view.resolvedAt } : {}),
    ...(view.answeredBy !== undefined ? { answeredBy: view.answeredBy } : {}),
  };
}

export function newApprovalId(): string {
  return randomUUID();
}
