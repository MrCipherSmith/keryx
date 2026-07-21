import { describe, expect, test } from "bun:test";
import {
  buildDefaultMaskProviders,
  parseMaskMode,
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
