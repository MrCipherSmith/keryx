// Failing tests for Slate v3 (SLATE-22..26): the private, MCP-exposed
// external-hand slate lifecycle. Flow 182, task T2 — written BEFORE T3's
// implementation (`tdd-workflow.mdc`), against:
//   - `src/mcp/tools.ts`: three new tools `slate.open`/`slate.writeSeed`/
//     `slate.close` (module "slate") — NOT YET REGISTERED as of this write.
//   - `src/session/external-slate.ts` (new file, not yet created): storage
//     for `ExternalSlate` at `.keryx/external-slates/<externalSessionId>.json`.
//
// This file is expected to fail end-to-end until T3 lands: every test below
// resolves the tool via the same `tool(name)` helper `sac-tools.test.ts`
// uses (`buildToolRegistry().find(...)`), which throws `tool "slate.open" is
// not registered` today — the RED signal for this whole suite. Deliberately
// no import from `../session/external-slate` (it does not exist yet); every
// assertion instead reads the ON-DISK JSON directly at the spec's own fixed
// path (`docs/requirements/slate/specification.md` "Future storage
// structure" v3 addendum), which needs no stub to be typed against.
//
// Acceptance criteria mapped 1:1 (flow 182's `acceptance-criteria.md`;
// `AC-3x` is the same criterion's canonical number in the requirements
// docpack, `specification.md`):
//   AC1 (AC-34) cross-hand isolation      -> describe "AC1"
//   AC2 (AC-35) idempotent open           -> describe "AC2"
//   AC3 (AC-36) Anchors never enriched    -> describe "AC3"
//   AC4 (AC-37) Seed provenance always set -> describe "AC4"
//   AC5 (AC-38) no propose w/o workspaceId -> describe "AC5"
//   AC6 (AC-39) idle-TTL reclaim, no daemon -> describe "AC6"
//   AC7 (AC-40) non-goal preservation      -> describe "AC7"

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { buildToolRegistry, handleSlateOpen } from "./tools";
import { localWorkspaceAuthorizationServer, WorkspaceService, newWorkspaceId } from "../sac/workspace-service";
// Flow 182 T7, Finding 1 test only: test files are exempt from the M-3
// import-boundary guard (`mcp/boundary.test.ts` filters out `*.test.ts`), so
// this direct import (rather than the `../sac/service` facade `tools.ts`
// itself must use) is allowed here — needed to call `closeExternalSlate`
// with a deterministic, per-racer injected `now` (a testability seam this
// same T7 fix adds), which is the only reliable way to prove the race
// without depending on real-wall-clock timestamp-collision luck.
import { closeExternalSlate, reclaimStaleExternalSlates } from "../session/external-slate";
import type { ToolEntry } from "./types";

/**
 * Env var names `src/harness/provider/single-turn.ts`'s `hasCredential`
 * checks for every built-in/OpenAI-compatible provider this repo registers
 * (`src/commands/providers.ts`'s `OPENAI_COMPAT_PROVIDERS` + the three
 * hardcoded providers in `hasCredential` itself).
 */
const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "ZAI_API_KEY",
];

let cwd: string;
let savedCredentialEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "keryx-mcp-slate-tools-"));

  // Flow 182 T5 fix: `slate.open` now actually calls SLATE-16's
  // `resolveOrCreateWorkspace` (`src/sac/workspace-resolve.ts`) when
  // `workspaceId` is omitted. Its "existing workspaces non-empty" branch
  // makes a REAL, credential-gated `runModelTurn` call — which several
  // tests in this file trigger incidentally just by opening a SECOND
  // external slate (with no explicit `workspaceId`) in the same `cwd` after
  // a first slate.open already auto-created one. Deterministically forcing
  // `runModelTurn`'s fail-closed "no credential" branch for EVERY test in
  // this file (not just the new AC5-positive-path test below) is what keeps
  // this whole suite from depending on whatever real provider credentials
  // happen to be configured on the machine actually running it — this repo's
  // own `~/.local/share/keryx/auth.json` can carry a real, no-key-required
  // local provider (`rapid-mlx`, `requiresApiKey: false`) that
  // `resolveAutoProvider`'s first branch would otherwise pick automatically,
  // attempting a real HTTP call to a local endpoint that may not even be
  // running. Clears every known provider API-key env var AND redirects the
  // `keryxConfigDir`/`auth.json` lookup (`src/lib/config-dir.ts`) to a
  // nonexistent path via `XDG_DATA_HOME`/`APPDATA` (`loadShellConfig`
  // degrades to `{}` when the file is absent — never an error). Restored in
  // `afterEach` below. Production `slate.open`/`resolveOrCreateWorkspace`
  // behavior is completely unaffected — this only overrides this TEST
  // PROCESS's env for the duration of each test.
  savedCredentialEnv = {};
  for (const key of [...CREDENTIAL_ENV_KEYS, "XDG_DATA_HOME", "APPDATA"]) {
    savedCredentialEnv[key] = process.env[key];
    delete process.env[key];
  }
  const noSuchConfigDir = path.join(tmpdir(), "keryx-mcp-slate-tools-no-credentials-xdg");
  process.env.XDG_DATA_HOME = noSuchConfigDir;
  process.env.APPDATA = noSuchConfigDir;
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedCredentialEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function tool(name: string): ToolEntry {
  const found = buildToolRegistry().find((entry) => entry.name === name);
  if (!found) throw new Error(`tool "${name}" is not registered`);
  return found;
}

/** Mirrors `sac-tools.test.ts`'s own `createWorkspace` helper exactly — a
 * REAL, on-disk SAC workspace for the AC5-positive-path test below, so
 * `slate.close`'s later propose attempt has a real manifest to dispatch
 * against. */
async function createWorkspace(title: string): Promise<string> {
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  const id = newWorkspaceId();
  await service.create({ request: undefined, requestCorrelationId: randomUUID(), id, title });
  return id;
}

