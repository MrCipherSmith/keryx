// Agent bus record contracts (specification §4, decisions D-06, D-12).
//
// The machine-readable schemas are `docs/requirements/keryx-agent-bus/schemas/`.
// `docs/` is not shipped in the npm package, so the runtime cannot read them;
// they are mirrored here inline and `schema.test.ts` checks that the required
// and enum sets still match the docs.
//
// Two differences from the docs files, both stricter:
//
// - every `format: "uuid"` also carries a `pattern`, because
//   `validateAgainstSchemaObject` does not enforce `format: uuid`. Without it
//   `["*"]` would match both `oneOf` branches of `to`/`targets` and be refused;
// - the rules the docs leave to "the writer" (reserved names by origin, the
//   2048-byte body bound, the 4 h lease bound) are checked in code below.
//
// A record that fails any of this is not a bus record: readers skip it and
// never throw (§4), writers refuse it.

import { validateAgainstSchemaObject } from "../contracts/validator";

export const BUS_SCHEMA_VERSION = 1;

export const BUS_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const RESERVED_BUS_NAMES: readonly string[] = ["all", "cli", "system"];
export const MAX_BODY_BYTES = 2048;
export const MAX_ACTIVITY_CHARS = 120;
export const MAX_LEASE_TTL_MS = 4 * 60 * 60 * 1000;

export const BUS_ORIGINS = ["agent", "operator", "cli", "system"] as const;
export const BUS_EVENT_KINDS = [
  "notice",
  "question",
  "reply",
  "handoff",
  "pause-request",
  "resume",
  "override",
  "ack",
  "lease-expired",
] as const;
export const PRESENCE_SURFACES = ["tui", "readline"] as const;
export const PRESENCE_STATUSES = ["idle", "working", "blocked", "held"] as const;
export const LEASE_SCOPES = ["turns", "git-publish", "advisory"] as const;
export const LEASE_HOLDER_ORIGINS = ["agent", "operator", "cli"] as const;

export type BusOrigin = (typeof BUS_ORIGINS)[number];
export type BusEventKind = (typeof BUS_EVENT_KINDS)[number];
export type PresenceSurface = (typeof PRESENCE_SURFACES)[number];
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];
export type LeaseScope = (typeof LEASE_SCOPES)[number];

export interface BusSender {
  instanceId: string;
  name: string;
  origin: BusOrigin;
}

export interface BusEventRefs {
  replyTo?: string;
  leaseId?: string;
  flowId?: string;
  taskId?: string;
}

export interface BusEvent {
  schemaVersion: 1;
  seq: number;
  id: string;
  ts: string;
  from: BusSender;
  /** Resolved recipient instance ids, or `["*"]` for `@all`. */
  to: string[];
  toLabel: string;
  kind: BusEventKind;
  body?: string;
  refs?: BusEventRefs;
}

export interface PresenceRecord {
  schemaVersion: 1;
  instanceId: string;
  name: string;
  pid: number;
  host: string;
  sessionId: string;
  checkout: string;
  branch: string | null;
  surface: PresenceSurface;
  status: PresenceStatus;
  activity: string;
  startedAt: string;
  heartbeatAt: string;
  keryxVersion: string;
}

export interface PauseLease {
  schemaVersion: 1;
  leaseId: string;
  holder: { instanceId: string; name: string; origin: (typeof LEASE_HOLDER_ORIGINS)[number] };
  targets: string[];
  scope: LeaseScope;
  reason: string;
  createdAt: string;
  expiresAt: string;
  requestEventSeq: number;
}

