// Tests for child model/provider resolution (flow 088, multi-agent engine
// Phase 1). Covers acceptance-criteria.md AC1-AC6:
//   - AC1 inherit default (omitted / {kind:"inherit"}) -> parent, source:"inherited"
//   - AC2 explicit + tier resolution; unknown tier denied
//   - AC3 fail-closed gates G1 (allowlist) / G2 (network) / G3 (unknown)
//   - AC4 KERYX_SUBAGENT_MODEL parsing precedence; literal "inherit" == unset
//   - AC5 providerClass over the real registry + zero new deps (import-only)
//   - AC6 determinism (identical inputs deep-equal; no clock/RNG)
import { describe, expect, test } from "bun:test";
import { OPENAI_COMPAT_PROVIDERS } from "../../commands/providers";
import type { PolicyProfile, PolicyOutcome, PolicyTrustMode } from "../policy/types";
import {
  KNOWN_PROVIDER_IDS,
  parseDispatchModel,
  parseEnvModel,
  providerClass,
  resolveChildModel,
  type ChildModelRequest,
  type ModelSelection,
  type ParentModelContext,
  type ResolveChildModelDeps,
} from "./model";

/** Build a policy profile with the trust mode + network default under test. */
function policy(trustMode: PolicyTrustMode, network: PolicyOutcome): PolicyProfile {
  return {
    schemaVersion: 1,
    profileId:
      trustMode === "read-only"
        ? "read-only-review"
        : trustMode === "trusted-local"
          ? "monitored-trusted-local"
          : "unattended-untrusted",
    profileVersion: "1.0.0",
    fingerprint: "fp-test",
    trustMode,
    defaults: { read: "allow", write: "ask", shell: "ask", network, delegate: "ask" },
    requiredControls: {
      isolation: "not-required",
      redactionFailure: "deny",
      networkBrokerFailure: "deny",
    },
  };
}

const PARENT: ParentModelContext = { providerId: "anthropic", modelId: "claude-opus-4-8" };

/** Deps with network permitted and a broad allowlist, using the real classifier. */
function deps(overrides: Partial<ResolveChildModelDeps> = {}): ResolveChildModelDeps {
  return {
    allowedProviders: new Set(["anthropic", "ollama", "deepseek"]),
    tiers: {
      cheap: { providerId: "ollama", modelId: "qwen2.5-coder" },
      standard: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
      deep: { providerId: "anthropic", modelId: "claude-opus-4-8" },
    },
    policy: policy("trusted-local", "allow"),
    providerClass,
    ...overrides,
  };
}

describe("resolveChildModel — AC1 inherit default", () => {
  test("omitted request inherits the parent verbatim", () => {
    const r = resolveChildModel(PARENT, undefined, deps());
    expect(r).toEqual({ ok: true, selection: { ...PARENT }, source: "inherited" });
  });

  test('{kind:"inherit"} inherits the parent verbatim', () => {
    const r = resolveChildModel(PARENT, { kind: "inherit" }, deps());
    expect(r).toEqual({ ok: true, selection: { ...PARENT }, source: "inherited" });
  });
});