function externalSlatesDir(): string {
  return path.join(cwd, ".keryx", "external-slates");
}

function externalSlatePath(externalSessionId: string): string {
  return path.join(externalSlatesDir(), `${externalSessionId}.json`);
}

async function readExternalSlateFile(externalSessionId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(externalSlatePath(externalSessionId), "utf8")) as Record<string, unknown>;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively searches everything under `.keryx/` for a JSON file whose
 * parsed content has `recordType: "unbound-candidate"` — the same shape
 * `src/sac/machine-wrap-up.ts`'s `writeUnboundCandidateArtifact` already
 * produces for keryx-native sessions (`{ recordType, trigger, generatedAt,
 * groups }`). T3 decides the exact path an external slate's own
 * unbound-candidate artifact lives at (there is no `sessionDir()` to hang it
 * off, unlike the keryx-native path) — this helper intentionally does not
 * assume one, since AC5/AC6 only require the artifact to exist and be
 * findable, never that it be silently discarded.
 */
async function findUnboundCandidateArtifact(rootCwd: string): Promise<Record<string, unknown> | undefined> {
  return walk(path.join(rootCwd, ".keryx"));

  async function walk(dir: string): Promise<Record<string, unknown> | undefined> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await walk(full);
        if (nested !== undefined) return nested;
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>;
          if (parsed.recordType === "unbound-candidate") return parsed;
        } catch {
          // Not JSON, or unreadable mid-write — not a candidate, skip.
        }
      }
    }
    return undefined;
  }
}

/**
 * Same recursive search as `findUnboundCandidateArtifact`, for
 * `recordType: "wrap-up-outcome"` (`writeWrapUpOutcomeArtifact`,
 * `src/sac/machine-wrap-up.ts`) — records the FULL `WrapUpGroupOutcome[]` a
 * `runWrapUp` call produced. Used by the AC5-positive-path test below to
 * prove `slate.close` actually entered the propose branch (any group
 * outcome OTHER than `"unbound-candidate"`), without needing a real model
 * credential to reach a `"proposed"` outcome specifically.
 */
async function findWrapUpOutcomeArtifact(rootCwd: string): Promise<Record<string, unknown> | undefined> {
  return walk(path.join(rootCwd, ".keryx"));

  async function walk(dir: string): Promise<Record<string, unknown> | undefined> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const nested = await walk(full);
        if (nested !== undefined) return nested;
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>;
          if (parsed.recordType === "wrap-up-outcome") return parsed;
        } catch {
          // Not JSON, or unreadable mid-write — not a candidate, skip.
        }
      }
    }
    return undefined;
  }
}

/**
 * Same recursive walk as `findUnboundCandidateArtifact`, but collects EVERY
 * matching artifact instead of stopping at the first — used by the flow 182
 * T7 Finding-1 race test below to prove closing the same slate twice,
 * near-simultaneously, produces exactly ONE `unbound-candidate` artifact
 * (not two, which is what the pre-fix race produced).
 */
async function findAllUnboundCandidateArtifacts(rootCwd: string): Promise<Record<string, unknown>[]> {
  const found: Record<string, unknown>[] = [];
  await walk(path.join(rootCwd, ".keryx"));
  return found;

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const parsed = JSON.parse(await readFile(full, "utf8")) as Record<string, unknown>;
          if (parsed.recordType === "unbound-candidate") found.push(parsed);
        } catch {
          // Not JSON, or unreadable mid-write — not a candidate, skip.
        }
      }
    }
  }
}

describe("AC1 (AC-34): cross-hand isolation — a slate.* call for one externalSessionId never reads/lists/writes another's storage", () => {
  test("two external hands opening/writing in the same cwd each get exactly their own file, verified against real files on disk", async () => {
    const A = "ext-session-isolation-a";
    const B = "ext-session-isolation-b";

    await tool("slate.open").invoke(cwd, { externalSessionId: A, anchors: { root: "/hand-a/workdir" } }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: A, text: "A's private secret finding" }, { transport: "stdio" });

    const filesAfterA = (await readdir(externalSlatesDir())).sort();
    expect(filesAfterA).toEqual(["ext-session-isolation-a.json"]);

    await tool("slate.open").invoke(cwd, { externalSessionId: B, anchors: { root: "/hand-b/workdir" } }, { transport: "stdio" });
    const filesAfterB = (await readdir(externalSlatesDir())).sort();
    expect(filesAfterB).toEqual(["ext-session-isolation-a.json", "ext-session-isolation-b.json"]);

    const aParsed = await readExternalSlateFile(A);
    const bParsed = await readExternalSlateFile(B);
    expect(aParsed.externalSessionId).toBe(A);
    expect(bParsed.externalSessionId).toBe(B);
    expect(bParsed.seeds).toEqual([]);
    expect(JSON.stringify(bParsed)).not.toContain("A's private secret finding");
  });

  test("writing to A never touches B's file at all — not its content, not its mtime", async () => {
    const A = "ext-session-isolation-mtime-a";
    const B = "ext-session-isolation-mtime-b";
    await tool("slate.open").invoke(cwd, { externalSessionId: A, anchors: { root: "/a" } }, { transport: "stdio" });
    await tool("slate.open").invoke(cwd, { externalSessionId: B, anchors: { root: "/b" } }, { transport: "stdio" });

    const bStatBefore = await stat(externalSlatePath(B));
    const bRawBefore = await readFile(externalSlatePath(B), "utf8");

    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: A, text: "only for A" }, { transport: "stdio" });
    await tool("slate.close").invoke(cwd, { externalSessionId: A }, { transport: "stdio" });

    const bStatAfter = await stat(externalSlatePath(B));
    const bRawAfter = await readFile(externalSlatePath(B), "utf8");
    expect(bStatAfter.mtimeMs).toBe(bStatBefore.mtimeMs);
    expect(bRawAfter).toBe(bRawBefore);
  });

  test("a path-traversal-shaped externalSessionId is rejected, never written outside .keryx/external-slates/ (flow 182 T4 finding)", async () => {
    const outsideMarker = path.join(tmpdir(), `keryx-traversal-canary-${randomUUID()}.json`);
    const traversalId = `../../../../../../../..${outsideMarker}`.replace(/\.json$/, "");

    await expect(
      tool("slate.open").invoke(cwd, { externalSessionId: traversalId, anchors: { root: "/attacker" } }, { transport: "stdio" }),
    ).rejects.toThrow();

    expect(await pathExists(outsideMarker)).toBe(false);
    expect(await pathExists(`${traversalId}.json`)).toBe(false);
    // The legit external-slates dir must exist (created by an earlier
    // passing test's beforeEach setup or by this call's own reclaim pass)
    // but must never contain anything traversal-shaped.
    const entriesAfter = await pathExists(externalSlatesDir()) ? await readdir(externalSlatesDir()) : [];
    expect(entriesAfter.every((name) => !name.includes(".."))).toBe(true);

    await expect(
      tool("slate.writeSeed").invoke(cwd, { externalSessionId: traversalId, text: "should never land anywhere" }, { transport: "stdio" }),
    ).rejects.toThrow();
    await expect(
      tool("slate.close").invoke(cwd, { externalSessionId: traversalId }, { transport: "stdio" }),
    ).rejects.toThrow();
  });
});

