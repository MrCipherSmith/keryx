// Flow 242 (forgetting), lane B — the three holes in `./section-tombstone.ts`,
// each first measured on a real scratch project and each driven here through the
// surface an operator or an agent actually reaches: `wikiCommand(["sections",
// …])`, the same entry point `keryx wiki sections` runs, with its real exit
// codes. A test that called `resolveSectionIdentity` alone would prove the
// helper and not the command, which is the defect class the phase-1 inventory
// recorded five times over (a capability implemented where no live path called
// it).
//
// The measured "before" for each, on a scratch wiki with three pages:
//
//   1. Registry `chmod 000`, seven genuine tombstones on disk.
//      resolve → {"kind":"unknown","reason":"…nothing records it as removed."}  exit 0
//      sync    → registered 7, added 7, tombstoned 0, revived 0                 exit 0
//      then    → entries: 7 tombstones: 0     — the history was destroyed.
//   2. Page deleted, a DIFFERENT document written at the same path.
//      resolve → {"kind":"found","body":"- Shipping charges are quoted in whole
//                 currency units, NOT in cents."}                               exit 0
//      sync    → revived 7; tombstones on disk: []
//      The tombstoned section had said "Amounts are stored in integer cents".
//   3. Page deleted, `sync` not yet run.
//      resolve → {"kind":"unknown","reason":"…nothing records it as removed."}
//      while `sync --dry-run` could name all seven pending tombstones and the
//      registry still held the ref as a live entry.
//
// Every assertion below fails if its guard is removed; the destructive-write
// case is driven through a real `chmod 000` and a real EACCES, never an injected
// error, because AC3 of the flow requires "реально нечитаемое хранилище".

import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { wikiCommand } from "../commands/wiki";
import { collectPages } from "./collect";
import { buildSectionIndex } from "./section-index";
import {
  readSectionRegistryState,
  resolveSectionIdentity,
  syncSectionRegistry,
  type SectionRegistry,
} from "./section-tombstone";

const BILLING_ORIGINAL = `<!-- keryx:page id="architecture-billing-charges" v=1 -->
# Billing charges

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

How charges are computed.

<!-- keryx:section id="constraints" v=1 -->
## Constraints

- Amounts are stored in integer cents, never in floating point.
<!-- /keryx:section -->

<!-- keryx:section id="rounding" v=1 -->
## Rounding

Half-up at the last step only.
<!-- /keryx:section -->
`;

// The same path, the same page id (it is derived from the path), a document
// with nothing to do with the first one — and a Constraints section that says
// the OPPOSITE of the one that was removed.
const BILLING_REPLACEMENT = `<!-- keryx:page id="architecture-billing-charges" v=1 -->
# Billing charges

Version: 0.2.0
Type: architecture
Status: accepted

## Summary

A completely different document about shipping.

<!-- keryx:section id="constraints" v=1 -->
## Constraints

- Shipping charges are quoted in whole currency units, NOT in cents.
<!-- /keryx:section -->
`;

const ORDERS = `<!-- keryx:page id="architecture-order-placement" v=1 -->
# Order placement

Version: 0.1.0
Type: architecture
Status: accepted

## Summary

How an order gets placed.

<!-- keryx:section id="constraints" v=1 -->
## Constraints

- An order may not be placed without a validated address.
<!-- /keryx:section -->
`;

const BILLING_REF = "keryx:page/architecture-billing-charges#constraints";
const BILLING_PAGE_REF = "keryx:page/architecture-billing-charges";
/** Deliberately far from any clock this test could observe. */
const FIRST_SEEN = "2020-01-01T00:00:00.000Z";

let root = "";
let originalCwd = "";
let out: string[] = [];
let err: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;

function wikiDir(): string {
  return path.join(root, ".metaproject", "wiki");
}

function registryPath(): string {
  return path.join(wikiDir(), ".sections.json");
}

function billingPath(): string {
  return path.join(wikiDir(), "architecture", "billing-charges.md");
}

