// Tests for the external agent runtime's opt-in gate (flow 176, T15).
//
// Everything here is offline and deterministic: environments are plain objects,
// the config is passed in or written to a temp directory, and no process is
// started. The one thing these tests are really about is that a refusal is never
// silent and never accidental — a malformed config must land on the safe default
// and a hard disable must win over an enabled config, in that order.
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CI_ENV_VARS,
  DEFAULT_AGENT_CONFIG,
  ENV_KERYX_TRANSPORT,
  EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR,
  EXTERNAL_AGENTS_CAPABILITY_ID,
  EXTERNAL_AGENTS_DEFAULTS,
  agentConfig,
  detectCi,
  detectTransport,
  loadExternalAgentsConfig,
  manifestCapabilityState,
  parseExternalAgentsConfig,
  resolveExternalAgentsCapability,
  type ExternalAgentsConfig,
} from "./external-agents";
import { CAPABILITY_REGISTRY } from "./registry";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-extcap-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A manifest whose `gdskills` module carries the given capability entry. */
async function writeManifest(dir: string, capabilities: unknown[]): Promise<void> {
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(dir, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { gdskills: { enabled: true, capabilities } } }, null, 2),
    "utf8",
  );
}

const ENABLED: ExternalAgentsConfig = { ...EXTERNAL_AGENTS_DEFAULTS, enabled: true, spawnDecision: "allow" };

describe("the descriptor", () => {
  test("is registered, is a ceiling, and declares no dependency, asset or project config", () => {
    expect(CAPABILITY_REGISTRY).toContain(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR);
    expect(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.kind).toBe("ceiling");
    expect(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.id).toBe(EXTERNAL_AGENTS_CAPABILITY_ID);
    expect(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.optionalDependency).toBeUndefined();
    expect(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.asset).toBeUndefined();
    expect(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.config).toBeUndefined();
  });

  test("its id matches the seam's `module.name` shape", () => {
    expect(EXTERNAL_AGENTS_CAPABILITY_DESCRIPTOR.id).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/);
  });
});

describe("config parsing is defensive and defaults to OFF", () => {
  test("a missing block is the shipped defaults", () => {
    expect(parseExternalAgentsConfig(undefined)).toEqual(EXTERNAL_AGENTS_DEFAULTS);
    expect(parseExternalAgentsConfig(null)).toEqual(EXTERNAL_AGENTS_DEFAULTS);
    expect(parseExternalAgentsConfig("enabled")).toEqual(EXTERNAL_AGENTS_DEFAULTS);
    expect(parseExternalAgentsConfig([1, 2])).toEqual(EXTERNAL_AGENTS_DEFAULTS);
  });

  test("only the literal boolean true enables — a truthy string does not", () => {
    expect(parseExternalAgentsConfig({ enabled: "true" }).enabled).toBe(false);
    expect(parseExternalAgentsConfig({ enabled: 1 }).enabled).toBe(false);
    expect(parseExternalAgentsConfig({ enabled: {} }).enabled).toBe(false);
    expect(parseExternalAgentsConfig({ enabled: true }).enabled).toBe(true);
  });

  test("an unrecognised spawnDecision resolves to ask, never to allow", () => {
    expect(parseExternalAgentsConfig({ spawnDecision: "yolo" }).spawnDecision).toBe("ask");
    expect(parseExternalAgentsConfig({ spawnDecision: true }).spawnDecision).toBe("ask");
    expect(parseExternalAgentsConfig({}).spawnDecision).toBe("ask");
    expect(parseExternalAgentsConfig({ spawnDecision: "allow" }).spawnDecision).toBe("allow");
  });

  test("out-of-range numbers fall back to the default rather than being clamped silently", () => {
    expect(parseExternalAgentsConfig({ defaultTimeoutMs: 0 }).defaultTimeoutMs).toBe(
      EXTERNAL_AGENTS_DEFAULTS.defaultTimeoutMs,
    );
    expect(parseExternalAgentsConfig({ defaultTimeoutMs: -5 }).defaultTimeoutMs).toBe(
      EXTERNAL_AGENTS_DEFAULTS.defaultTimeoutMs,
    );
    expect(parseExternalAgentsConfig({ defaultTimeoutMs: 1.5 }).defaultTimeoutMs).toBe(
      EXTERNAL_AGENTS_DEFAULTS.defaultTimeoutMs,
    );
    expect(parseExternalAgentsConfig({ defaultTimeoutMs: 90_000 }).defaultTimeoutMs).toBe(90_000);
    expect(parseExternalAgentsConfig({ maxPromptBytes: 4 }).maxPromptBytes).toBe(
      EXTERNAL_AGENTS_DEFAULTS.maxPromptBytes,
    );
    expect(parseExternalAgentsConfig({ maxPromptBytes: 32_768 }).maxPromptBytes).toBe(32_768);
  });

  test("model: null means 'let the CLI resolve its own default', and a blank string is the same thing", () => {
    const config = parseExternalAgentsConfig({
      agents: {
        "codex-cli": { enabled: true, model: null },
        "claude-cli": { enabled: true, model: "   " },
        "pinned-cli": { enabled: true, model: " opus-x " },
      },
    });
    expect(agentConfig(config, "codex-cli").model).toBeNull();
    expect(agentConfig(config, "claude-cli").model).toBeNull();
    expect(agentConfig(config, "pinned-cli").model).toBe("opus-x");
  });

  test("an agent nobody configured gets the default entry", () => {
    const config = parseExternalAgentsConfig({ agents: { "codex-cli": { enabled: false } } });
    expect(agentConfig(config, "codex-cli").enabled).toBe(false);
    expect(agentConfig(config, "never-mentioned")).toEqual(DEFAULT_AGENT_CONFIG);
  });

  test("a malformed agent entry degrades to the default rather than throwing", () => {
    const config = parseExternalAgentsConfig({ agents: { "codex-cli": "yes", "claude-cli": 7 } });
    expect(agentConfig(config, "codex-cli")).toEqual(DEFAULT_AGENT_CONFIG);
    expect(agentConfig(config, "claude-cli")).toEqual(DEFAULT_AGENT_CONFIG);
  });

  test("an unreadable user config resolves to the defaults, never to enabled", () => {
    // `loadShellConfig` already degrades a malformed/absent file to `{}`; this
    // asserts the composition, because "disabled" is the only safe reading of
    // "we could not tell".
    expect(loadExternalAgentsConfig(path.join(root, "no-such-dir")).enabled).toBe(false);
  });
});