describe("AC2 (AC-35): slate.open is idempotent per externalSessionId", () => {
  test("calling slate.open twice with the same id never creates a second file, never errors, and returns the existing unmodified state", async () => {
    const id = "ext-idempotent-open";
    const anchors = { root: "/work" };

    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "seed written before reopen" }, { transport: "stdio" });

    const filesAfterFirstOpen = await readdir(externalSlatesDir());
    expect(filesAfterFirstOpen).toEqual([`${id}.json`]);
    const rawBeforeReopen = await readFile(externalSlatePath(id), "utf8");

    const second = (await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors }, { transport: "stdio" })) as {
      seeds: Array<{ text: string }>;
    };

    const filesAfterSecondOpen = await readdir(externalSlatesDir());
    expect(filesAfterSecondOpen).toEqual([`${id}.json`]); // never a second file

    const rawAfterReopen = await readFile(externalSlatePath(id), "utf8");
    expect(rawAfterReopen).toBe(rawBeforeReopen); // unmodified on disk

    expect(second).toEqual(JSON.parse(rawBeforeReopen));
    // Reopening must never reset/clobber the Seed written before it.
    expect(second.seeds.map((s) => s.text)).toContain("seed written before reopen");
  });
});

describe("AC3 (AC-36): Anchors on an external slate are exactly what the caller supplied — never enriched", () => {
  test("slate.open stores the supplied anchors verbatim, with no keryx-native tree/runtime/fence fields added", async () => {
    const id = "ext-anchors-verbatim";
    const suppliedAnchors = { root: "/hand-own/workdir", touched: ["src/foo.ts"], note: "working on foo" };

    const opened = (await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: suppliedAnchors }, { transport: "stdio" })) as {
      anchors: Record<string, unknown>;
    };
    expect(opened.anchors).toEqual(suppliedAnchors);
    expect(opened.anchors).not.toHaveProperty("tree");
    expect(opened.anchors).not.toHaveProperty("runtime");
    expect(opened.anchors).not.toHaveProperty("fence");

    const persisted = await readExternalSlateFile(id);
    expect(persisted.anchors).toEqual(suppliedAnchors);
  });

  test("writing a Seed never enriches or mutates the anchors already on record", async () => {
    const id = "ext-anchors-untouched-by-seeds";
    const suppliedAnchors = { root: "/hand-own/workdir" };
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: suppliedAnchors }, { transport: "stdio" });

    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "a draft finding" }, { transport: "stdio" });
    const afterOneSeed = await readExternalSlateFile(id);
    expect(afterOneSeed.anchors).toEqual(suppliedAnchors);

    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "a second draft finding" }, { transport: "stdio" });
    const afterTwoSeeds = await readExternalSlateFile(id);
    expect(afterTwoSeeds.anchors).toEqual(suppliedAnchors);
  });
});

describe("AC4 (AC-37): every Seed written via slate.writeSeed carries server-set provenance the caller cannot override", () => {
  test("origin.harness and trust:\"external-unverified\" are always present, and a spoofed origin/trust in the call params is ignored", async () => {
    const id = "ext-provenance-spoof";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });

    await tool("slate.writeSeed").invoke(
      cwd,
      {
        externalSessionId: id,
        text: "a real finding, spoof attempt attached",
        origin: { harness: "SPOOFED-HARNESS", sessionRef: "spoofed-ref" },
        trust: "trusted",
      },
      { transport: "stdio" },
    );

    const persisted = await readExternalSlateFile(id);
    const seeds = persisted.seeds as Array<{ text: string; origin?: { harness: string; sessionRef?: string }; trust?: string }>;
    const seed = seeds.find((s) => s.text === "a real finding, spoof attempt attached");
    expect(seed).toBeDefined();
    expect(seed!.origin).toBeDefined();
    expect(typeof seed!.origin!.harness).toBe("string");
    expect(seed!.origin!.harness.length).toBeGreaterThan(0);
    // The caller's spoofed values must never win.
    expect(seed!.origin!.harness).not.toBe("SPOOFED-HARNESS");
    expect(seed!.origin!.sessionRef).not.toBe("spoofed-ref");
    expect(seed!.trust).toBe("external-unverified");
  });

  test("provenance is set the same way even with no spoofing attempt — it is always server-derived, not merely overridden when spoofed", async () => {
    const id = "ext-provenance-honest";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "an honest finding" }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "a second honest finding", kind: "follow-up" }, { transport: "stdio" });

    const persisted = await readExternalSlateFile(id);
    const seeds = persisted.seeds as Array<{ text: string; origin?: { harness: string }; trust?: string }>;
    expect(seeds).toHaveLength(2);
    for (const seed of seeds) {
      expect(seed.trust).toBe("external-unverified");
      expect(seed.origin).toBeDefined();
      expect(typeof seed.origin!.harness).toBe("string");
      expect(seed.origin!.harness.length).toBeGreaterThan(0);
    }
    // Same server-assigned harness identity across calls in the same slate's
    // life — not something the caller picks per call.
    expect(seeds[0]!.origin!.harness).toBe(seeds[1]!.origin!.harness);
  });
});

