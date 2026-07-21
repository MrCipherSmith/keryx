import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveSandboxDefaults } from "../../../lib/sandbox-config";
import {
  buildDefaultMaskProviders,
  parseMaskMode,
  resolveAllowedDomains,
  resolveCredentialMasks,
  resolveMasksFromSandboxEnv,
  type ProviderMaskSource,
} from "./mask-resolve";

const providers: ProviderMaskSource[] = [
  { envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
  { envKey: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api" },
  { envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com" },
];

const FIXTURE_KEY = "sk-test-fixture-not-real";

describe("parseMaskMode (P0.a default manual)", () => {
  test("unset and empty → manual", () => {
    expect(parseMaskMode(undefined)).toBe("manual");
    expect(parseMaskMode("")).toBe("manual");
    expect(parseMaskMode("  ")).toBe("manual");
  });

  test("accepts auto|manual|off", () => {
    expect(parseMaskMode("auto")).toBe("auto");
    expect(parseMaskMode("MANUAL")).toBe("manual");
    expect(parseMaskMode("off")).toBe("off");
  });
});

describe("resolveCredentialMasks", () => {
  // AC1
  test("AC1: mode=auto + DEEPSEEK_API_KEY + no MASK_ENV → deepseek host", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers,
      allowAutoTls: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks).toEqual([
      {
        name: "DEEPSEEK_API_KEY",
        injectHosts: ["api.deepseek.com"],
        source: "auto",
      },
    ]);
    expect(r.resolution.tlsTerminate).toBe(true);
    expect(r.resolution.tlsSource).toBe("auto-derived");
  });

  // AC2
  test("AC2: mode=manual + key + no MASK_ENV → empty masks", () => {
    const r = resolveCredentialMasks({
      mode: "manual",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks).toEqual([]);
  });

  // AC3
  test("AC3: mode=off + explicit MASK_ENV → empty masks", () => {
    const r = resolveCredentialMasks({
      mode: "off",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: ["DEEPSEEK_API_KEY@api.deepseek.com"],
      providers,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks).toEqual([]);
    expect(r.resolution.notes.some((n) => n.includes("ignoring"))).toBe(true);
  });

  // AC4
  test("AC4: merge auto KEY@a + explicit KEY@b → hosts from explicit, source merged", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: ["DEEPSEEK_API_KEY@b.example.com"],
      providers,
      allowAutoTls: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.resolution.masks.find((x) => x.name === "DEEPSEEK_API_KEY");
    expect(m).toEqual({
      name: "DEEPSEEK_API_KEY",
      injectHosts: ["b.example.com"],
      source: "merged",
    });
  });

  // AC5
  test("AC5: masks + tls unset + allowAutoTls → auto-derived tls", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers,
      tlsExplicit: undefined,
      allowAutoTls: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.tlsTerminate).toBe(true);
    expect(r.resolution.tlsSource).toBe("auto-derived");
  });

  // AC6
  test("AC6: masks + tlsExplicit false → ok:false", () => {
    const r = resolveCredentialMasks({
      mode: "manual",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: ["DEEPSEEK_API_KEY@api.deepseek.com"],
      providers,
      tlsExplicit: false,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason.toLowerCase()).toContain("tls");
  });

  test("invalid explicit spec fails closed", () => {
    const r = resolveCredentialMasks({
      mode: "manual",
      env: {},
      explicitSpecs: ["NOHOST"],
      providers,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(false);
  });

  test("manual masks without tls fail closed (not auto)", () => {
    const r = resolveCredentialMasks({
      mode: "manual",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: ["DEEPSEEK_API_KEY@api.deepseek.com"],
      providers,
      tlsExplicit: undefined,
      allowAutoTls: false,
    });
    expect(r.ok).toBe(false);
  });

  test("skips invalid baseUrl with note; keeps valid providers", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { BAD: "x", DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers: [
        { envKey: "BAD", baseUrl: "not-a-url" },
        { envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
      ],
      allowAutoTls: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks.map((m) => m.name)).toEqual(["DEEPSEEK_API_KEY"]);
    expect(r.resolution.notes.some((n) => n.includes("BAD"))).toBe(true);
  });

  test("resolution never contains the secret value", () => {
    const r = resolveCredentialMasks({
      mode: "auto",
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      explicitSpecs: [],
      providers,
      allowAutoTls: true,
    });
    expect(JSON.stringify(r)).not.toContain(FIXTURE_KEY);
  });
});

describe("buildDefaultMaskProviders", () => {
  test("appends Anthropic after openai-compat entries", () => {
    const list = buildDefaultMaskProviders([
      { envKey: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
    ]);
    expect(list.at(-1)).toEqual({
      envKey: "ANTHROPIC_API_KEY",
      baseUrl: "https://api.anthropic.com",
    });
    expect(list[0]?.envKey).toBe("DEEPSEEK_API_KEY");
  });
});

describe("resolveMasksFromSandboxEnv parity (AC8)", () => {
  test("shell-shaped env and harness-shaped extra specs share the same resolution shape", () => {
    const env = {
      KERYX_SANDBOX_MASK_MODE: "auto",
      DEEPSEEK_API_KEY: FIXTURE_KEY,
    };
    const shell = resolveMasksFromSandboxEnv({ env, providers });
    const harness = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY, KERYX_SANDBOX_MASK_MODE: "auto" },
      extraExplicitSpecs: [],
      modeOverride: "auto",
      providers,
    });
    expect(shell.ok).toBe(true);
    expect(harness.ok).toBe(true);
    if (!shell.ok || !harness.ok) return;
    expect(shell.resolution.masks).toEqual(harness.resolution.masks);
    expect(shell.resolution.tlsTerminate).toBe(harness.resolution.tlsTerminate);
    expect(shell.resolution.tlsSource).toBe(harness.resolution.tlsSource);
    expect(shell.resolution.mode).toBe(harness.resolution.mode);
  });

  test("explicit env MASK_ENV + mode manual + TLS=1 matches harness --mask-env + --tls-terminate", () => {
    const env = {
      KERYX_SANDBOX_MASK_MODE: "manual",
      KERYX_SANDBOX_MASK_ENV: "DEEPSEEK_API_KEY@api.deepseek.com",
      KERYX_SANDBOX_TLS_TERMINATE: "1",
      DEEPSEEK_API_KEY: FIXTURE_KEY,
    };
    const shell = resolveMasksFromSandboxEnv({ env, providers });
    const harness = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      extraExplicitSpecs: ["DEEPSEEK_API_KEY@api.deepseek.com"],
      modeOverride: "manual",
      tlsFlag: true,
      providers,
    });
    expect(shell.ok && harness.ok).toBe(true);
    if (!shell.ok || !harness.ok) return;
    expect(shell.resolution.masks).toEqual(harness.resolution.masks);
    expect(shell.resolution.tlsTerminate).toBe(true);
    expect(harness.resolution.tlsTerminate).toBe(true);
  });
});

