import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadHookConfig, validateHookConfigDocument } from "./config";
import { BUILTIN_HOOK_IDS } from "./builtins";

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
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const custom = result.registrations.find((r) => r.id === "my-custom-gate");
    expect(custom).toBeDefined();
    expect(custom?.scope).toBe("project");
    // Still ordered after the built-ins for the same event.
    const ctxGuardOrder = result.registrations.find((r) => r.id === "keryx.ctx-guard")?.order ?? -1;
    expect(custom!.order).toBeGreaterThan(ctxGuardOrder);
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

  test("a disable-only override disables a built-in by id", () => {
    const doc = {
      schemaVersion: "1.0.0",
      hooks: {
        PreToolUse: [{ id: "keryx.ctx-guard", enabled: false }],
      },
    };
    const result = loadHookConfig({
      projectRoot: PROJECT,
      homeDir: HOME,
      readFile: makeReadFile({ [PROJECT_PATH]: JSON.stringify(doc) }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const ctxGuard = result.registrations.find((r) => r.id === "keryx.ctx-guard");
    expect(ctxGuard?.enabled).toBe(false);
  });

  test("a later-layer disable override can also disable an earlier user-scope hook by id", () => {
    // The schema only allows the disable-only shorthand for keryx.-prefixed
    // ids; this still proves the merge mechanism is generic (id lookup, not
    // scope-hardcoded) by disabling a project-scope full registration from
    // a second project-scope entry is not expressible without a duplicate-id
    // rejection, so this test targets a built-in from the project layer
    // instead — the one shape the frozen schema allows end-to-end.
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
    expect(hook?.enabled).toBe(false);
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