const UUID = { type: "string", format: "uuid", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$" };
const NAME = { type: "string", pattern: BUS_NAME_PATTERN.source };
const DATE_TIME = { type: "string", format: "date-time" };
const RECIPIENTS = {
  oneOf: [
    { type: "array", items: { const: "*" }, minItems: 1, maxItems: 1 },
    { type: "array", items: UUID, minItems: 1, maxItems: 32, uniqueItems: true },
  ],
};

export const BUS_EVENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "seq", "id", "ts", "from", "to", "toLabel", "kind"],
  properties: {
    schemaVersion: { const: BUS_SCHEMA_VERSION },
    seq: { type: "integer", minimum: 1 },
    id: UUID,
    ts: DATE_TIME,
    from: {
      type: "object",
      additionalProperties: false,
      required: ["instanceId", "name", "origin"],
      properties: { instanceId: UUID, name: NAME, origin: { enum: [...BUS_ORIGINS] } },
    },
    to: RECIPIENTS,
    toLabel: { type: "string", pattern: "^@([a-z0-9][a-z0-9-]{0,31}|all)$" },
    kind: { enum: [...BUS_EVENT_KINDS] },
    body: { type: "string", maxLength: MAX_BODY_BYTES },
    refs: {
      type: "object",
      additionalProperties: false,
      properties: {
        replyTo: UUID,
        leaseId: UUID,
        flowId: { type: "string", pattern: "^[0-9]{3,}$" },
        taskId: { type: "string", maxLength: 64 },
      },
    },
  },
  allOf: [
    {
      if: { properties: { kind: { enum: ["notice", "question", "reply", "handoff", "pause-request"] } } },
      then: { required: ["body"] },
    },
    {
      if: { properties: { kind: { const: "reply" } } },
      then: { required: ["refs"], properties: { refs: { required: ["replyTo"] } } },
    },
    {
      if: { properties: { kind: { enum: ["pause-request", "resume", "override", "lease-expired"] } } },
      then: { required: ["refs"], properties: { refs: { required: ["leaseId"] } } },
    },
    {
      if: { properties: { kind: { const: "ack" } } },
      then: { required: ["refs"], properties: { refs: { required: ["replyTo"] } }, not: { required: ["body"] } },
    },
    {
      if: { properties: { kind: { enum: ["override", "ack", "lease-expired"] } } },
      then: { properties: { from: { properties: { origin: { const: "system" } } } } },
    },
  ],
};

export const BUS_PRESENCE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion",
    "instanceId",
    "name",
    "pid",
    "host",
    "sessionId",
    "checkout",
    "branch",
    "surface",
    "status",
    "activity",
    "startedAt",
    "heartbeatAt",
    "keryxVersion",
  ],
  properties: {
    schemaVersion: { const: BUS_SCHEMA_VERSION },
    instanceId: UUID,
    name: { ...NAME, not: { enum: [...RESERVED_BUS_NAMES] } },
    pid: { type: "integer", minimum: 1 },
    host: { type: "string", minLength: 1, maxLength: 255 },
    sessionId: UUID,
    checkout: { type: "string", minLength: 1 },
    branch: { type: ["string", "null"], maxLength: 255 },
    surface: { enum: [...PRESENCE_SURFACES] },
    status: { enum: [...PRESENCE_STATUSES] },
    activity: { type: "string", maxLength: MAX_ACTIVITY_CHARS },
    startedAt: DATE_TIME,
    heartbeatAt: DATE_TIME,
    keryxVersion: { type: "string", minLength: 1 },
  },
};

export const PAUSE_LEASE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "leaseId", "holder", "targets", "scope", "reason", "createdAt", "expiresAt", "requestEventSeq"],
  properties: {
    schemaVersion: { const: BUS_SCHEMA_VERSION },
    leaseId: UUID,
    holder: {
      type: "object",
      additionalProperties: false,
      required: ["instanceId", "name", "origin"],
      properties: { instanceId: UUID, name: NAME, origin: { enum: [...LEASE_HOLDER_ORIGINS] } },
    },
    targets: RECIPIENTS,
    scope: { enum: [...LEASE_SCOPES] },
    reason: { type: "string", minLength: 1, maxLength: 2048 },
    createdAt: DATE_TIME,
    expiresAt: DATE_TIME,
    requestEventSeq: { type: "integer", minimum: 1 },
  },
};