describe("P1 sandbox.json defaults (AC-P1-2/3/6)", () => {
  test("file maskMode=auto used when env unset", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-p1-"));
    saveSandboxDefaults({ maskMode: "auto" }, dir);
    const r = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      providers,
      sandboxConfigDir: dir,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.mode).toBe("auto");
    expect(r.resolution.masks[0]?.name).toBe("DEEPSEEK_API_KEY");
  });

  test("env overrides file maskMode", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-p1-"));
    saveSandboxDefaults({ maskMode: "auto" }, dir);
    const r = resolveMasksFromSandboxEnv({
      env: {
        KERYX_SANDBOX_MASK_MODE: "manual",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      providers,
      sandboxConfigDir: dir,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.mode).toBe("manual");
    expect(r.resolution.masks).toEqual([]);
  });

  test("file tlsTerminate used when env unset (manual + explicit mask)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-sbx-p1-"));
    saveSandboxDefaults({ maskMode: "manual", tlsTerminate: true }, dir);
    const r = resolveMasksFromSandboxEnv({
      env: {
        KERYX_SANDBOX_MASK_ENV: "DEEPSEEK_API_KEY@api.deepseek.com",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      providers,
      sandboxConfigDir: dir,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.tlsTerminate).toBe(true);
    expect(r.resolution.tlsSource).toBe("defaults");
  });
});