describe("resolveChildModel — AC2 explicit + tier", () => {
  test("explicit selection wins with source:explicit", () => {
    const req: ChildModelRequest = { kind: "explicit", providerId: "ollama", modelId: "llama3" };
    const r = resolveChildModel(PARENT, req, deps());
    expect(r).toEqual({ ok: true, selection: { providerId: "ollama", modelId: "llama3" }, source: "explicit" });
  });

  test("tier resolves through the configured map with source:tier", () => {
    const r = resolveChildModel(PARENT, { kind: "tier", tier: "cheap" }, deps());
    expect(r).toEqual({
      ok: true,
      selection: { providerId: "ollama", modelId: "qwen2.5-coder" },
      source: "tier",
    });
  });

  test("unknown tier is denied fail-closed", () => {
    const r = resolveChildModel(PARENT, { kind: "tier", tier: "ultra" }, deps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unknown model tier");
  });

  test("tier denied when the tier map is absent", () => {
    const { tiers: _omit, ...noTiers } = deps();
    const r = resolveChildModel(PARENT, { kind: "tier", tier: "cheap" }, noTiers);
    expect(r.ok).toBe(false);
  });
});

describe("resolveChildModel — AC3 fail-closed gates", () => {
  test("G1 provider not in allowlist is denied", () => {
    const req: ChildModelRequest = { kind: "explicit", providerId: "deepseek", modelId: "deepseek-chat" };
    const r = resolveChildModel(PARENT, req, deps({ allowedProviders: new Set(["anthropic", "ollama"]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not in the parent allowlist");
  });

  test("G2 network provider denied when policy trust is read-only", () => {
    const r = resolveChildModel(PARENT, { kind: "inherit" }, deps({ policy: policy("read-only", "allow") }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("forbidden by child policy");
  });

  test("G2 network provider denied when defaults.network is not allow", () => {
    const r = resolveChildModel(PARENT, { kind: "inherit" }, deps({ policy: policy("trusted-local", "deny") }));
    expect(r.ok).toBe(false);
  });

  test("G2 does not block a local provider under a read-only policy", () => {
    const req: ChildModelRequest = { kind: "explicit", providerId: "ollama", modelId: "qwen2.5-coder" };
    const r = resolveChildModel(PARENT, req, deps({ policy: policy("read-only", "deny") }));
    expect(r).toEqual({ ok: true, selection: { providerId: "ollama", modelId: "qwen2.5-coder" }, source: "explicit" });
  });

  test("G3 unclassifiable provider is denied even if allowlisted", () => {
    const req: ChildModelRequest = { kind: "explicit", providerId: "mystery", modelId: "x" };
    const r = resolveChildModel(PARENT, req, deps({ allowedProviders: new Set(["mystery"]), providerClass }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not classifiable");
  });

  test("an inherited candidate is still gated (parent provider not allowlisted)", () => {
    const r = resolveChildModel(PARENT, { kind: "inherit" }, deps({ allowedProviders: new Set(["ollama"]) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not in the parent allowlist");
  });
});

describe("resolveChildModel — AC4 env override precedence", () => {
  test("env override wins over an explicit request with source:env", () => {
    const req: ChildModelRequest = { kind: "explicit", providerId: "ollama", modelId: "llama3" };
    const r = resolveChildModel(PARENT, req, deps({ envOverride: { providerId: "anthropic", modelId: "claude-sonnet-4-6" } }));
    expect(r).toEqual({
      ok: true,
      selection: { providerId: "anthropic", modelId: "claude-sonnet-4-6" },
      source: "env",
    });
  });

  test("env override is still gated (denied when not allowlisted)", () => {
    const r = resolveChildModel(PARENT, undefined, deps({ envOverride: { providerId: "groq", modelId: "x" } }));
    expect(r.ok).toBe(false);
  });

  test("parseEnvModel: undefined / empty / 'inherit' are treated as unset", () => {
    expect(parseEnvModel(undefined)).toBeUndefined();
    expect(parseEnvModel("")).toBeUndefined();
    expect(parseEnvModel("   ")).toBeUndefined();
    expect(parseEnvModel("inherit")).toBeUndefined();
  });

  test("parseEnvModel: 'provider/model' parses; model keeps inner slashes", () => {
    expect(parseEnvModel("anthropic/claude-opus-4-8")).toEqual({ providerId: "anthropic", modelId: "claude-opus-4-8" });
    expect(parseEnvModel("openrouter/openai/gpt-4o-mini")).toEqual({ providerId: "openrouter", modelId: "openai/gpt-4o-mini" });
  });

  test("parseEnvModel: malformed values are unset (fail-closed)", () => {
    expect(parseEnvModel("noslash")).toBeUndefined();
    expect(parseEnvModel("/model")).toBeUndefined();
    expect(parseEnvModel("provider/")).toBeUndefined();
  });
});

describe("providerClass — AC5 registry coverage", () => {
  test("ollama is local, anthropic is network", () => {
    expect(providerClass("ollama")).toBe("local");
    expect(providerClass("anthropic")).toBe("network");
  });

  test("every registered OpenAI-compat provider classifies as network", () => {
    for (const p of OPENAI_COMPAT_PROVIDERS) {
      expect(providerClass(p.name)).toBe("network");
    }
  });

  test("unknown ids classify as unknown", () => {
    expect(providerClass("fake")).toBe("unknown");
    expect(providerClass("")).toBe("unknown");
    expect(providerClass("totally-made-up")).toBe("unknown");
  });

  test("KNOWN_PROVIDER_IDS matches the non-unknown classifier surface", () => {
    for (const id of KNOWN_PROVIDER_IDS) {
      expect(providerClass(id)).not.toBe("unknown");
    }
    expect(KNOWN_PROVIDER_IDS.has("anthropic")).toBe(true);
    expect(KNOWN_PROVIDER_IDS.has("ollama")).toBe(true);
  });
});

describe("resolveChildModel — AC6 determinism", () => {
  test("identical inputs yield deep-equal output", () => {
    const req: ChildModelRequest = { kind: "tier", tier: "standard" };
    const a = resolveChildModel(PARENT, req, deps());
    const b = resolveChildModel(PARENT, req, deps());
    expect(a).toEqual(b);
  });

  test("does not mutate the parent context", () => {
    const parent: ParentModelContext = { providerId: "anthropic", modelId: "claude-opus-4-8" };
    const snapshot: ModelSelection = { ...parent };
    resolveChildModel(parent, { kind: "inherit" }, deps());
    expect(parent).toEqual(snapshot);
  });
});

describe("parseDispatchModel — dispatch model block -> ChildModelRequest (flow 089)", () => {
  test("undefined block -> undefined (caller inherits)", () => {
    expect(parseDispatchModel(undefined)).toBeUndefined();
  });

  test("inherit:true -> {kind:inherit}", () => {
    expect(parseDispatchModel({ inherit: true })).toEqual({ kind: "inherit" });
  });

  test("complete provider+model -> explicit", () => {
    expect(parseDispatchModel({ provider: "ollama", model: "llama3" })).toEqual({
      kind: "explicit",
      providerId: "ollama",
      modelId: "llama3",
    });
  });

  test("tier -> {kind:tier}", () => {
    expect(parseDispatchModel({ tier: "cheap" })).toEqual({ kind: "tier", tier: "cheap" });
  });

  test("under-specified block (provider without model) falls back to inherit", () => {
    expect(parseDispatchModel({ provider: "ollama" })).toEqual({ kind: "inherit" });
    expect(parseDispatchModel({})).toEqual({ kind: "inherit" });
  });

  test("complete provider+model takes precedence over a tier", () => {
    expect(parseDispatchModel({ provider: "ollama", model: "llama3", tier: "deep" })).toEqual({
      kind: "explicit",
      providerId: "ollama",
      modelId: "llama3",
    });
  });
});
