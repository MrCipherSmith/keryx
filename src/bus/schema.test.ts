import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUS_EVENT_SCHEMA,
  BUS_PRESENCE_SCHEMA,
  busEventProblems,
  isAssignableBusName,
  PAUSE_LEASE_SCHEMA,
  parseBusEvent,
  parsePauseLease,
  parsePresence,
} from "./schema";

// AC3: records are schema-validated; reserved names are refused.

const DOCS = path.join(import.meta.dir, "..", "..", "docs", "requirements", "keryx-agent-bus", "schemas");
const A = "0f8fad5b-d9cb-469f-a165-70867728950e";
const B = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function docSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(DOCS, name), "utf8")) as Record<string, unknown>;
}

type Node = Record<string, unknown>;
const props = (schema: Node): Node => schema.properties as Node;
const enumOf = (node: unknown): unknown[] => [...((node as Node).enum as unknown[])].sort();
const requiredOf = (node: unknown): unknown[] => [...((node as Node).required as unknown[])].sort();
const keysOf = (node: unknown): string[] => Object.keys(props(node as Node)).sort();

describe("inline schemas mirror docs/requirements/keryx-agent-bus/schemas", () => {
  test("event: required, property and enum sets", () => {
    const doc = docSchema("bus-event.schema.json");
    expect(requiredOf(BUS_EVENT_SCHEMA)).toEqual(requiredOf(doc));
    expect(keysOf(BUS_EVENT_SCHEMA)).toEqual(keysOf(doc));
    expect(enumOf(props(BUS_EVENT_SCHEMA).kind)).toEqual(enumOf(props(doc).kind));
    expect(enumOf(props(props(BUS_EVENT_SCHEMA).from as Node).origin)).toEqual(enumOf(props(props(doc).from as Node).origin));
    expect(requiredOf(props(BUS_EVENT_SCHEMA).from)).toEqual(requiredOf(props(doc).from));
    expect(keysOf(props(BUS_EVENT_SCHEMA).refs)).toEqual(keysOf(props(doc).refs));
    expect((BUS_EVENT_SCHEMA.allOf as unknown[]).length).toBe((doc.allOf as unknown[]).length);
  });

  test("presence: required, property and enum sets", () => {
    const doc = docSchema("bus-presence.schema.json");
    expect(requiredOf(BUS_PRESENCE_SCHEMA)).toEqual(requiredOf(doc));
    expect(keysOf(BUS_PRESENCE_SCHEMA)).toEqual(keysOf(doc));
    for (const key of ["surface", "status"]) {
      expect(enumOf(props(BUS_PRESENCE_SCHEMA)[key])).toEqual(enumOf(props(doc)[key]));
    }
    expect(enumOf((props(BUS_PRESENCE_SCHEMA).name as Node).not)).toEqual(enumOf((props(doc).name as Node).not));
  });

  test("pause lease: required, property and enum sets", () => {
    const doc = docSchema("pause-lease.schema.json");
    expect(requiredOf(PAUSE_LEASE_SCHEMA)).toEqual(requiredOf(doc));
    expect(keysOf(PAUSE_LEASE_SCHEMA)).toEqual(keysOf(doc));
    expect(enumOf(props(PAUSE_LEASE_SCHEMA).scope)).toEqual(enumOf(props(doc).scope));
    expect(enumOf(props(props(PAUSE_LEASE_SCHEMA).holder as Node).origin)).toEqual(
      enumOf(props(props(doc).holder as Node).origin),
    );
  });
});

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value: Record<string, unknown> = {
    schemaVersion: 1,
    seq: 1,
    id: A,
    ts: "2026-09-19T10:00:00.000Z",
    from: { instanceId: B, name: "release", origin: "agent" },
    to: ["*"],
    toLabel: "@all",
    kind: "notice",
    body: "hello",
    ...overrides,
  };
  // An override of undefined removes the key, as a writer that omits it would.
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
  return value;
}

function presence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    instanceId: A,
    name: "agent-1",
    pid: 42,
    host: "h",
    sessionId: B,
    checkout: "/repo",
    branch: null,
    surface: "tui",
    status: "idle",
    activity: "",
    startedAt: "2026-09-19T10:00:00.000Z",
    heartbeatAt: "2026-09-19T10:00:00.000Z",
    keryxVersion: "0.2.121",
    ...overrides,
  };
}

function lease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    leaseId: A,
    holder: { instanceId: B, name: "release", origin: "agent" },
    targets: ["*"],
    scope: "turns",
    reason: "releasing",
    createdAt: "2026-09-19T10:00:00.000Z",
    expiresAt: "2026-09-19T10:30:00.000Z",
    requestEventSeq: 1,
    ...overrides,
  };
}