describe("AC5 (AC-38): slate.close never calls propose without a workspaceId bound earlier in the slate's life", () => {
  test("closing an unbound external slate writes a local unbound-candidate artifact instead of proposing, and no proposal is ever created", async () => {
    const id = "ext-unbound-close";
    // Flow 182 T5 fix: `slate.open` now actually calls SLATE-16's
    // resolve-or-create when `workspaceId` is omitted (see `handleSlateOpen`,
    // `./tools.ts`). Calling `tool("slate.open").invoke(...)` here (the REAL
    // resolver) would no longer leave `workspaceId` unset in a fresh temp
    // `cwd` — `resolveOrCreateWorkspace`'s own documented "empty workspace
    // list -> auto-create directly, no model call needed" branch
    // (`src/sac/workspace-resolve.ts`) would bind one every time, since a
    // fresh `cwd` always starts with zero workspaces. This test's whole
    // point is the GENUINELY-unbound path, so it injects a resolver that
    // fails (`ambiguous`) via `handleSlateOpen` directly — mirroring
    // `goal-command.test.ts`'s own "a resolver that fails/is ambiguous never
    // blocks /goal" injection — rather than relying on an omitted
    // `workspaceId` to stay unbound by accident.
    await handleSlateOpen({ cwd, externalSessionId: id, anchors: { root: "/work" }, resolveWorkspace: async () => ({ ok: false, reason: "ambiguous" }) });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "unbound candidate seed text" }, { transport: "stdio" });

    const result = await tool("slate.close").invoke(cwd, { externalSessionId: id }, { transport: "stdio" });
    expect(result).toBeDefined();

    // `workspace propose` always writes under `.metaproject/workspaces/<id>/`
    // (proposals + evidence) — that whole tree must never come into
    // existence when no workspaceId was ever bound to this slate.
    const workspacesDirExists = await pathExists(path.join(cwd, ".metaproject", "workspaces"));
    expect(workspacesDirExists).toBe(false);

    const artifact = await findUnboundCandidateArtifact(cwd);
    expect(artifact).toBeDefined();
    expect(artifact!.recordType).toBe("unbound-candidate");
    expect(JSON.stringify(artifact)).toContain("unbound candidate seed text");
  });

  test("an explicit workspaceId omitted at slate.open time still never gets guessed at close — the artifact path is taken even after multiple Seeds across kinds", async () => {
    const id = "ext-unbound-multi-kind";
    // Same fix as the test above: force the genuinely-unbound path via an
    // injected failing resolver, rather than an omitted `workspaceId` that
    // the REAL SLATE-16 resolver would now auto-bind in a fresh `cwd`.
    await handleSlateOpen({ cwd, externalSessionId: id, anchors: { root: "/work" }, resolveWorkspace: async () => ({ ok: false, reason: "no_credential" }) });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "risk finding", kind: "risk" }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "untagged finding" }, { transport: "stdio" });

    await tool("slate.close").invoke(cwd, { externalSessionId: id }, { transport: "stdio" });

    const workspacesDirExists = await pathExists(path.join(cwd, ".metaproject", "workspaces"));
    expect(workspacesDirExists).toBe(false);
    const artifact = await findUnboundCandidateArtifact(cwd);
    expect(artifact).toBeDefined();
  });
});