async function writePage(folder: string, file: string, body: string): Promise<void> {
  await mkdir(path.join(wikiDir(), folder), { recursive: true });
  await writeFile(path.join(wikiDir(), folder, file), body, "utf8");
}

/** Run the real command, capture what it printed and what it exited with. */
async function sections(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  out = [];
  err = [];
  process.exitCode = 0;
  await wikiCommand(["sections", ...args]);
  const exitCode = typeof process.exitCode === "number" ? process.exitCode : 0;
  process.exitCode = 0;
  return { stdout: out.join("\n"), stderr: err.join("\n"), exitCode };
}

async function indexNow() {
  const pages = await collectPages(root);
  return buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({ page, content: await readFile(page.absolutePath, "utf8") })),
    ),
  );
}

async function registryOnDisk(): Promise<SectionRegistry> {
  const read = await readSectionRegistryState(root);
  if (read.state !== "present") {
    throw new Error(`expected a readable registry, got ${read.state}`);
  }
  return read.registry;
}

async function registryDigest(): Promise<string> {
  return createHash("sha256").update(await readFile(registryPath())).digest("hex");
}

/** The starting position of every test: three tombstones, honestly earned. */
async function tombstoneBillingForReal(): Promise<void> {
  await sections("sync");
  await rm(billingPath());
  const synced = await sections("sync");
  expect(synced.stdout).toContain("tombstoned 3");
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-forgetting-"));
  originalCwd = process.cwd();
  await writePage("architecture", "order-placement.md", ORDERS);
  await writePage("architecture", "billing-charges.md", BILLING_ORIGINAL);
  process.chdir(root);
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => {
    out.push(parts.map(String).join(" "));
  };
  console.error = (...parts: unknown[]) => {
    err.push(parts.map(String).join(" "));
  };
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = originalLog;
  console.error = originalError;
  process.chdir(originalCwd);
  process.exitCode = 0;
  await chmod(wikiDir(), 0o755).catch(() => undefined);
  await chmod(registryPath(), 0o644).catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

// --- hole 1: a read failure was reported as a claim, then written back --------

test("AC3: a genuinely unreadable registry makes resolve refuse to answer, not claim nothing was removed", async () => {
  await tombstoneBillingForReal();
  await chmod(registryPath(), 0o000);

  const resolved = await sections("resolve", BILLING_REF, "--json");
  const payload = JSON.parse(resolved.stdout || "{}") as { resolution?: { kind?: string } };

  // The measured before: kind "unknown", reason "nothing records it as removed",
  // exit 0 — a read failure rendered as a positive claim about history.
  expect(payload.resolution?.kind).toBe("registry-unreadable");
  expect(resolved.stdout).not.toContain("nothing records it as removed");
  // 2, not 1: 1 is "this identity is not live", which is itself a claim.
  expect(resolved.exitCode).toBe(2);
});

test("AC3: a sync over an unreadable registry refuses by name and writes nothing", async () => {
  await tombstoneBillingForReal();
  const before = await registryDigest();
  await chmod(registryPath(), 0o000);

  const synced = await sections("sync");

  expect(synced.stderr).toContain("REFUSED");
  expect(synced.stderr).toContain("Nothing was written.");
  expect(synced.exitCode).toBe(1);
  // The measured before: "registered 7, added 7, tombstoned 0" at exit 0, with
  // seven tombstone records gone from disk.
  expect(synced.stdout).not.toContain("registered");

  await chmod(registryPath(), 0o644);
  expect(await registryDigest()).toBe(before);
  const registry = await registryOnDisk();
  expect(registry.tombstones).toHaveLength(3);
});

test("AC3: a registry that parses but holds an unparseable record is unreadable, not a shorter history", async () => {
  await tombstoneBillingForReal();
  const registry = await registryOnDisk();
  await writeFile(
    registryPath(),
    `${JSON.stringify({
      ...registry,
      tombstones: [...registry.tombstones, { ref: 42, note: "corrupted by a partial write" }],
    })}\n`,
    "utf8",
  );

  const read = await readSectionRegistryState(root);
  expect(read.state).toBe("unreadable");
  if (read.state === "unreadable") {
    expect(read.reason).toContain("1 record");
  }

  const synced = await sections("sync");
  expect(synced.stderr).toContain("REFUSED");
  expect(synced.exitCode).toBe(1);
  // Dropping the damaged record and writing the survivors back would have
  // destroyed it silently while reporting a clean sync.
  const after = JSON.parse(await readFile(registryPath(), "utf8")) as {
    tombstones: Array<Record<string, unknown>>;
  };
  expect(after.tombstones).toHaveLength(4);
});

test("AC3: a registry that cannot be WRITTEN is a refusal, not a completed sync", async () => {
  await tombstoneBillingForReal();
  const before = await registryDigest();
  await chmod(wikiDir(), 0o555);

  const synced = await sections("sync");

  expect(synced.stderr).toContain("REFUSED");
  expect(synced.stderr).toContain("could not be written");
  expect(synced.exitCode).toBe(1);

  await chmod(wikiDir(), 0o755);
  expect(await registryDigest()).toBe(before);
});

// --- hole 2: delete, recreate at the same path, and the tombstone is overridden

test("AC2: a different document at the same path does NOT answer to the tombstoned id", async () => {
  await tombstoneBillingForReal();
  await writeFile(billingPath(), BILLING_REPLACEMENT, "utf8");

  const resolved = await sections("resolve", BILLING_REF, "--json");
  const payload = JSON.parse(resolved.stdout || "{}") as {
    resolution?: { kind?: string; evidence?: string; occupantPage?: string };
  };

  // The measured before: kind "found", body "- Shipping charges are quoted in
  // whole currency units, NOT in cents." — the exact opposite of the section
  // that was removed, returned as though it were that section.
  expect(payload.resolution?.kind).toBe("reoccupied");
  expect(payload.resolution?.evidence).toBe("different-content");
  expect(payload.resolution?.occupantPage).toBe("architecture/billing-charges.md");
  expect(resolved.exitCode).toBe(1);
});

test("AC2: a sync over a reoccupied identity keeps the tombstone and does not call it a revival", async () => {
  await tombstoneBillingForReal();
  await writeFile(billingPath(), BILLING_REPLACEMENT, "utf8");

  const synced = await sections("sync");

  // The measured before: "revived 7" and `tombstones: []`.
  expect(synced.stdout).toContain("revived 0");
  expect(synced.stdout).toContain("reoccupied 2");
  expect(synced.stdout).toContain("REOCCUPIED");
  expect(synced.exitCode).toBe(1);

  const registry = await registryOnDisk();
  expect(registry.tombstones.map((entry) => entry.ref)).toContain(BILLING_REF);
  expect(registry.tombstones.map((entry) => entry.ref)).toContain(BILLING_PAGE_REF);
  expect(registry.lifted).toHaveLength(0);
});

test("AC2: a genuine restoration is NOT refused — identical content lifts the tombstone", async () => {
  await tombstoneBillingForReal();
  await writeFile(billingPath(), BILLING_ORIGINAL, "utf8");

  // Even before the sync — in the interruption window — the address reads as
  // found, because the content that came back IS the content that was removed.
  const early = await sections("resolve", BILLING_REF, "--json");
  const earlyPayload = JSON.parse(early.stdout || "{}") as {
    resolution?: { kind?: string; history?: { removedAt?: string; restoredAt?: string | null } };
  };
  expect(earlyPayload.resolution?.kind).toBe("found");
  expect(earlyPayload.resolution?.history?.removedAt).toBeTruthy();
  expect(earlyPayload.resolution?.history?.restoredAt).toBeNull();
  expect(early.exitCode).toBe(0);

  const synced = await sections("sync");
  expect(synced.stdout).toContain("revived 3");
  expect(synced.stdout).toContain("reoccupied 0");
  expect(synced.exitCode).toBe(0);

  const registry = await registryOnDisk();
  expect(registry.tombstones).toHaveLength(0);
  // AC6: the removal record is not destroyed by the call that reverses it.
  expect(registry.lifted.map((entry) => entry.ref)).toContain(BILLING_REF);
  const lifted = registry.lifted.find((entry) => entry.ref === BILLING_REF);
  expect(lifted?.removedAt).toBeTruthy();
  expect(lifted?.restoredAt).toBeTruthy();
  expect(lifted?.reason).toContain("no longer present");
});

test("AC2: a tombstone written before content was recorded says unverifiable, it does not guess", async () => {
  await tombstoneBillingForReal();
  const registry = await registryOnDisk();
  // A version-1 registry: tombstones carried no digest, so restoration and
  // substitution genuinely cannot be told apart. That is the third answer.
  await writeFile(
    registryPath(),
    `${JSON.stringify({
      version: 1,
      entries: registry.entries.map(({ digest: _digest, registeredAt: _at, ...rest }) => rest),
      tombstones: registry.tombstones.map(({ digest: _digest, registeredAt: _at, ...rest }) => rest),
    })}\n`,
    "utf8",
  );
  await writeFile(billingPath(), BILLING_ORIGINAL, "utf8");

  const resolved = await sections("resolve", BILLING_REF, "--json");
  const payload = JSON.parse(resolved.stdout || "{}") as {
    resolution?: { kind?: string; evidence?: string };
  };
  expect(payload.resolution?.kind).toBe("reoccupied");
  expect(payload.resolution?.evidence).toBe("unverifiable");
  expect(resolved.exitCode).toBe(1);
});

test("AC2: a reoccupation has an exit — an operator can accept it, and the record survives that too", async () => {
  await tombstoneBillingForReal();
  await writeFile(billingPath(), BILLING_REPLACEMENT, "utf8");
  await sections("sync");

  const accepted = await sections("sync", "--accept-reoccupation", `${BILLING_REF},${BILLING_PAGE_REF}`);
  expect(accepted.stdout).toContain("reoccupied 0");
  expect(accepted.exitCode).toBe(0);

  const registry = await registryOnDisk();
  expect(registry.tombstones.map((entry) => entry.ref)).not.toContain(BILLING_REF);
  const lifted = registry.lifted.find((entry) => entry.ref === BILLING_REF);
  expect(lifted?.restoredReason).toContain("operator accepted");
  expect(lifted?.removedAt).toBeTruthy();
});

// --- hole 3: the interruption window answered "never existed" ----------------

test("AC4/AC5: between the deletion and the sync, a removed ref is pending-tombstone, not unknown", async () => {
  await sections("sync");
  await rm(billingPath());

  const resolved = await sections("resolve", BILLING_REF, "--json");
  const payload = JSON.parse(resolved.stdout || "{}") as {
    resolution?: { kind?: string; reason?: string; entry?: { page?: string } };
  };

  // The measured before: kind "unknown", "nothing records it as removed" —
  // while the registry held the ref as a live entry and `sync --dry-run` could
  // name it as a pending tombstone.
  expect(payload.resolution?.kind).toBe("pending-tombstone");
  expect(payload.resolution?.entry?.page).toBe("architecture/billing-charges.md");
  expect(payload.resolution?.reason).toContain("sync");
  expect(resolved.exitCode).toBe(1);

  // The registry was not touched by the read.
  const registry = await registryOnDisk();
  expect(registry.tombstones).toHaveLength(0);
  expect(registry.entries.map((entry) => entry.ref)).toContain(BILLING_REF);
});

test("AC5: never-existed, existed-and-removed, half-removed and cannot-say are four different answers", async () => {
  await sections("sync");
  const never = await sections("resolve", "keryx:page/architecture-order-placement#no-such-id", "--json");
  const neverKind = (JSON.parse(never.stdout) as { resolution: { kind: string } }).resolution.kind;

  await rm(billingPath());
  const halfway = await sections("resolve", BILLING_REF, "--json");
  const halfwayKind = (JSON.parse(halfway.stdout) as { resolution: { kind: string } }).resolution.kind;

  await sections("sync");
  const removed = await sections("resolve", BILLING_REF, "--json");
  const removedKind = (JSON.parse(removed.stdout) as { resolution: { kind: string } }).resolution.kind;

  await chmod(registryPath(), 0o000);
  const cannotSay = await sections("resolve", BILLING_REF, "--json");
  const cannotSayKind = (JSON.parse(cannotSay.stdout) as { resolution: { kind: string } }).resolution.kind;
  await chmod(registryPath(), 0o644);

  expect([neverKind, halfwayKind, removedKind, cannotSayKind]).toEqual([
    "unknown",
    "pending-tombstone",
    "tombstoned",
    "registry-unreadable",
  ]);
  expect(new Set([neverKind, halfwayKind, removedKind, cannotSayKind]).size).toBe(4);
});

test("AC3: a registry that parses to something that is not a registry is unreadable, not absent", async () => {
  await tombstoneBillingForReal();
  const before = await registryDigest();
  // The exact payload `readJsonObjectFile` exists for: four bytes that parse
  // cleanly and are not a registry. Read through a plain fallback these become
  // "this project has never been synced", and the next sync writes an empty
  // history over three tombstones.
  await writeFile(registryPath(), "[]\n", "utf8");

  const read = await readSectionRegistryState(root);
  expect(read.state).toBe("unreadable");
  if (read.state === "unreadable") {
    expect(read.reason).toContain("an array");
  }

  const synced = await sections("sync");
  expect(synced.stderr).toContain("REFUSED");
  expect(synced.exitCode).toBe(1);
  expect(await registryDigest()).not.toBe(before);
  // Nothing was written: the four bytes are still there, unrepaired and
  // unreplaced.
  expect(await readFile(registryPath(), "utf8")).toBe("[]\n");
});

// --- the surfaces, not the types --------------------------------------------
//
// Every assertion above reads `--json`, where a new state is a new `kind`
// string and cannot be confused with another. The recurring defect of this
// programme lives one layer out: a state that the type system distinguishes and
// the OUTPUT does not. Removing the human-readable rendering of all four new
// answers left the `--json` suite fully green, so these drive the plain surface.

test("AC5: the plain CLI renders four different answers, not one line four times", async () => {
  await sections("sync");
  const never = await sections("resolve", "keryx:page/architecture-order-placement#no-such-id");

  await rm(billingPath());
  const halfway = await sections("resolve", BILLING_REF);

  await sections("sync");
  const removed = await sections("resolve", BILLING_REF);

  await writeFile(billingPath(), BILLING_REPLACEMENT, "utf8");
  const occupied = await sections("resolve", BILLING_REF);

  await rm(billingPath());
  await chmod(registryPath(), 0o000);
  const cannotSay = await sections("resolve", BILLING_REF);
  await chmod(registryPath(), 0o644);

  expect(never.stdout).toContain("unknown:");
  expect(halfway.stdout).toContain("pending-tombstone:");
  expect(removed.stdout).toContain("tombstoned:");
  expect(occupied.stdout).toContain("reoccupied [different-content]:");
  // An unreadable history is the one answer that is not a claim, so it goes to
  // stderr and never appears on stdout beside the four that are.
  expect(cannotSay.stderr).toContain("registry-unreadable:");
  expect(cannotSay.stdout).toBe("");

  const lines = [never, halfway, removed, occupied].map((run) => run.stdout.split("\n")[0]);
  expect(new Set(lines).size).toBe(4);
  // None of the three new answers is dressed as the oldest one.
  for (const run of [halfway, removed, occupied]) {
    expect(run.stdout).not.toContain("unknown:");
  }
});

test("AC6: the plain CLI tells a restored identity from one that never moved", async () => {
  await tombstoneBillingForReal();
  const untouched = await sections("resolve", "keryx:page/architecture-order-placement#constraints");
  expect(untouched.stdout).toContain("found:");
  expect(untouched.stdout).not.toContain("history:");

  await writeFile(billingPath(), BILLING_ORIGINAL, "utf8");
  const restored = await sections("resolve", BILLING_REF);
  expect(restored.stdout).toContain("found:");
  // Same `found`, and the reader is told the content in front of them was
  // deleted and came back — the fact they need when it surprises them.
  expect(restored.stdout).toContain("history: removed");
  expect(restored.stdout).toContain("no longer present");
  expect(restored.exitCode).toBe(0);

  await sections("sync");
  const afterSync = await sections("resolve", BILLING_REF);
  expect(afterSync.stdout).toContain("restored ");
  expect(afterSync.stdout).toContain("lifted record");
});

test("AC3: a refused sync does not exit 0 under --json either", async () => {
  await tombstoneBillingForReal();
  await chmod(registryPath(), 0o000);

  const synced = await sections("sync", "--json");
  const payload = JSON.parse(synced.stdout || "{}") as { status?: string; reason?: string };

  // The `--json` branch prints and returns on its own path, so its exit code is
  // a second implementation of the same decision — and a caller that reads only
  // the status code is exactly the caller that cannot see the `reason` field.
  expect(payload.status).toBe("refused");
  expect(payload.reason).toContain("destroys every tombstone");
  expect(synced.exitCode).toBe(1);
  await chmod(registryPath(), 0o644);
});

// --- AC6: the trail records WHEN, and keeps recording it --------------------

test("AC6: an identity keeps the moment it was first registered, through syncs and into its tombstone", async () => {
  await sections("sync");
  const registry = await registryOnDisk();
  // A distinctive first-registration moment, so a re-stamp is unmistakable
  // rather than a millisecond apart from the truth.
  await writeFile(
    registryPath(),
    `${JSON.stringify({
      ...registry,
      entries: registry.entries.map((entry) => ({ ...entry, registeredAt: FIRST_SEEN })),
    })}\n`,
    "utf8",
  );

  await sections("sync");
  const resynced = await registryOnDisk();
  expect(resynced.entries.every((entry) => entry.registeredAt === FIRST_SEEN)).toBe(true);

  await rm(billingPath());
  const pending = await sections("resolve", BILLING_REF, "--json");
  // "когда" in AC6 is the whole life of the identity, not the moment of the
  // last sync: the halfway answer names when it was first registered.
  expect(pending.stdout).toContain(FIRST_SEEN);

  await sections("sync");
  const tombstoned = await registryOnDisk();
  const tombstone = tombstoned.tombstones.find((entry) => entry.ref === BILLING_REF);
  expect(tombstone?.registeredAt).toBe(FIRST_SEEN);
  expect(tombstone?.removedAt).not.toBe(FIRST_SEEN);
});

// --- the module boundary, for the states the CLI renders --------------------

test("a resolution built straight from an unreadable read makes no claim about any id", async () => {
  await tombstoneBillingForReal();
  const index = await indexNow();
  await chmod(registryPath(), 0o000);
  const read = await readSectionRegistryState(root);
  expect(read.state).toBe("unreadable");

  // Even for an id that IS live in the index: an occupied address whose removal
  // record cannot be consulted is exactly where `found` was the lie.
  const live = resolveSectionIdentity(index, read, "keryx:page/architecture-order-placement#constraints");
  expect(live.kind).toBe("registry-unreadable");

  const refused = await syncSectionRegistry(root, index, { now: "2026-09-08T00:00:00.000Z" });
  expect(refused.status).toBe("refused");
  await chmod(registryPath(), 0o644);
});

test("an absent registry is not an unreadable one: a never-synced project still answers", async () => {
  const index = await indexNow();
  const read = await readSectionRegistryState(root);
  expect(read.state).toBe("absent");

  const live = resolveSectionIdentity(index, read, "keryx:page/architecture-order-placement#constraints");
  expect(live.kind).toBe("found");
  const missing = resolveSectionIdentity(index, read, "keryx:page/architecture-order-placement#no-such-id");
  expect(missing.kind).toBe("unknown");
});