// ---------------------------------------------------------------------------
// Names (D-06).
// ---------------------------------------------------------------------------

export function isBusNameShape(value: unknown): value is string {
  return typeof value === "string" && BUS_NAME_PATTERN.test(value);
}

/** A name an instance may hold: the right shape and not reserved. */
export function isAssignableBusName(value: unknown): value is string {
  return isBusNameShape(value) && !RESERVED_BUS_NAMES.includes(value);
}

/** `name` is acceptable for a sender of `origin`: `cli`/`system` only for their own origin, `all` never. */
function senderNameAllowed(name: string, origin: string): boolean {
  if (name === "all") return false;
  if (name === "cli") return origin === "cli";
  if (name === "system") return origin === "system";
  return true;
}

// ---------------------------------------------------------------------------
// Checks. Each returns the list of problems; empty means valid.
// ---------------------------------------------------------------------------

function schemaProblems(schema: Record<string, unknown>, value: unknown): string[] {
  return validateAgainstSchemaObject(schema, value).errors.map((error) => `${error.path}: ${error.message}`);
}

function isTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function busEventProblems(value: unknown): string[] {
  const problems = schemaProblems(BUS_EVENT_SCHEMA, value);
  if (problems.length > 0) return problems;
  const event = value as BusEvent;
  if (!senderNameAllowed(event.from.name, event.from.origin)) {
    problems.push(`$.from.name: "${event.from.name}" is reserved for another origin`);
  }
  if (!isTimestamp(event.ts)) problems.push("$.ts: not a timestamp");
  if (event.body !== undefined && Buffer.byteLength(event.body, "utf8") > MAX_BODY_BYTES) {
    problems.push(`$.body: longer than ${MAX_BODY_BYTES} bytes`);
  }
  return problems;
}

export function presenceProblems(value: unknown): string[] {
  const problems = schemaProblems(BUS_PRESENCE_SCHEMA, value);
  if (problems.length > 0) return problems;
  const record = value as PresenceRecord;
  if (!isTimestamp(record.startedAt)) problems.push("$.startedAt: not a timestamp");
  if (!isTimestamp(record.heartbeatAt)) problems.push("$.heartbeatAt: not a timestamp");
  return problems;
}

export function pauseLeaseProblems(value: unknown): string[] {
  const problems = schemaProblems(PAUSE_LEASE_SCHEMA, value);
  if (problems.length > 0) return problems;
  const lease = value as PauseLease;
  if (!senderNameAllowed(lease.holder.name, lease.holder.origin)) {
    problems.push(`$.holder.name: "${lease.holder.name}" is reserved for another origin`);
  }
  const created = Date.parse(lease.createdAt);
  const expires = Date.parse(lease.expiresAt);
  if (Number.isNaN(created) || Number.isNaN(expires)) {
    problems.push("$.createdAt/$.expiresAt: not a timestamp");
  } else if (expires <= created || expires - created > MAX_LEASE_TTL_MS) {
    problems.push("$.expiresAt: must be after createdAt and at most 4 h later");
  }
  if (lease.targets.includes(lease.holder.instanceId)) {
    problems.push("$.targets: a lease never targets its own holder");
  }
  return problems;
}

/** The event, or undefined for anything that is not a valid v1 event (readers skip it). */
export function parseBusEvent(value: unknown): BusEvent | undefined {
  return busEventProblems(value).length === 0 ? (value as BusEvent) : undefined;
}

export function parsePresence(value: unknown): PresenceRecord | undefined {
  return presenceProblems(value).length === 0 ? (value as PresenceRecord) : undefined;
}

export function parsePauseLease(value: unknown): PauseLease | undefined {
  return pauseLeaseProblems(value).length === 0 ? (value as PauseLease) : undefined;
}