describe("AC5 positive path (flow 182 T5 fix): slate.open's SLATE-16 resolve-or-create seam actually binds a workspaceId, and slate.close then attempts propose instead of unbound-candidate", () => {
  // T3's original implementation never called SLATE-16's resolve-or-create
  // at all — `slate.open` always left `workspaceId` unset unless the caller
  // passed one explicitly, contradicting both `specification.md`'s v3 MCP
  // surface section ("`slate.open`'s no-`workspaceId` path calls SLATE-16's
  // existing resolve-or-create procedure, not a new one") and this flow's
  // own frozen AC5 text ("... explicit `slate.open` parameter OR SLATE-16
  // resolve-or-create"). The two tests above only prove the negative half
  // (a resolver that fails/is ambiguous leaves `workspaceId` unset); these
  // two prove the POSITIVE half actually fires: a resolver that succeeds
  // binds its `workspaceId`, and a later `slate.close` on that now-bound
  // slate genuinely attempts the propose/wrap-up path rather than silently
  // still falling back to unbound-candidate.

  test("slate.open with no explicit workspaceId, given a resolver that resolves ok, binds the resolved workspaceId — not left unset", async () => {
    const id = "ext-slate16-bound-open";
    const resolveCalls: Array<{ cwd: string; topicHint: string }> = [];

    const opened = await handleSlateOpen({
      cwd,
      externalSessionId: id,
      anchors: { root: "/work", note: "investigating the thing" },
      resolveWorkspace: async (input) => {
        resolveCalls.push(input);
        return { ok: true, workspaceId: "workspace-resolved-for-open", action: "created" };
      },
    });

    // The resolver was actually called (the T3 gap: it never was) — with
    // this slate's own cwd and a topic hint derived from its anchors, mirroring
    // `goal-command.test.ts`'s own `resolveCalls` assertion for the identical
    // SLATE-16 seam.
    expect(resolveCalls).toEqual([{ cwd, topicHint: "investigating the thing" }]);
    expect(opened.workspaceId).toBe("workspace-resolved-for-open");

    // And it is durably persisted, not just present on the returned value.
    const persisted = await readExternalSlateFile(id);
    expect(persisted.workspaceId).toBe("workspace-resolved-for-open");
  });

  test("slate.open never re-resolves on an idempotent re-open, even when a workspaceId was bound via the injected resolver the first time", async () => {
    const id = "ext-slate16-idempotent-reopen";
    let resolveCallCount = 0;
    const resolveWorkspace = async () => {
      resolveCallCount += 1;
      return { ok: true as const, workspaceId: "workspace-first-open", action: "created" as const };
    };

    const first = await handleSlateOpen({ cwd, externalSessionId: id, anchors: { root: "/work" }, resolveWorkspace });
    expect(first.workspaceId).toBe("workspace-first-open");
    expect(resolveCallCount).toBe(1);

    // AC2/AC-35's idempotency guarantee still holds with the SLATE-16 seam
    // wired in: a second `slate.open` for the SAME id returns the existing,
    // already-bound state unmodified — it must never re-resolve (which could
    // silently rebind a different workspace mid-slate-life).
    const second = await handleSlateOpen({ cwd, externalSessionId: id, anchors: { root: "/work" }, resolveWorkspace });
    expect(second.workspaceId).toBe("workspace-first-open");
    expect(resolveCallCount).toBe(1);
  });

  test("slate.close on a slate bound via the injected resolver actually attempts the propose/wrap-up path — never falls back to unbound-candidate", async () => {
    const id = "ext-slate16-bound-close";
    // A REAL, on-disk SAC workspace — the fake resolver below only replaces
    // SLATE-16's judgment step (which existing/new workspace to bind), not
    // the workspace itself; `slate.close`'s later propose attempt needs a
    // real manifest to dispatch against.
    const workspaceId = await createWorkspace("slate16-bound workspace");

    await handleSlateOpen({
      cwd,
      externalSessionId: id,
      anchors: { root: "/work" },
      resolveWorkspace: async () => ({ ok: true, workspaceId, action: "bound-existing" }),
    });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "bound-path seed text" }, { transport: "stdio" });

    await tool("slate.close").invoke(cwd, { externalSessionId: id }, { transport: "stdio" });

    // Never took the unbound-candidate branch — this is the actual behavior
    // difference AC5's full text requires and T3's implementation skipped.
    const unbound = await findUnboundCandidateArtifact(cwd);
    expect(unbound).toBeUndefined();

    // The propose branch DID run: `runWrapUp`'s bound-workspaceId branch
    // (`src/sac/machine-wrap-up.ts`) always writes a `wrap-up-outcome`
    // artifact recording one outcome per non-empty Seed-kind group, whose
    // `outcome` is never `"unbound-candidate"` on this branch (only
    // `"proposed"` / `"conflict"` / `"no_credential"` / `"error"` are
    // possible here) — this file's global `beforeEach` deterministically
    // forces the "no_credential" branch (no real model call, no network),
    // so the exact outcome is expected to be `"no_credential"`, but the
    // assertion below only pins "not the unbound-candidate skip", which is
    // the actual behavior this test is proving.
    const outcome = await findWrapUpOutcomeArtifact(cwd);
    expect(outcome).toBeDefined();
    const groups = outcome!.groups as Array<{ kind: string; outcome: string }>;
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.outcome).not.toBe("unbound-candidate");
    }
  });
});

describe("AC6 (AC-39): idle-TTL reclaim — a stale external slate is auto-closed on the next slate.* call touching this cwd, synchronously", () => {
  test("a slate whose lastWriteAt is older than the shared withFileLock stale-lock threshold is reclaimed by an UNRELATED hand's slate.open call in the same cwd", async () => {
    const staleId = "ext-stale-ttl";
    const freshId = "ext-fresh-trigger";
    // Flow 182 T5 fix: this test's whole point is that the STALE slate ends
    // up unbound so its reclaim takes the unbound-candidate path (never
    // `.metaproject/workspaces/`) — with the REAL SLATE-16 resolver now
    // actually wired in, an omitted `workspaceId` on a fresh `cwd`'s FIRST
    // `slate.open` would auto-bind one immediately (`resolveOrCreateWorkspace`'s
    // "empty workspace list -> create directly" branch), which would create
    // that very directory before reclaim ever runs and falsify this test's
    // own "never `.metaproject/workspaces`" assertion below — unrelated to
    // what this test actually exercises (idle-TTL reclaim mechanics). Both
    // opens below inject a failing resolver via `handleSlateOpen` directly
    // (same fix as the AC5 tests above) to keep this test isolated to ONLY
    // the idle-TTL behavior.
    const noBind = async () => ({ ok: false as const, reason: "ambiguous" as const });
    await handleSlateOpen({ cwd, externalSessionId: staleId, anchors: { root: "/stale-work" }, resolveWorkspace: noBind });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: staleId, text: "stale ttl seed text" }, { transport: "stdio" });

    // Backdate lastWriteAt directly on disk, well past `src/lib/fs.ts`'s
    // `DEFAULT_LOCK_STALE_MS` (30s) — 5 minutes is unambiguous regardless of
    // exactly how the comparison is implemented.
    const stalePayload = await readExternalSlateFile(staleId);
    stalePayload.lastWriteAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await writeFile(externalSlatePath(staleId), `${JSON.stringify(stalePayload, null, 2)}\n`, "utf8");

    // A DIFFERENT external hand's call touching the SAME cwd — not a call
    // naming staleId at all — is what AC6 says must trigger the reclaim.
    await handleSlateOpen({ cwd, externalSessionId: freshId, anchors: { root: "/fresh-work" }, resolveWorkspace: noBind });

    // The assertion runs immediately after that single `await`, with no
    // delay/poll of any kind — if the artifact already exists here, the
    // reclaim ran synchronously inside that one call, never via a background
    // timer/daemon (nothing in this test ever waits for one).
    const artifact = await findUnboundCandidateArtifact(cwd);
    expect(artifact).toBeDefined();
    expect(JSON.stringify(artifact)).toContain("stale ttl seed text");

    // The now-stale-and-reclaimed slate must not still read as an open,
    // live, unclosed slate with the same seed content once reclaimed — it
    // was dispatched (unbound-candidate), not silently left as-is.
    expect(await pathExists(path.join(cwd, ".metaproject", "workspaces"))).toBe(false);
  });

  test("a fresh (non-stale) external slate is left completely untouched by another hand's call in the same cwd", async () => {
    const freshId = "ext-not-stale";
    const otherId = "ext-other-trigger";
    await tool("slate.open").invoke(cwd, { externalSessionId: freshId, anchors: { root: "/fresh" } }, { transport: "stdio" });
    const rawBefore = await readFile(externalSlatePath(freshId), "utf8");

    await tool("slate.open").invoke(cwd, { externalSessionId: otherId, anchors: { root: "/other" } }, { transport: "stdio" });

    const rawAfter = await readFile(externalSlatePath(freshId), "utf8");
    expect(rawAfter).toBe(rawBefore);
  });
});