describe("transport detection", () => {
  test("an unset marker is local — the ordinary case", () => {
    expect(detectTransport({})).toBe("local");
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "" })).toBe("local");
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "  " })).toBe("local");
  });

  test("known local markers are local, case-insensitively", () => {
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "local" })).toBe("local");
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "TUI" })).toBe("local");
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: " Shell " })).toBe("local");
  });

  test("anything else is remote — an unknown marker fails towards refusal", () => {
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "telegram" })).toBe("remote");
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "serve" })).toBe("remote");
    expect(detectTransport({ [ENV_KERYX_TRANSPORT]: "some-future-thing" })).toBe("remote");
  });
});

describe("CI detection", () => {
  test("every listed marker is detected and names itself", () => {
    for (const name of CI_ENV_VARS) {
      expect(detectCi({ [name]: "1" })).toBe(name);
    }
  });

  test("a present-but-false marker is not CI", () => {
    expect(detectCi({ CI: "false" })).toBeUndefined();
    expect(detectCi({ CI: "0" })).toBeUndefined();
    expect(detectCi({ CI: "off" })).toBeUndefined();
    expect(detectCi({ CI: "" })).toBeUndefined();
  });

  test("a clean environment is not CI", () => {
    expect(detectCi({ PATH: "/usr/bin", HOME: "/home/x" })).toBeUndefined();
  });
});

