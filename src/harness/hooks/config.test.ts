import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadHookConfig, validateHookConfigDocument } from "./config";
import { BUILTIN_HOOK_IDS } from "./builtins";
import type { HooksTrustStore } from "./trust";

const DOCS_SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "requirements",
  "keryx-agent-platform-expansion",
  "schemas",
  "hook-config.schema.json",
);
const RUNTIME_SCHEMA_PATH = path.join(__dirname, "hook-config.schema.json");

function makeReadFile(files: Record<string, string>): (p: string) => string | undefined {
  return (p: string) => files[p];
}

/**
 * Build a trust store that trusts `projectRoot`'s current `.metaproject/hooks.json`
 * — a first (untrusted) load's own `projectHooks.digest`/`trustKey` is the
 * source of truth for what "trusted" means, so this never hand-computes a
 * digest that could drift from `digestProjectHooks`'s own algorithm.
 */
function trustStoreFor(readFile: (p: string) => string | undefined, projectRoot: string, homeDir: string): HooksTrustStore {
  const first = loadHookConfig({ projectRoot, homeDir, readFile });
  if (!first.ok || first.projectHooks.digest === undefined) return {};
  return {
    [first.projectHooks.trustKey]: {
      digest: first.projectHooks.digest,
      trustedAt: new Date().toISOString(),
      hookIds: first.projectHooks.hooks.map((h) => h.id),
    },
  };
}

const HOME = "/home/tester";
const PROJECT = "/proj";
const USER_PATH = path.join(HOME, ".keryx", "hooks.json");
const PROJECT_PATH = path.join(PROJECT, ".metaproject", "hooks.json");

describe("hook-config.schema.json runtime copy", () => {
  test("is byte-identical to the docs schema", () => {
    const docs = readFileSync(DOCS_SCHEMA_PATH, "utf8");
    const runtime = readFileSync(RUNTIME_SCHEMA_PATH, "utf8");
    expect(runtime).toBe(docs);
  });
});