describe("AC7 (AC-40): non-goal preservation — 'no shared open slate between clients' holds structurally", () => {
  test("no slate.list/slate.read tool spanning multiple externalSessionIds is ever registered", () => {
    const names = buildToolRegistry().map((entry) => entry.name);
    expect(names).not.toContain("slate.list");
    expect(names).not.toContain("slate.read");
  });

  test("no slate.* tool call ever surfaces another hand's previously-written Seed text, in its response or its own storage", async () => {
    const A = "ext-nongoal-a";
    const B = "ext-nongoal-b";
    await tool("slate.open").invoke(cwd, { externalSessionId: A, anchors: { root: "/a" } }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: A, text: "hand A's confidential draft" }, { transport: "stdio" });

    const openedB = await tool("slate.open").invoke(cwd, { externalSessionId: B, anchors: { root: "/b" } }, { transport: "stdio" });
    expect(JSON.stringify(openedB)).not.toContain("hand A's confidential draft");

    const writtenB = await tool("slate.writeSeed").invoke(cwd, { externalSessionId: B, text: "hand B's own draft" }, { transport: "stdio" });
    expect(JSON.stringify(writtenB)).not.toContain("hand A's confidential draft");

    const closedB = await tool("slate.close").invoke(cwd, { externalSessionId: B }, { transport: "stdio" });
    expect(JSON.stringify(closedB)).not.toContain("hand A's confidential draft");

    // And the same holds on disk, not only in tool responses (AC1's own
    // filesystem-level requirement, restated here as the non-goal check).
    const bRaw = await readFile(externalSlatePath(B), "utf8");
    expect(bRaw).not.toContain("hand A's confidential draft");
  });
});

describe("slate.* transport policy (mirrors sac.* — local-stdio only, v1 has no verified HTTP principal policy)", () => {
  // Not one of AC1-AC7 (plan.md step 4's "local-stdio only, matching sac.*"
  // is an implementation detail, not a frozen acceptance criterion) — kept
  // loose (checks a denial code is returned, not sac.*'s exact
  // "sac_transport_denied" literal) so a reasonably-named "slate"-module
  // equivalent still passes without this test dictating T3's exact string.
  test("http transport is denied for all three tools, never proceeding to touch storage", async () => {
    for (const name of ["slate.open", "slate.writeSeed", "slate.close"]) {
      const result = (await tool(name).invoke(cwd, { externalSessionId: "ext-http-denied" }, { transport: "http" })) as { code?: string };
      expect(typeof result?.code).toBe("string");
      expect(result.code).toMatch(/denied/);
    }
    expect(await pathExists(externalSlatesDir())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flow 182 T7: fixes for six findings from two parallel review passes
// (review-security-code, review-logic) run after T3/T5/T6 landed the base
// implementation. See this flow's journal.md for each finding's full text.
// ---------------------------------------------------------------------------

describe("F-001 (BLOCKER, security): slate.writeSeed validates 'kind' at runtime — a bare 'as SlateSeedKind' cast is not enough", () => {
  test("an unrecognized/path-traversal-shaped 'kind' is rejected outright, never persisted", async () => {
    const id = "ext-invalid-kind";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });

    await expect(
      tool("slate.writeSeed").invoke(
        cwd,
        { externalSessionId: id, text: "attempted seed", kind: "../../../../../../../../tmp/pwned" },
        { transport: "stdio" },
      ),
    ).rejects.toThrow();

    const persisted = await readExternalSlateFile(id);
    expect(persisted.seeds).toEqual([]);
  });

  test("a plain, non-path-shaped but still unrecognized 'kind' is also rejected — not only traversal-shaped input", async () => {
    const id = "ext-invalid-kind-plain";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });

    await expect(
      tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "attempted seed", kind: "not-a-real-kind" }, { transport: "stdio" }),
    ).rejects.toThrow();

    const persisted = await readExternalSlateFile(id);
    expect(persisted.seeds).toEqual([]);
  });

  test("every real SlateSeedKind literal is still accepted and persisted", async () => {
    const id = "ext-valid-kinds";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });

    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "a risk finding", kind: "risk" }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "a decision finding", kind: "decision" }, { transport: "stdio" });

    const persisted = await readExternalSlateFile(id);
    const seeds = persisted.seeds as Array<{ text: string; kind?: string }>;
    expect(seeds.find((s) => s.text === "a risk finding")?.kind).toBe("risk");
    expect(seeds.find((s) => s.text === "a decision finding")?.kind).toBe("decision");
  });

  test("omitting 'kind' entirely is still allowed (it is optional)", async () => {
    const id = "ext-omitted-kind";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "no kind given" }, { transport: "stdio" });
    const persisted = await readExternalSlateFile(id);
    const seeds = persisted.seeds as Array<{ text: string; kind?: string }>;
    expect(seeds.find((s) => s.text === "no kind given")?.kind).toBeUndefined();
  });
});