describe("events", () => {
  test("a broadcast and an addressed event are valid", () => {
    expect(parseBusEvent(event())).toBeDefined();
    expect(parseBusEvent(event({ to: [A], toLabel: "@peer" }))).toBeDefined();
  });

  test("non-UUID ids are refused even though the validator ignores format: uuid", () => {
    expect(parseBusEvent(event({ id: "x" }))).toBeUndefined();
    expect(parseBusEvent(event({ to: ["../etc"] }))).toBeUndefined();
    expect(parseBusEvent(event({ from: { instanceId: "nope", name: "a", origin: "agent" } }))).toBeUndefined();
    expect(parseBusEvent(event({ kind: "reply", refs: { replyTo: "nope" } }))).toBeUndefined();
  });

  test("an unknown schemaVersion is not a v1 event", () => {
    expect(parseBusEvent(event({ schemaVersion: 2 }))).toBeUndefined();
  });

  test("kind rules: reply needs replyTo, notice needs a body, ack is system-only and bodiless", () => {
    expect(parseBusEvent(event({ kind: "reply" }))).toBeUndefined();
    expect(parseBusEvent(event({ kind: "reply", refs: { replyTo: A } }))).toBeDefined();
    expect(parseBusEvent(event({ body: undefined }))).toBeUndefined();
    const ack = { kind: "ack", body: undefined, refs: { replyTo: A } };
    expect(parseBusEvent(event({ ...ack, from: { instanceId: B, name: "system", origin: "system" } }))).toEqual(
      expect.objectContaining({ kind: "ack" }),
    );
    expect(parseBusEvent(event(ack))).toBeUndefined();
  });

  test("reserved sender names: all never, cli and system only for their own origin", () => {
    expect(parseBusEvent(event({ from: { instanceId: B, name: "all", origin: "agent" } }))).toBeUndefined();
    expect(parseBusEvent(event({ from: { instanceId: B, name: "cli", origin: "agent" } }))).toBeUndefined();
    expect(parseBusEvent(event({ from: { instanceId: B, name: "system", origin: "operator" } }))).toBeUndefined();
    expect(parseBusEvent(event({ from: { instanceId: B, name: "cli", origin: "cli" } }))).toBeDefined();
  });

  test("the body bound is 2048 UTF-8 bytes, not characters", () => {
    expect(parseBusEvent(event({ body: "a".repeat(2048) }))).toBeDefined();
    expect(busEventProblems(event({ body: "é".repeat(1025) })).join()).toMatch(/2048 bytes/);
  });
});

describe("presence", () => {
  test("valid, and the names all, cli and system are refused", () => {
    expect(parsePresence(presence())).toBeDefined();
    for (const name of ["all", "cli", "system"]) {
      expect(parsePresence(presence({ name }))).toBeUndefined();
      expect(isAssignableBusName(name)).toBe(false);
    }
    expect(parsePresence(presence({ name: "Upper" }))).toBeUndefined();
    expect(parsePresence(presence({ sessionId: "s" }))).toBeUndefined();
    expect(parsePresence(presence({ activity: "x".repeat(121) }))).toBeUndefined();
  });
});

describe("pause leases", () => {
  test("valid, including a CLI holder", () => {
    expect(parsePauseLease(lease())).toBeDefined();
    expect(parsePauseLease(lease({ holder: { instanceId: B, name: "cli", origin: "cli" } }))).toBeDefined();
  });

  test("refuses a TTL over 4 h, a lease targeting its holder and a reserved holder name", () => {
    expect(parsePauseLease(lease({ expiresAt: "2026-09-19T14:00:01.000Z" }))).toBeUndefined();
    expect(parsePauseLease(lease({ expiresAt: "2026-09-19T09:00:00.000Z" }))).toBeUndefined();
    expect(parsePauseLease(lease({ targets: [B] }))).toBeUndefined();
    expect(parsePauseLease(lease({ holder: { instanceId: B, name: "cli", origin: "agent" } }))).toBeUndefined();
    expect(parsePauseLease(lease({ leaseId: "../x" }))).toBeUndefined();
  });
});

// Review r2 N1: timestamps are strict ISO-8601 UTC. Bun's Date.parse ignores
// parenthesised text, so a lenient check let an escape sequence through.
describe("strict timestamps (r2 N1)", () => {
  const hostile = "(\u001b[2J) Jan 1 2026";

  test("the hostile value really does parse, so Date.parse alone is not a check", () => {
    expect(Number.isNaN(Date.parse(hostile))).toBe(false);
  });

  test("events, presence and leases carrying it are rejected", () => {
    expect(parseBusEvent(event({ ts: hostile }))).toBeUndefined();
    expect(parsePresence(presence({ heartbeatAt: hostile }))).toBeUndefined();
    expect(parsePresence(presence({ startedAt: hostile }))).toBeUndefined();
    expect(parsePauseLease(lease({ expiresAt: hostile }))).toBeUndefined();
    expect(parsePauseLease(lease({ createdAt: hostile }))).toBeUndefined();
  });

  test("the form the bus writes is accepted, with or without fractions; offsets and dates alone are not", () => {
    expect(parseBusEvent(event({ ts: "2026-09-19T10:00:00Z" }))).toBeDefined();
    expect(parseBusEvent(event({ ts: "2026-09-19T10:00:00.123456789Z" }))).toBeDefined();
    expect(parseBusEvent(event({ ts: "2026-09-19T10:00:00+02:00" }))).toBeUndefined();
    expect(parseBusEvent(event({ ts: "2026-09-19" }))).toBeUndefined();
  });
});