describe("loadHookConfig", () => {
  test("absent files load as empty; only built-ins are registered", () => {
    const result = loadHookConfig({ projectRoot: PROJECT, homeDir: HOME, readFile: makeReadFile({}) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ids = new Set(result.registrations.map((r) => r.id));
    for (const id of BUILTIN_HOOK_IDS) {
      expect(ids.has(id)).toBe(true);
    }
    expect(result.registrations.every((r) => r.scope === "builtin")).toBe(true);
  });

  test("invalid JSON fails closed", () => {
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: "{ not json" }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "invalid-json")).toBe(true);
  });

  test("unknown major schemaVersion fails closed", () => {
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify({ schemaVersion: "2.0.0", hooks: {} }) }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "unknown-schema-version")).toBe(true);
  });

  test("schema-invalid document fails closed", () => {
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({
        [PROJECT_PATH]: JSON.stringify({ schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "x" }] } }),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "schema-invalid")).toBe(true);
  });

  test("a full registration id colliding with a built-in is rejected with the named code", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "keryx.ctx-guard",
            matcher: "Bash",
            class: "gate",
            command: { argv: ["echo", "hi"] },
          },
        ],
      },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "hook-id-collides-with-builtin")).toBe(true);
  });

  test("a full registration with a valid custom id merges over the built-ins", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          {
            id: "my-custom-gate",
            matcher: "Bash",
            class: "gate",
            command: { argv: ["echo", "hi"] },
          },
        ],
      },
    };
    const readFile = makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) });
    const store = trustStoreFor(readFile, PROJECT, HOME);
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile,
      projectTrust: { store },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectHooks.state).toBe("trusted");
    const custom = result.registrations.find((r) => r.id === "my-custom-gate");
    expect(custom).toBeDefined();
    expect(custom?.scope).toBe("project");
    // Still ordered after the built-ins for the same event.
    const ctxGuardOrder = result.registrations.find((r) => r.id === "keryx.ctx-guard")?.order ?? -1;
    expect(custom!.order).toBeGreaterThan(ctxGuardOrder);
  });

  test("R700-01: an untrusted project command hook is excluded from registrations and reported in projectHooks", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "my-custom-gate", matcher: "Bash", class: "gate", command: { argv: ["echo", "hi"] } }],
      },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projectHooks.state).toBe("untrusted");
    expect(result.registrations.some((r) => r.id === "my-custom-gate")).toBe(false);
    expect(result.projectHooks.hooks.some((h) => h.id === "my-custom-gate")).toBe(true);
  });

  test("R700-01: trusted project hooks load; changing argv makes the state changed and excludes them again", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "my-custom-gate", matcher: "Bash", class: "gate", command: { argv: ["echo", "hi"] } }],
      },
    };
    const readFile = makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) });
    const store = trustStoreFor(readFile, PROJECT, HOME);

    const trusted = loadHookConfig({ projectRoot: PROJECT, homeDir: HOME, readFile, projectTrust: { store } });
    expect(trusted.ok).toBe(true);
    if (!trusted.ok) return;
    expect(trusted.projectHooks.state).toBe("trusted");
    expect(trusted.registrations.some((r) => r.id === "my-custom-gate")).toBe(true);

    const changedDoc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "my-custom-gate", matcher: "Bash", class: "gate", command: { argv: ["echo", "bye"] } }],
      },
    };
    const changedReadFile = makeReadFile({ [PROJECT_PATH]: JSON.stringify(changedDoc) });
    const changed = loadHookConfig({ projectRoot: PROJECT, homeDir: HOME, readFile: changedReadFile, projectTrust: { store } });
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.projectHooks.state).toBe("changed");
    expect(changed.registrations.some((r) => r.id === "my-custom-gate")).toBe(false);
  });

  test("user hooks load regardless of project trust", () => {
    const userDoc = {
      schemaVersion: "1.0.0",
      hooks: { PreToolUse: [{ id: "user-gate", matcher: "Bash", class: "gate", command: { argv: ["echo", "hi"] } }] },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [USER_PATH]: JSON.stringify(userDoc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registrations.some((r) => r.id === "user-gate")).toBe(true);
  });

  for (const gateId of ["keryx.ctx-guard", "keryx.security-check-input", "keryx.security-check-output", "keryx.impact-evidence"]) {
    test(`a project disable of protected built-in ${gateId} is ignored with a warning and the load stays ok`, () => {
      const doc = { schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: gateId, enabled: false }], UserPromptSubmit: [{ id: gateId, enabled: false }] } };
      const result = loadHookConfig({
        projectRoot: PROJECT,
        homeDir: HOME,
        readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const target = result.registrations.find((r) => r.id === gateId);
      expect(target?.enabled).toBe(true);
      expect(result.warnings.some((w) => w.code === "project-gate-disable-ignored" && w.path === gateId)).toBe(true);
    });
  }

  test("a trusted project still cannot disable a gate", () => {
    const doc = { schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "keryx.ctx-guard", enabled: false }] } };
    const readFile = makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) });
    // No full registrations here, so nothing to trust — but the disable
    // override still must be refused regardless of trust state.
    const result = loadHookConfig({ projectRoot: PROJECT, homeDir: HOME, readFile });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registrations.find((r) => r.id === "keryx.ctx-guard")?.enabled).toBe(true);
  });

  test("a project disable of keryx.learning-observer is honoured", () => {
    const doc = { schemaVersion: "1.0.0", hooks: { SessionStart: [{ id: "keryx.learning-observer", enabled: false }] } };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const target = result.registrations.find((r) => r.id === "keryx.learning-observer" && r.event === "SessionStart");
    expect(target?.enabled).toBe(false);
  });

  test("a user gate disable without acknowledge is ignored with a warning", () => {
    const doc = { schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "keryx.ctx-guard", enabled: false }] } };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [USER_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registrations.find((r) => r.id === "keryx.ctx-guard")?.enabled).toBe(true);
    expect(result.warnings.some((w) => w.code === "gate-disable-unacknowledged")).toBe(true);
  });

  test("a user gate disable with acknowledge disables it and is listed in disabledBuiltinGates", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: { PreToolUse: [{ id: "keryx.ctx-guard", enabled: false, acknowledge: "disable-builtin-gate" }] },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [USER_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.registrations.find((r) => r.id === "keryx.ctx-guard")?.enabled).toBe(false);
    expect(result.disabledBuiltinGates.some((g) => g.id === "keryx.ctx-guard")).toBe(true);
  });

  test("acknowledge on a full registration is schema-invalid", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [
          { id: "my-gate", matcher: "Bash", class: "gate", command: { argv: ["echo", "hi"] }, acknowledge: "disable-builtin-gate" },
        ],
      },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(false);
  });

  test("an invalid untrusted project file still fails the load (ok:false)", () => {
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify({ schemaVersion: "1.0.0", hooks: { PreToolUse: [{ id: "x" }] } }) }),
    });
    expect(result.ok).toBe(false);
  });

  test("duplicate full-registration ids across user/project for one event are rejected", () => {
    const reg = {
      id: "shared-id",
      matcher: "Bash",
      class: "gate",
      command: { argv: ["echo", "hi"] },
    };
    const userDoc = { schemaVersion: "1.0.0", hooks: { PreToolUse: [reg] } };
    const projectDoc = { schemaVersion: "1.0.0", hooks: { PreToolUse: [reg] } };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({
        [USER_PATH]: JSON.stringify(userDoc),
        [PROJECT_PATH]: JSON.stringify(projectDoc),
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.some((d) => d.code === "hook-id-duplicate")).toBe(true);
  });

  test("a disable-only override disables a built-in by id (user file, learning-observer needs no acknowledge)", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        SessionStart: [{ id: "keryx.learning-observer", enabled: false }],
      },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [USER_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const observer = result.registrations.find((r) => r.id === "keryx.learning-observer" && r.event === "SessionStart");
    expect(observer?.enabled).toBe(false);
  });

  test("R700-02: a later-layer disable of a protected built-in from a project file is ignored, not applied", () => {
    // Per D10/D12 a project file can never disable a built-in GATE — this
    // used to prove the generic id-lookup merge mechanism by disabling a
    // built-in from the project layer; now it proves the tighten-only rule
    // refuses exactly that, with a warning rather than a silent no-op.
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        UserPromptSubmit: [{ id: "keryx.security-check-input", enabled: false }],
      },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hook = result.registrations.find((r) => r.id === "keryx.security-check-input");
    expect(hook?.enabled).toBe(true);
    expect(result.warnings.some((w) => w.code === "project-gate-disable-ignored")).toBe(true);
  });

  test("real fs read: absent hooks.json files load cleanly", () => {
    const result = loadHookConfig({ projectRoot: "/definitely/does/not/exist/xyz", homeDir: "/also/missing/xyz" });
    expect(result.ok).toBe(true);
  });
});

describe("validateHookConfigDocument", () => {
  test("valid empty document", () => {
    const result = validateHookConfigDocument({ schemaVersion: "1.0.0", hooks: {} });
    expect(result.valid).toBe(true);
  });

  test("rejects unknown top-level keys", () => {
    const result = validateHookConfigDocument({ schemaVersion: "1.0.0", hooks: {}, extra: true });
    expect(result.valid).toBe(false);
  });
});
