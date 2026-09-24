// Flow 313 (W4 portability), T6 — plan.ts: bucket assignment, force matching,
// the learned-pattern scope rule (W4-AC11), and checksum-failure short-circuit.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sha256Hex } from "./checksum";
import { writeAppliedState, appliedStatePath } from "./applied-state";
import { planBundleImport } from "./plan";
import { BUNDLE_FORMAT_VERSION, type BundleContentEntry, type BundleManifest } from "./types";
import type { BundleSource } from "./archive";

let root: string;
let projectRoot: string;
let homeDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-plan-"));
  projectRoot = path.join(root, "project");
  homeDir = path.join(root, "home");
  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function entryFor(bundlePath: string, kind: BundleContentEntry["kind"], scope: BundleContentEntry["scope"], bytes: Buffer): BundleContentEntry {
  return { path: bundlePath, kind, scope, sha256: sha256Hex(bytes), sizeBytes: bytes.length };
}

function manifestOf(entries: BundleContentEntry[]): BundleManifest {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId: "keryx-project-test",
    createdAt: "2026-09-24T00:00:00.000Z",
    sourceKeryxVersion: "0.2.999",
    provenance: { producedBy: "keryx bundle export", sourceScope: "project" },
    compat: { minKeryxVersion: "0.2.999", targetHarnesses: [] },
    contents: entries,
  };
}

describe("planBundleImport buckets", () => {
  test("no existing file -> new", async () => {
    const bytes = Buffer.from("---\nname: agent-a\ndescription: d\nrole: r\ntools: [read_file]\nmodel_tier: light\npolicy_profile: read-only\noutput_contract: subagent-result\n---\nbody\n");
    const entry = entryFor("agents/a.md", "agent", "project", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {} });
    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.bucket).toBe("new");
  });

  test("existing file matches incoming bytes -> identical", async () => {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.1.0" } }));
    const entry = entryFor("agents/a.md", "hook-config", "project", bytes);
    entry.path = "hooks.json";
    entry.kind = "hook-config";
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.bucket).toBe("identical");
  });

  test("existing file matches ledger, SAME bundle owns it, differs from incoming -> update", async () => {
    const oldBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.1.0" } }));
    const newBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.2.0" } }));
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), oldBytes);
    // manifestOf() below fixes bundleId to "keryx-project-test" — the ledger
    // record here uses the SAME id, so this is a genuine re-import of a
    // bundle updating its own previously-written file.
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "hooks.json": { bundleId: "keryx-project-test", sha256: sha256Hex(oldBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z" } },
    });
    const entry = entryFor("hooks.json", "hook-config", "project", newBytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", newBytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.bucket).toBe("update");
  });

  // R1-F1 (round 2 "still open"): content on disk is unchanged since a
  // DIFFERENT bundleId last applied it — this must NOT silently bucket
  // "update" (which apply would write, unconditionally transferring
  // ownership) but "conflict"/"owned-by-other-bundle", requiring --force.
  // Fails on the pre-fix code, which ignored ledgerRecord.bundleId entirely
  // here and bucketed "update".
  test("R1-F1: existing file matches ledger, but a DIFFERENT bundle owns it -> conflict owned-by-other-bundle", async () => {
    const oldBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.1.0" } }));
    const newBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.2.0" } }));
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), oldBytes);
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "hooks.json": { bundleId: "keryx-project-other-bundle", sha256: sha256Hex(oldBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z" } },
    });
    const entry = entryFor("hooks.json", "hook-config", "project", newBytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", newBytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(plan.ok).toBe(false);
    expect(plan.entries[0]?.bucket).toBe("conflict");
    expect(plan.entries[0]?.conflictReason).toBe("owned-by-other-bundle");
    expect(plan.refusals[0]?.reason).toBe("unresolved-conflict");

    // Forcing it through is still allowed (and would transfer ownership on
    // apply, which apply.ts already records unconditionally for a forced
    // write).
    const forcedPlan = await planBundleImport({
      source,
      manifest: manifestOf([entry]),
      projectRoot,
      homeDir,
      env: {},
      allowHooks: true,
      force: ["hooks.json"],
    });
    expect(forcedPlan.ok).toBe(true);
    expect(forcedPlan.entries[0]?.bucket).toBe("conflict");
    expect(forcedPlan.entries[0]?.conflictReason).toBe("owned-by-other-bundle");
    expect(forcedPlan.entries[0]?.forced).toBe(true);
  });

  test("existing file differs from ledger sha -> conflict user-modified, refused without force", async () => {
    const ledgerBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.1.0" } }));
    const humanBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.2.0" } }));
    const incomingBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.3.0" } }));
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), humanBytes);
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "hooks.json": { bundleId: "prior", sha256: sha256Hex(ledgerBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z" } },
    });
    const entry = entryFor("hooks.json", "hook-config", "project", incomingBytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", incomingBytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(plan.ok).toBe(false);
    expect(plan.entries[0]?.bucket).toBe("conflict");
    expect(plan.entries[0]?.conflictReason).toBe("user-modified");
    expect(plan.refusals.some((r) => r.reason === "unresolved-conflict")).toBe(true);
  });

  test("existing file differs from incoming with no ledger record -> conflict unmanaged-differs, forceable by targetRelative", async () => {
    const existingBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.1.0" } }));
    const incomingBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.2.0" } }));
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), existingBytes);
    const entry = entryFor("hooks.json", "hook-config", "project", incomingBytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", incomingBytes]]) };

    const unforced = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(unforced.ok).toBe(false);
    expect(unforced.entries[0]?.conflictReason).toBe("unmanaged-differs");

    const forced = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, force: ["hooks.json"], allowHooks: true });
    expect(forced.ok).toBe(true);
    expect(forced.entries[0]?.forced).toBe(true);
  });

  test("a --force value matching no entry is refused as unknown-force-path", async () => {
    const bytes = Buffer.from("content");
    const entry = entryFor("hooks.json", "hook-config", "project", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, force: ["no/such/path"], allowHooks: true });
    expect(plan.ok).toBe(false);
    expect(plan.refusals.some((r) => r.reason === "unknown-force-path")).toBe(true);
  });

  test("checksum mismatch short-circuits: no per-entry bucketing happens", async () => {
    const bytes = Buffer.from("content");
    const entry = entryFor("hooks.json", "hook-config", "project", bytes);
    entry.sha256 = "0".repeat(64); // wrong on purpose
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(plan.ok).toBe(false);
    expect(plan.entries).toEqual([]);
    expect(plan.refusals.some((r) => r.reason === "checksum-mismatch")).toBe(true);
  });
});

