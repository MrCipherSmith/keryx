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
      schemaVersion: 2,
      entries: { "hooks.json": { bundleId: "keryx-project-test", sha256: sha256Hex(oldBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z", path: "hooks.json" } },
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
      schemaVersion: 2,
      entries: { "hooks.json": { bundleId: "keryx-project-other-bundle", sha256: sha256Hex(oldBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z", path: "hooks.json" } },
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

  // Choke point b (R3-F2): the ledger key is the CANONICAL (case-folded)
  // form of the path — a bundle shipping a CASE-VARIANT of a path another
  // bundle already owns (`rules/X.md` vs the owner's `rules/x.md`) must be
  // recognized as the SAME on-disk file, not planned as an independent
  // `new` entry that would silently create a second, colliding ledger
  // record.
  test("R3-F2: a case-variant path from a different bundle conflicts against the same owned file, not a fresh `new`", async () => {
    const bytesA = Buffer.from("# owner\n");
    const bytesB = Buffer.from("# other bundle, different case\n");
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "rules"), { recursive: true });
    writeFileSync(path.join(dir, "rules", "x.md"), bytesA); // on-disk path is lower-case
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 2,
      entries: { "rules/x.md": { bundleId: "bundle-a", sha256: sha256Hex(bytesA), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z", path: "rules/x.md" } },
    });

    const entryB = entryFor("rules/X.md", "rule", "project", bytesB); // bundle B ships the UPPER-case path
    const manifestB: BundleManifest = { ...manifestOf([entryB]), bundleId: "bundle-b" };
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["rules/X.md", bytesB]]) };
    const plan = await planBundleImport({ source, manifest: manifestB, projectRoot, homeDir, env: {} });

    expect(plan.ok).toBe(false);
    expect(plan.entries[0]?.bucket).toBe("conflict");
    expect(plan.entries[0]?.conflictReason).toBe("owned-by-other-bundle");
    expect(plan.entries[0]?.previousOwnerBundleId).toBe("bundle-a");
  });

  // R3-F2 follow-up: same scenario as above, but the on-disk file exists
  // ONLY under the ledger's recorded case — never at the incoming entry's
  // exact case at all. On a case-INSENSITIVE filesystem this is identical
  // to the test above (the OS resolves either spelling to the one file); on
  // a case-SENSITIVE one, `readFile` at the incoming case would ENOENT.
  // Simulated here (rather than relying on the host FS actually being
  // case-sensitive) by asserting the ledger-ownership outcome does not
  // depend on whether the file is reachable at the incoming case at all —
  // this must conflict either way, never bucket `new`.
  test("R3-F2: a case-variant path from a different bundle conflicts even though the incoming exact case never resolves on disk", async () => {
    const bytesA = Buffer.from("# owner, only reachable under the recorded case\n");
    const bytesB = Buffer.from("# other bundle, different case, never lands on disk at all\n");
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "rules"), { recursive: true });
    writeFileSync(path.join(dir, "rules", "owned.md"), bytesA); // ONLY this exact case exists on disk
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 2,
      entries: { "rules/owned.md": { bundleId: "bundle-a", sha256: sha256Hex(bytesA), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z", path: "rules/owned.md" } },
    });

    // Bundle B ships a case-variant path that shares the SAME canonical key
    // but, unlike the test above, is spelled so it cannot plausibly exist on
    // disk under that exact case (the recorded file is "owned.md"; this one
    // asks for "OWNED.md") — the fix must not depend on a lucky case-fold.
    // (The extension itself stays lower-case: the kind-shape check for
    // "rule" paths matches `\.(md|mdc)$` case-sensitively, unrelated to the
    // canonical-key ownership fix under test here.)
    const entryB = entryFor("rules/OWNED.md", "rule", "project", bytesB);
    const manifestB: BundleManifest = { ...manifestOf([entryB]), bundleId: "bundle-b" };
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["rules/OWNED.md", bytesB]]) };
    const plan = await planBundleImport({ source, manifest: manifestB, projectRoot, homeDir, env: {} });

    expect(plan.ok).toBe(false);
    expect(plan.entries[0]?.bucket).toBe("conflict");
    expect(plan.entries[0]?.conflictReason).toBe("owned-by-other-bundle");
    expect(plan.entries[0]?.previousOwnerBundleId).toBe("bundle-a");
  });

  // Follow-up to R3-F2's ownership check: when the SAME bundle (not a
  // different one) ships a different case of a path it already owns, that
  // must be treated as the SAME logical target, not a fresh `new` entry
  // that would create a second, case-variant file alongside the one the
  // ledger already tracks. Required behaviour, chosen and documented here:
  // the plan retargets to the ledger's own recorded path (`targetRelative`/
  // `targetPath`/`displayId` all reflect the RECORDED case, not the
  // incoming one) so apply writes, and uninstall removes, exactly one file
  // — never two — regardless of host filesystem case sensitivity.
  test("R3-F2 follow-up: the SAME bundle shipping a case-variant of a path it already owns retargets to the recorded path, not a fresh `new`", async () => {
    const oldBytes = Buffer.from("# team policy, recorded lower-case\n");
    const newBytes = Buffer.from("# team policy, updated content\n");
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "rules"), { recursive: true });
    writeFileSync(path.join(dir, "rules", "team.md"), oldBytes); // ONLY this exact case exists on disk
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 2,
      entries: { "rules/team.md": { bundleId: "keryx-project-test", sha256: sha256Hex(oldBytes), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z", path: "rules/team.md" } },
    });

    // manifestOf() fixes bundleId to "keryx-project-test" — same bundle,
    // re-exported with a different case for this one path.
    const entry = entryFor("rules/Team.md", "rule", "project", newBytes);
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["rules/Team.md", newBytes]]) };
    const plan = await planBundleImport({ source, manifest: manifestOf([entry]), projectRoot, homeDir, env: {} });

    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.bucket).toBe("update");
    // Retargeted: the recorded on-disk case wins, not the incoming one.
    expect(plan.entries[0]?.targetRelative).toBe("rules/team.md");
    expect(plan.entries[0]?.displayId).toBe("project:rules/team.md");
    expect(plan.entries[0]?.targetPath).toBe(path.join(dir, "rules", "team.md"));
  });

  // Flow 313 (W4) round-4 review R4-F6: a FORCED cross-bundle case-variant
  // transfer must retarget to the ledger's own recorded path, exactly like
  // the same-bundle case above — not just conflict/allow-with-force while
  // staying pointed at the incoming case. Pre-fix, `effectiveTargetRelative`
  // stayed at the incoming path whenever `ledgerOwnedByOther` was true, so
  // `apply` wrote a SECOND file at the incoming case (a case-sensitive
  // filesystem never folds "OWNED.md" onto "owned.md") while the ledger kept
  // only one record — for the new file. The previous owner's file, still on
  // disk at its own recorded case, was left with no record pointing at it:
  // stranded. Fails on pre-fix code (`targetRelative`/`targetPath` would be
  // the incoming "rules/OWNED.md", a path that shares no on-disk file with
  // the recorded "rules/owned.md" on a case-sensitive filesystem).
  test("R4-F6: a forced cross-bundle case-variant transfer retargets to the recorded path, not the incoming case", async () => {
    const bytesA = Buffer.from("# bundle A, recorded lower-case\n");
    const bytesB = Buffer.from("# bundle B, forced takeover, different case\n");
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "rules"), { recursive: true });
    writeFileSync(path.join(dir, "rules", "owned.md"), bytesA); // ONLY this exact case exists on disk
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 2,
      entries: { "rules/owned.md": { bundleId: "bundle-a", sha256: sha256Hex(bytesA), kind: "rule", appliedAt: "2026-01-01T00:00:00.000Z", path: "rules/owned.md" } },
    });

    const entryB = entryFor("rules/OWNED.md", "rule", "project", bytesB);
    const manifestB: BundleManifest = { ...manifestOf([entryB]), bundleId: "bundle-b" };
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["rules/OWNED.md", bytesB]]) };
    // `--force` matches the RETARGETED path (as reported by an unforced
    // plan's conflict, both as `targetRelative` and `displayId`) — the same
    // rule an unforced same-bundle retarget already follows.
    const plan = await planBundleImport({
      source,
      manifest: manifestB,
      projectRoot,
      homeDir,
      env: {},
      force: ["rules/owned.md"],
    });

    expect(plan.ok).toBe(true);
    expect(plan.entries[0]?.bucket).toBe("conflict");
    expect(plan.entries[0]?.conflictReason).toBe("owned-by-other-bundle");
    expect(plan.entries[0]?.forced).toBe(true);
    // Retargeted to the previous owner's recorded case, so apply overwrites
    // the SAME file rather than creating a second, case-variant one.
    expect(plan.entries[0]?.targetRelative).toBe("rules/owned.md");
    expect(plan.entries[0]?.displayId).toBe("project:rules/owned.md");
    expect(plan.entries[0]?.targetPath).toBe(path.join(dir, "rules", "owned.md"));
  });

  // R3-F18: a bundle DECLARING the same bundleId as a previously-applied
  // bundle is not proof it is the same producer — a hand-crafted bundle can
  // trivially spoof any bundleId string. When the ledger record carries a
  // `sourceProject` (recorded from `provenance.sourceProject` at apply
  // time) that differs from this import's OWN `provenance.sourceProject`,
  // the id is being reused across two different sources: treated as an
  // ownership conflict needing `--force`, not a silent same-bundle update.
  test("R3-F18: the same declared bundleId with a DIFFERENT provenance.sourceProject is a conflict, not a silent update", async () => {
    const original = Buffer.from("# original team policy\n");
    const spoofed = Buffer.from("# replaced by a different source claiming the same id\n");
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "rules"), { recursive: true });
    writeFileSync(path.join(dir, "rules", "team.md"), original);
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 2,
      entries: {
        "rules/team.md": {
          bundleId: "keryx-project-0123456789ab",
          sha256: sha256Hex(original),
          kind: "rule",
          appliedAt: "2026-01-01T00:00:00.000Z",
          path: "rules/team.md",
          sourceProject: "sha256:original-source",
        },
      },
    });

    const entry = entryFor("rules/team.md", "rule", "project", spoofed);
    const manifest: BundleManifest = {
      ...manifestOf([entry]),
      bundleId: "keryx-project-0123456789ab", // SAME id
      provenance: { producedBy: "keryx bundle export", sourceScope: "project", sourceProject: "sha256:different-source" },
    };
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["rules/team.md", spoofed]]) };
    const plan = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {} });

    expect(plan.ok).toBe(false);
    expect(plan.entries[0]?.bucket).toBe("conflict");
    expect(plan.entries[0]?.conflictReason).toBe("owned-by-other-bundle");
    expect(plan.entries[0]?.previousOwnerSourceProject).toBe("sha256:original-source");
  });

  test("R3-F18: the same declared bundleId with the SAME provenance.sourceProject updates normally", async () => {
    const original = Buffer.from("# original team policy\n");
    const updated = Buffer.from("# updated by the SAME source\n");
    const dir = path.join(projectRoot, ".metaproject");
    mkdirSync(dir, { recursive: true });
    mkdirSync(path.join(dir, "rules"), { recursive: true });
    writeFileSync(path.join(dir, "rules", "team.md"), original);
    await writeAppliedState(appliedStatePath("project", { projectRoot, homeDir, env: {} }), {
      schemaVersion: 2,
      entries: {
        "rules/team.md": {
          bundleId: "keryx-project-0123456789ab",
          sha256: sha256Hex(original),
          kind: "rule",
          appliedAt: "2026-01-01T00:00:00.000Z",
          path: "rules/team.md",
          sourceProject: "sha256:same-source",
        },
      },
    });

    const entry = entryFor("rules/team.md", "rule", "project", updated);
    const manifest: BundleManifest = {
      ...manifestOf([entry]),
      bundleId: "keryx-project-0123456789ab",
      provenance: { producedBy: "keryx bundle export", sourceScope: "project", sourceProject: "sha256:same-source" },
    };
    const source: BundleSource = { kind: "directory", manifestBytes: Buffer.from(""), files: new Map([["rules/team.md", updated]]) };
    const plan = await planBundleImport({ source, manifest, projectRoot, homeDir, env: {} });

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
      schemaVersion: 2,
      entries: { "hooks.json": { bundleId: "prior", sha256: sha256Hex(ledgerBytes), kind: "hook-config", appliedAt: "2026-01-01T00:00:00.000Z", path: "hooks.json" } },
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