describe("F-002 (MAJOR, security): slate.writeSeed redacts Seed text before persistence, matching slate_write_seed's existing behavior", () => {
  test("a secret-shaped text is redacted before it is ever written to disk", async () => {
    const id = "ext-redact-seed";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });

    // AWS access key ID shape — matches src/security/detect/secrets.ts's own
    // `AKIA|ASIA` + 16 uppercase-alnum-char detector.
    const secret = "AKIAABCD1234EFGH5678";
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: `found this credential: ${secret}` }, { transport: "stdio" });

    const persisted = await readExternalSlateFile(id);
    const seeds = persisted.seeds as Array<{ text: string }>;
    expect(seeds).toHaveLength(1);
    expect(seeds[0]!.text).not.toContain(secret);
    expect(seeds[0]!.text).toContain("[REDACTED:secret]");
  });

  test("ordinary, non-sensitive text is left completely unchanged by redaction", async () => {
    const id = "ext-redact-noop";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "a perfectly ordinary finding, no secrets here" }, { transport: "stdio" });
    const persisted = await readExternalSlateFile(id);
    const seeds = persisted.seeds as Array<{ text: string }>;
    expect(seeds[0]!.text).toBe("a perfectly ordinary finding, no secrets here");
  });
});

describe("F-003 (MAJOR, security): slate.writeSeed enforces a text length cap and a seeds-count cap on ExternalSlate", () => {
  test("text over SEED_TEXT_MAX_LENGTH (4000 chars, matching slate_write_seed's own bound) is rejected, never silently truncated", async () => {
    const id = "ext-oversized-text";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });
    const oversized = "x".repeat(4001);

    await expect(
      tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: oversized }, { transport: "stdio" }),
    ).rejects.toThrow();

    const persisted = await readExternalSlateFile(id);
    expect(persisted.seeds).toEqual([]);
  });

  test("text at exactly the cap is still accepted (the cap is inclusive)", async () => {
    const id = "ext-exact-cap-text";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });
    const atCap = "y".repeat(4000);
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: atCap }, { transport: "stdio" });
    const persisted = await readExternalSlateFile(id);
    expect((persisted.seeds as Array<{ text: string }>)[0]!.text).toBe(atCap);
  });

  test("the seeds count is capped at 200 — writing past the cap is rejected, not silently dropped", async () => {
    const id = "ext-seed-count-cap";
    await tool("slate.open").invoke(cwd, { externalSessionId: id, anchors: { root: "/work" } }, { transport: "stdio" });

    // Pre-populate 200 already-valid Seeds directly on disk (avoids 200
    // sequential tool-call round-trips just to reach the cap) — the same
    // on-disk shape `slate.writeSeed` itself would have produced.
    const existing = await readExternalSlateFile(id);
    existing.seeds = Array.from({ length: 200 }, (_, i) => ({
      id: `seed-${i}`,
      text: `pre-seeded ${i}`,
      ts: new Date().toISOString(),
      origin: { harness: "mcp-external" },
      trust: "external-unverified",
    }));
    await writeFile(externalSlatePath(id), `${JSON.stringify(existing, null, 2)}\n`, "utf8");

    await expect(
      tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "the 201st seed" }, { transport: "stdio" }),
    ).rejects.toThrow();

    const persisted = await readExternalSlateFile(id);
    expect((persisted.seeds as unknown[]).length).toBe(200);
  });
});

describe("F-007 (minor, security): reclaimStaleExternalSlates isolates a malformed entry so it never crashes the whole reclaim pass", () => {
  test("a corrupted/malformed external-slate file does not prevent other slate.* calls in the same cwd from succeeding", async () => {
    const goodId = "ext-reclaim-good";
    await tool("slate.open").invoke(cwd, { externalSessionId: goodId, anchors: { root: "/work" } }, { transport: "stdio" });

    // A manually-placed, malformed file directly under external-slates/ —
    // simulates the "manually-placed file with a bad name" scenario F-007's
    // own description names. `readExternalSlate` cannot swallow this (it only
    // catches ENOENT, per external-slate.ts's own doc comment) — it rethrows
    // a JSON.parse SyntaxError, which is exactly what a pre-fix
    // `reclaimStaleExternalSlates` let escape uncaught.
    await mkdir(externalSlatesDir(), { recursive: true });
    await writeFile(path.join(externalSlatesDir(), "malformed-entry.json"), "{ this is not valid json", "utf8");

    const otherId = "ext-reclaim-trigger";
    await expect(
      tool("slate.open").invoke(cwd, { externalSessionId: otherId, anchors: { root: "/other" } }, { transport: "stdio" }),
    ).resolves.toBeDefined();

    // Every OTHER slate.* handler must also still work, not just slate.open.
    await expect(
      tool("slate.writeSeed").invoke(cwd, { externalSessionId: goodId, text: "still works" }, { transport: "stdio" }),
    ).resolves.toBeDefined();
    await expect(
      tool("slate.close").invoke(cwd, { externalSessionId: otherId }, { transport: "stdio" }),
    ).resolves.toBeDefined();

    const persisted = await readExternalSlateFile(goodId);
    expect(persisted.externalSessionId).toBe(goodId);
  });
});