describe("planBundleImport learned-pattern scope rule", () => {
  function learnedPatternRecord(scope: "project" | "user", status: "candidate" | "accepted" = "accepted"): Record<string, unknown> {
    return {
      schemaVersion: 1,
      id: "p1",
      trigger: "when x happens across files",
      action: "always do y",
      domain: "tooling",
      scope,
      project: { identity: "a".repeat(64), identityKind: "path-hash" },
      confidence: 0.7,
      status,
      supersededBy: null,
      evidence: [{ kind: "reinforcement", sourceType: "observation", sourceRef: "obs/1.jsonl", observedAt: "2026-09-24T00:00:00.000Z" }],
      redaction: { scanned: true, findings: [] },
      provenance: { extractor: "repeated-correction" },
      createdAt: "2026-09-24T00:00:00.000Z",
      updatedAt: "2026-09-24T00:00:00.000Z",
    };
  }

  test("a project-scope entry with --target-scope user is refused", async () => {
    const record = learnedPatternRecord("project");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("data/learning/candidates/p1.json", "learned-pattern", "project", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, targetScope: "user" });
    expect(plan.ok).toBe(false);
    expect(plan.refusals.some((r) => r.reason === "learned-pattern-scope")).toBe(true);
  });

  test("a user-scope entry imported at user scope lands at status candidate even if the source recorded accepted", async () => {
    const record = learnedPatternRecord("user", "accepted");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("learning/patterns/p1.json", "learned-pattern", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, targetScope: "user" });
    expect(plan.ok).toBe(true);
    const written = JSON.parse(plan.entries[0]?.bytes.toString("utf8") ?? "{}");
    expect(written.status).toBe("candidate");
    expect(written.scope).toBe("user");
  });

  test("a user-scope entry with --target-scope project is refused", async () => {
    const record = learnedPatternRecord("user");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("learning/patterns/p1.json", "learned-pattern", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, targetScope: "project" });
    expect(plan.ok).toBe(false);
    expect(plan.refusals.some((r) => r.reason === "learned-pattern-scope")).toBe(true);
  });

  // R1-F25: the spec says `keryx learn accept` is the only command that may
  // leave a record `accepted` — pre-fix, the candidate rewrite ran only for
  // `scope: user`, so a project-scope record imported with `status:
  // "accepted"` landed in `data/learning/candidates/` still marked accepted.
  test("a project-scope entry imported at project scope also lands at status candidate", async () => {
    const record = learnedPatternRecord("project", "accepted");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("data/learning/candidates/p1.json", "learned-pattern", "project", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {} });
    expect(plan.ok).toBe(true);
    const written = JSON.parse(plan.entries[0]?.bytes.toString("utf8") ?? "{}");
    expect(written.status).toBe("candidate");
    expect(written.scope).toBe("project");
  });

  // R1-F11: the rewritten `ttl` must be derived from the bundle's own
  // `manifest.createdAt`, not wall-clock `Date.now()` — otherwise every plan
  // of the SAME bundle produces different bytes (a different `expiresAt`
  // millisecond), so `inspect` never reports `identical` right after a fresh
  // `import`, and a re-import silently pushes the TTL out another 30 days.
  // R2-F19 changed the formula to `max(createdAt, importDay) + 30d` — `now`
  // is pinned to the SAME instant as `manifest.createdAt` here so this test
  // stays deterministic regardless of the actual wall-clock date it runs on
  // (otherwise `importDay` would exceed `createdAt` on any day after this
  // fixture's date, and the fixed `expiresAt` assertion below would break).
  test("the rewritten ttl.expiresAt is derived from manifest.createdAt, deterministically across repeated plans", async () => {
    const record = learnedPatternRecord("user", "accepted");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("learning/patterns/p1.json", "learned-pattern", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const manifest = manifestOf([entry]); // createdAt: "2026-09-24T00:00:00.000Z" (see manifestOf above)
    const now = () => new Date("2026-09-24T00:00:00.000Z"); // same instant as createdAt

    const plan1 = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user", now });
    expect(plan1.ok).toBe(true);
    const written1 = JSON.parse(plan1.entries[0]?.bytes.toString("utf8") ?? "{}") as { ttl?: { expiresAt: string } };
    expect(written1.ttl?.expiresAt).toBe("2026-10-24T00:00:00.000Z"); // createdAt + 30 days, not wall-clock now.

    // A SECOND plan of the exact same bundle (e.g. `inspect` right after
    // import, or a re-import) must produce byte-IDENTICAL rewritten content.
    const plan2 = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user", now });
    expect(plan2.entries[0]?.incomingSha256).toBe(plan1.entries[0]?.incomingSha256);
  });

  // R2-F19: a bundle whose `createdAt` is already more than 30 days in the
  // past must not import learned patterns that are expired the moment they
  // land — `expiresAt` floors to `importDay + 30d`, not `createdAt + 30d`.
  // Fails on the round-1 fix (which used `createdAt + 30d` unconditionally).
  test("R2-F19: an old bundle's TTL floors to importDay + 30d, not createdAt + 30d", async () => {
    const record = learnedPatternRecord("user", "accepted");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("learning/patterns/p1.json", "learned-pattern", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const manifest = manifestOf([entry]); // createdAt: "2026-09-24T00:00:00.000Z"
    const now = () => new Date("2027-01-15T12:34:56.000Z"); // ~113 days after createdAt

    const plan = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user", now });
    expect(plan.ok).toBe(true);
    const written = JSON.parse(plan.entries[0]?.bytes.toString("utf8") ?? "{}") as { ttl?: { expiresAt: string } };
    // importDay (2027-01-15, floored to UTC midnight) + 30 days.
    expect(written.ttl?.expiresAt).toBe("2027-02-14T00:00:00.000Z");
    expect(new Date(written.ttl?.expiresAt ?? "").getTime()).toBeGreaterThan(now().getTime());
  });

  // R2-F19 (fix side effect): re-planning the SAME already-imported
  // learned-pattern content on a LATER day must still report `identical`,
  // not `update` — the on-disk file (written on day 1) and a freshly
  // rewritten candidate (computed on day 2) differ only in `ttl.expiresAt`.
  // Fails without the modulo-ttl comparison: the two `expiresAt` values are
  // one day apart, and a byte-for-byte sha comparison alone would bucket
  // `update` even though the semantic content is unchanged.
  test("R2-F19: re-planning identical content a day later still reports identical, not update", async () => {
    const record = learnedPatternRecord("user", "accepted");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("learning/patterns/p1.json", "learned-pattern", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const manifest = manifestOf([entry]);
    const day1 = () => new Date("2026-09-24T00:00:00.000Z");
    const day2 = () => new Date("2026-09-25T00:00:00.000Z");

    const plan1 = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user", now: day1 });
    expect(plan1.ok).toBe(true);
    expect(plan1.entries[0]?.bucket).toBe("new");
    mkdirSync(path.join(homeDir, ".keryx", "learning", "patterns"), { recursive: true });
    writeFileSync(path.join(homeDir, ".keryx", "learning", "patterns", "p1.json"), plan1.entries[0]?.bytes ?? Buffer.from(""));

    const plan2 = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user", now: day2 });
    expect(plan2.ok).toBe(true);
    expect(plan2.entries[0]?.bucket).toBe("identical");
  });

  // Orchestrator coordination note (L4's `checkPrivateDirGitignore(dir,
  // root?)` root parameter): plan.ts now passes the user store root, so a
  // symlink anywhere between it and `memory/` that escapes the store is
  // refused, not only a symlinked `memory/` itself. In THIS plan.ts call
  // site, `targetFor`'s own symlink-chain check (walking scope root ->
  // "memory", the same single segment `memoryRoot` sits under) already
  // refuses a symlinked `memory/` before the gitignore check is even
  // reached — so the plan refuses regardless, with `symlink-refused`. The
  // `root` parameter on `checkPrivateDirGitignore` is still wired here as
  // defense-in-depth (matching apply.ts, where its own check runs FIRST and
  // fires as `private-gitignore-conflict` — see apply.test.ts).
  test("user-scope memory-entry plan refuses when memory/'s parent chain contains a symlink escaping the store root", async () => {
    const storeRoot = path.join(homeDir, ".keryx");
    mkdirSync(storeRoot, { recursive: true });
    const outside = path.join(root, "outside-memory");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(storeRoot, "memory"));

    const bytes = Buffer.from("# lesson\n");
    const entry = entryFor("memory/lessons/a.md", "memory-entry", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, targetScope: "user" });
    expect(plan.ok).toBe(false);
    expect(plan.refusals.some((r) => r.reason === "symlink-refused" || r.reason === "private-gitignore-conflict")).toBe(true);
  });
});