describe("the manifest state separates 'no workspace' from 'not opted in'", () => {
  test("no manifest at all is no-manifest, which is neutral", async () => {
    expect(await manifestCapabilityState(root, EXTERNAL_AGENTS_CAPABILITY_ID)).toBe("no-manifest");
  });

  test("an entry present and false is disabled — what `keryx update` materialises", async () => {
    await writeManifest(root, [{ id: EXTERNAL_AGENTS_CAPABILITY_ID, enabled: false, kind: "ceiling" }]);
    expect(await manifestCapabilityState(root, EXTERNAL_AGENTS_CAPABILITY_ID)).toBe("disabled");
  });

  test("an entry present and true is enabled", async () => {
    await writeManifest(root, [{ id: EXTERNAL_AGENTS_CAPABILITY_ID, enabled: true, kind: "ceiling" }]);
    expect(await manifestCapabilityState(root, EXTERNAL_AGENTS_CAPABILITY_ID)).toBe("enabled");
  });

  test("a bare-string capability entry is an advertised floor, never an enabled ceiling", async () => {
    await writeManifest(root, [EXTERNAL_AGENTS_CAPABILITY_ID]);
    expect(await manifestCapabilityState(root, EXTERNAL_AGENTS_CAPABILITY_ID)).toBe("unlisted");
  });

  test("a workspace that never listed the capability is unlisted", async () => {
    await writeManifest(root, []);
    expect(await manifestCapabilityState(root, EXTERNAL_AGENTS_CAPABILITY_ID)).toBe("unlisted");
  });

  test("a malformed manifest fails towards refusal, not towards enabled", async () => {
    await mkdir(path.join(root, ".metaproject"), { recursive: true });
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), "{not json", "utf8");
    expect(await manifestCapabilityState(root, EXTERNAL_AGENTS_CAPABILITY_ID)).toBe("unlisted");
  });
});

describe("the gate", () => {
  test("is off by default: an enabled-nowhere config refuses with a named reason", async () => {
    const gate = await resolveExternalAgentsCapability({ cwd: root, env: {}, config: EXTERNAL_AGENTS_DEFAULTS });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("externalAgents.enabled");
  });

  test("a remote transport wins over an enabled config, and names the compliance reason", async () => {
    const gate = await resolveExternalAgentsCapability({
      cwd: root,
      env: { [ENV_KERYX_TRANSPORT]: "telegram" },
      config: ENABLED,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("remote transport");
  });

  test("an explicit transport override wins even with no env marker", async () => {
    const gate = await resolveExternalAgentsCapability({
      cwd: root,
      env: {},
      transport: "remote",
      config: ENABLED,
    });
    expect(gate.ok).toBe(false);
  });

  test("CI wins over an enabled config, and names the variable that identified it", async () => {
    const gate = await resolveExternalAgentsCapability({
      cwd: root,
      env: { GITHUB_ACTIONS: "true" },
      config: ENABLED,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("GITHUB_ACTIONS");
  });

  test("the hard disable is checked BEFORE the config, so it is truly 'regardless of configuration'", async () => {
    // Both hard disables active AND the config enabled: the reason must be a
    // hard-disable reason, never the config one.
    const gate = await resolveExternalAgentsCapability({
      cwd: root,
      env: { CI: "1", [ENV_KERYX_TRANSPORT]: "telegram" },
      config: ENABLED,
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).not.toContain("externalAgents.enabled");
  });

  test("outside a Metaproject workspace the user-global switch is the whole story", async () => {
    const gate = await resolveExternalAgentsCapability({ cwd: root, env: {}, config: ENABLED });
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.config.enabled).toBe(true);
  });

  test("a workspace that opted in resolves available", async () => {
    await writeManifest(root, [{ id: EXTERNAL_AGENTS_CAPABILITY_ID, enabled: true, kind: "ceiling" }]);
    const gate = await resolveExternalAgentsCapability({ cwd: root, env: {}, config: ENABLED });
    expect(gate.ok).toBe(true);
  });

  test("a workspace carrying the disabled entry `keryx update` writes refuses, and says how to opt in", async () => {
    await writeManifest(root, [{ id: EXTERNAL_AGENTS_CAPABILITY_ID, enabled: false, kind: "ceiling" }]);
    const gate = await resolveExternalAgentsCapability({ cwd: root, env: {}, config: ENABLED });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("keryx init --external-agents");
  });

  test("a workspace that never listed the capability refuses the same way", async () => {
    await writeManifest(root, []);
    const gate = await resolveExternalAgentsCapability({ cwd: root, env: {}, config: ENABLED });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("has not enabled");
  });

  test("a project that enabled the capability still needs the user-global switch", async () => {
    await writeManifest(root, [{ id: EXTERNAL_AGENTS_CAPABILITY_ID, enabled: true, kind: "ceiling" }]);
    const gate = await resolveExternalAgentsCapability({ cwd: root, env: {}, config: EXTERNAL_AGENTS_DEFAULTS });
    expect(gate.ok).toBe(false);
  });
});
