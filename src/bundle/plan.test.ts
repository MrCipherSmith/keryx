// Flow 313 (W4 portability), T6 — plan.ts: bucket assignment, force matching,
// the learned-pattern scope rule (W4-AC11), and checksum-failure short-circuit.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  test("existing file matches ledger but not incoming -> update", async () => {
    const oldBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.1.0" } }));
    const newBytes = Buffer.from(JSON.stringify({ schemaVersion: "1.0.0", hooks: {}, _keryxManaged: { tool: "keryx", version: "0.2.0" } }));
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), oldBytes);
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 1,
      entries: { "hooks.json": { bundleId: "prior", sha256: sha256Hex(oldBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z" } },
    });
    const entry = entryFor("hooks.json", "hook-config", "project", newBytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["hooks.json", newBytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {}, allowHooks: true });
    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.bucket).toBe("update");
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
  test("the rewritten ttl.expiresAt is derived from manifest.createdAt, deterministically across repeated plans", async () => {
    const record = learnedPatternRecord("user", "accepted");
    const bytes = Buffer.from(JSON.stringify(record));
    const entry = entryFor("learning/patterns/p1.json", "learned-pattern", "user", bytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([[entry.path, bytes]]) };
    const manifest = manifestOf([entry]); // createdAt: "2026-09-24T00:00:00.000Z" (see manifestOf above)

    const plan1 = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user" });
    expect(plan1.ok).toBe(true);
    const written1 = JSON.parse(plan1.entries[0]?.bytes.toString("utf8") ?? "{}") as { ttl?: { expiresAt: string } };
    expect(written1.ttl?.expiresAt).toBe("2026-10-24T00:00:00.000Z"); // createdAt + 30 days, not wall-clock now.

    // A SECOND plan of the exact same bundle (e.g. `inspect` right after
    // import, or a re-import) must produce byte-IDENTICAL rewritten content.
    const plan2 = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {}, targetScope: "user" });
    expect(plan2.entries[0]?.incomingSha256).toBe(plan1.entries[0]?.incomingSha256);
  });
});