describe("Finding 1 (MAJOR, logic): closeExternalSlate holds ONE lock across read-check-act-mark-closed — no double-dispatch on a race", () => {
  test("two near-simultaneous slate.close calls for the SAME externalSessionId dispatch runWrapUp only once — exactly one unbound-candidate artifact exists afterward", async () => {
    const id = "ext-close-race";
    // Genuinely-unbound path (injected failing resolver — same reason the
    // AC5 tests above inject one): this test's point is the RACE, not
    // SLATE-16 auto-binding a workspace in a fresh temp cwd.
    await handleSlateOpen({ cwd, externalSessionId: id, anchors: { root: "/work" }, resolveWorkspace: async () => ({ ok: false, reason: "ambiguous" }) });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "race seed text" }, { transport: "stdio" });

    // The unbound-candidate artifact's filename is millisecond-timestamp
    // based (`writeUnboundCandidateArtifact`, `src/sac/machine-wrap-up.ts`),
    // not content-hash-deduped — so two racers whose `now()` reads happen to
    // land in the SAME millisecond would produce identically-named files,
    // where the second write's `rename()` simply overwrites the first,
    // masking a genuine double-dispatch as "only one file on disk" even on
    // UNFIXED code (real-wall-clock timing makes this collision plausible:
    // this unbound path's own read-check-act sequence involves no slow I/O
    // like a real `git diff` subprocess spawn, so it is naturally a very
    // TIGHT window). Rather than depend on real-clock timing luck to avoid
    // that collision, this test calls `closeExternalSlate` DIRECTLY (bypassing
    // the `slate.close` MCP tool's own `reclaimStaleExternalSlates`
    // preamble, which is irrelevant to this specific race) with two
    // DETERMINISTIC, guaranteed-different-millisecond `now` functions — one
    // per racer — a testability seam this same T7 fix adds to
    // `closeExternalSlate` (mirrors `resolveMachineWrapUp`/`runWrapUp`'s own
    // already-established optional `now` seam). Both calls still start via
    // the same `Promise.allSettled` (real concurrent interleaving, no
    // artificial delay), so this proves the actual race — not a timing
    // coincidence — while guaranteeing that IF a double-dispatch happens, it
    // is observable as two distinctly-named files rather than silently
    // colliding.
    const nowA = () => new Date("2026-01-01T00:00:00.000Z");
    const nowB = () => new Date("2026-01-01T00:00:00.500Z");
    const results = await Promise.allSettled([
      closeExternalSlate(cwd, id, "external-slate-close", nowA),
      closeExternalSlate(cwd, id, "external-slate-close", nowB),
    ]);
    // Neither concurrent call should itself reject — the lock makes the
    // second caller wait, then see an already-closed slate and no-op.
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const artifacts = await findAllUnboundCandidateArtifacts(cwd);
    expect(artifacts.length).toBe(1);
    expect(JSON.stringify(artifacts[0])).toContain("race seed text");

    const persisted = await readExternalSlateFile(id);
    expect(persisted.closedAt).toBeDefined();
  });

  test("the same race, triggered via two concurrent idle-TTL reclaim passes touching the same stale slate, still produces only one artifact", async () => {
    const staleId = "ext-close-race-reclaim";
    const noBind = async () => ({ ok: false as const, reason: "ambiguous" as const });
    await handleSlateOpen({ cwd, externalSessionId: staleId, anchors: { root: "/stale" }, resolveWorkspace: noBind });
    await tool("slate.writeSeed").invoke(cwd, { externalSessionId: staleId, text: "reclaim race seed text" }, { transport: "stdio" });

    const stalePayload = await readExternalSlateFile(staleId);
    stalePayload.lastWriteAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    await writeFile(externalSlatePath(staleId), `${JSON.stringify(stalePayload, null, 2)}\n`, "utf8");

    // Two DIFFERENT hands' reclaim passes touching the same cwd, both
    // observing the same third, stale, unrelated slate — exactly the shape
    // of race the finding describes. Same deterministic-`now`-per-racer
    // technique as the test above (`reclaimStaleExternalSlates`'s own `now`
    // param already existed; it is now threaded through to
    // `closeExternalSlate` by this same T7 fix) — anchored to REAL current
    // time (offset by 500ms between racers), not a fixed past date: the
    // staleness check (`isExternalSlateStale`) compares this SAME injected
    // `now` against `lastWriteAt`, which was backdated relative to the REAL
    // clock just above, so an unrelated fixed `now` would make the slate
    // read as "not stale yet" and the reclaim would never fire at all.
    const raceNowMs = Date.now();
    const nowA = () => new Date(raceNowMs);
    const nowB = () => new Date(raceNowMs + 500);
    const results = await Promise.allSettled([reclaimStaleExternalSlates(cwd, nowA), reclaimStaleExternalSlates(cwd, nowB)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const artifacts = await findAllUnboundCandidateArtifacts(cwd);
    expect(artifacts.length).toBe(1);
  });
});

describe("Finding 2 (MAJOR, logic): handleSlateOpen degrades gracefully when the injected resolver THROWS (not just returns ok:false)", () => {
  test("slate.open still succeeds, writes the ExternalSlate with the caller's anchors intact, and leaves workspaceId unset", async () => {
    const id = "ext-resolver-throws";
    const anchors = { root: "/work-throws", note: "investigating a throw" };

    const opened = await handleSlateOpen({
      cwd,
      externalSessionId: id,
      anchors,
      resolveWorkspace: async () => {
        throw new Error("simulated resolver failure — a real network/model-turn error, not ok:false");
      },
    });

    expect(opened.workspaceId).toBeUndefined();
    expect(opened.anchors).toEqual(anchors);
    expect(opened.seeds).toEqual([]);

    const persisted = await readExternalSlateFile(id);
    expect(persisted.workspaceId).toBeUndefined();
    expect(persisted.anchors).toEqual(anchors);
  });

  test("a resolver that throws does not affect a later slate.writeSeed/slate.close on the same slate", async () => {
    const id = "ext-resolver-throws-then-write";
    await handleSlateOpen({
      cwd,
      externalSessionId: id,
      anchors: { root: "/work" },
      resolveWorkspace: async () => {
        throw new Error("boom");
      },
    });

    await expect(
      tool("slate.writeSeed").invoke(cwd, { externalSessionId: id, text: "still works after a resolver throw" }, { transport: "stdio" }),
    ).resolves.toBeDefined();

    const workspacesDirExists = await pathExists(path.join(cwd, ".metaproject", "workspaces"));
    await expect(tool("slate.close").invoke(cwd, { externalSessionId: id }, { transport: "stdio" })).resolves.toBeDefined();
    expect(workspacesDirExists).toBe(false);
  });
});