describe("P2 project policy (AC-P2-1/2/3/6)", () => {
  function projectWithPolicy(policy: Record<string, unknown>): string {
    const root = mkdtempSync(path.join(tmpdir(), "keryx-p2-proj-"));
    mkdirSync(path.join(root, ".git"));
    mkdirSync(path.join(root, ".keryx"), { recursive: true });
    writeFileSync(path.join(root, ".keryx", "sandbox-policy.json"), JSON.stringify(policy, null, 2));
    return root;
  }

  test("AC-P2-1: missing project policy → same as no projectRoot (manual empty)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "keryx-p2-empty-"));
    mkdirSync(path.join(root, ".git"));
    const globalDir = mkdtempSync(path.join(tmpdir(), "keryx-p2-global-"));
    const withRoot = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      providers,
      sandboxConfigDir: globalDir,
      projectRoot: root,
    });
    const without = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      providers,
      sandboxConfigDir: globalDir,
    });
    expect(withRoot.ok && without.ok).toBe(true);
    if (!withRoot.ok || !without.ok) return;
    expect(withRoot.resolution).toEqual(without.resolution);
  });

  test("AC-P2-2: project extraMasks merge as explicit", () => {
    const root = projectWithPolicy({
      maskMode: "manual",
      tlsTerminate: true,
      extraMasks: ["DEEPSEEK_API_KEY@api.deepseek.com"],
    });
    const globalDir = mkdtempSync(path.join(tmpdir(), "keryx-p2-g-"));
    const r = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      providers,
      sandboxConfigDir: globalDir,
      projectRoot: root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.masks).toEqual([
      {
        name: "DEEPSEEK_API_KEY",
        injectHosts: ["api.deepseek.com"],
        source: "explicit",
      },
    ]);
  });

  test("AC-P2-3: env overrides project and global", () => {
    const root = projectWithPolicy({ maskMode: "auto" });
    const globalDir = mkdtempSync(path.join(tmpdir(), "keryx-p2-g2-"));
    saveSandboxDefaults({ maskMode: "auto" }, globalDir);
    const r = resolveMasksFromSandboxEnv({
      env: {
        KERYX_SANDBOX_MASK_MODE: "manual",
        DEEPSEEK_API_KEY: FIXTURE_KEY,
      },
      providers,
      sandboxConfigDir: globalDir,
      projectRoot: root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.mode).toBe("manual");
    expect(r.resolution.masks).toEqual([]);
  });

  test("project maskMode beats global when env unset", () => {
    const root = projectWithPolicy({ maskMode: "auto" });
    const globalDir = mkdtempSync(path.join(tmpdir(), "keryx-p2-g3-"));
    saveSandboxDefaults({ maskMode: "manual" }, globalDir);
    const r = resolveMasksFromSandboxEnv({
      env: { DEEPSEEK_API_KEY: FIXTURE_KEY },
      providers,
      sandboxConfigDir: globalDir,
      projectRoot: root,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.resolution.mode).toBe("auto");
    expect(r.resolution.masks[0]?.source).toBe("auto");
  });

  test("resolveAllowedDomains: env wins over project", () => {
    const root = projectWithPolicy({ allowedDomains: ["from.project.com"] });
    expect(resolveAllowedDomains({}, root)).toEqual(["from.project.com"]);
    expect(
      resolveAllowedDomains({ KERYX_SANDBOX_ALLOWED_DOMAINS: "from.env.com, other.com" }, root),
    ).toEqual(["from.env.com", "other.com"]);
  });
});
