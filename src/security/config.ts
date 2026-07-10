import path from "node:path";
import { createHash } from "node:crypto";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { SECURITY_CONFIG_SCHEMA, validateAgainstSchema } from "./schemas";
import type { InjectionModelBackend, PolicyConfig, SecurityConfig } from "./types";

// Default config from specification.md §5. `configChecksum` is intentionally
// omitted from the default object and computed on demand (see below).
export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  schemaVersion: 1,
  mode: "advisory",
  rawRetention: "off",
  storeHashes: true,
  storeRedactedSamples: true,
  policies: {
    secrets: { enabled: true, action: "block" },
    pii: { enabled: true, action: "redact" },
    promptInjection: { enabled: true, action: "require-approval" },
    egress: { enabled: true, action: "block" },
    artifactSafety: { enabled: true, action: "redact" },
  },
  backends: {
    rules: { enabled: true },
    entropy: { enabled: true },
    piiModel: { enabled: false, provider: "custom", assetId: "pii-ner" },
    externalApi: { enabled: false },
    injectionModel: {
      enabled: false,
      provider: "prompt-guard-2",
      size: "22M",
      assetId: "prompt-guard-2-22m",
      minConfidence: 0.5,
    },
  },
  gate: { failOn: "critical", minConfidence: 0.5 },
};

export function securityDataRoot(cwd: string): string {
  return path.join(cwd, ".metaproject", "data", "security");
}

export function configPath(cwd: string): string {
  return path.join(cwd, ".metaproject", "security.config.json");
}

function mergePolicy(base: PolicyConfig, override?: Partial<PolicyConfig>): PolicyConfig {
  const merged: PolicyConfig = {
    enabled: override?.enabled ?? base.enabled,
    action: override?.action ?? base.action,
  };
  const minConfidence = override?.minConfidence ?? base.minConfidence;
  if (minConfidence !== undefined) {
    merged.minConfidence = minConfidence;
  }
  return merged;
}

// Merge the egress policy, carrying through a user-provided host allowlist
// (Block E, E3). The allowlist is only materialized when the source config
// provides a valid string[] — an absent or malformed value leaves the field
// undefined so the default config, its rendered form, and its `configChecksum`
// stay byte-identical to today (AC0.1, AC2.3). A non-empty allowlist IS included
// (and thus checksummed) so tampering is detected (§5).
function mergeEgressPolicy(
  base: PolicyConfig,
  override?: Partial<PolicyConfig>,
): PolicyConfig {
  const merged = mergePolicy(base, override);
  const raw = override?.allowlist ?? base.allowlist;
  if (Array.isArray(raw)) {
    const hosts = raw.filter((h): h is string => typeof h === "string");
    if (hosts.length > 0) {
      merged.allowlist = hosts;
    }
  }
  return merged;
}

// Merge the opt-in injection-model backend (Block E, E1) field-by-field over the
// default (which is `enabled:false`). A malformed/absent block yields the default
// off state, so the deterministic regex path is the floor (AC1.1).
function mergeInjectionModel(
  override?: Partial<InjectionModelBackend>,
): InjectionModelBackend {
  const base = DEFAULT_SECURITY_CONFIG.backends.injectionModel as InjectionModelBackend;
  const minConfidence =
    typeof override?.minConfidence === "number" ? override.minConfidence : base.minConfidence;
  return {
    enabled: override?.enabled ?? base.enabled,
    provider: override?.provider ?? base.provider,
    size: override?.size ?? base.size,
    assetId: override?.assetId ?? base.assetId,
    minConfidence,
  };
}

// Merge the PII-model backend, carrying an optional `assetId` (Block E, E4-NER)
// only when defined so `exactOptionalPropertyTypes` stays satisfied.
function mergePiiModel(
  override?: Partial<SecurityConfig["backends"]["piiModel"]>,
): SecurityConfig["backends"]["piiModel"] {
  const base = DEFAULT_SECURITY_CONFIG.backends.piiModel;
  const assetId = override?.assetId ?? base.assetId;
  const merged: SecurityConfig["backends"]["piiModel"] = {
    enabled: override?.enabled ?? base.enabled,
    provider: override?.provider ?? base.provider,
  };
  if (assetId !== undefined) {
    merged.assetId = assetId;
  }
  return merged;
}

// Deep-merge a partial user config over the defaults. Unknown keys are ignored;
// each known block falls back field-by-field to the default.
export function mergeSecurityConfig(parsed: Partial<SecurityConfig>): SecurityConfig {
  const base = DEFAULT_SECURITY_CONFIG;
  const policies = (parsed.policies ?? {}) as Partial<SecurityConfig["policies"]>;
  const merged: SecurityConfig = {
    schemaVersion: parsed.schemaVersion ?? base.schemaVersion,
    mode: parsed.mode ?? base.mode,
    rawRetention: parsed.rawRetention ?? base.rawRetention,
    storeHashes: parsed.storeHashes ?? base.storeHashes,
    storeRedactedSamples: parsed.storeRedactedSamples ?? base.storeRedactedSamples,
    policies: {
      secrets: mergePolicy(base.policies.secrets, policies.secrets),
      pii: mergePolicy(base.policies.pii, policies.pii),
      promptInjection: mergePolicy(base.policies.promptInjection, policies.promptInjection),
      egress: mergeEgressPolicy(base.policies.egress, policies.egress),
      artifactSafety: mergePolicy(base.policies.artifactSafety, policies.artifactSafety),
    },
    backends: {
      rules: { enabled: parsed.backends?.rules?.enabled ?? base.backends.rules.enabled },
      entropy: { enabled: parsed.backends?.entropy?.enabled ?? base.backends.entropy.enabled },
      piiModel: mergePiiModel(parsed.backends?.piiModel),
      externalApi: {
        enabled: parsed.backends?.externalApi?.enabled ?? base.backends.externalApi.enabled,
      },
      injectionModel: mergeInjectionModel(parsed.backends?.injectionModel),
    },
    gate: {
      failOn: parsed.gate?.failOn ?? base.gate.failOn,
      minConfidence: parsed.gate?.minConfidence ?? base.gate.minConfidence,
    },
  };
  if (parsed.configChecksum !== undefined) {
    merged.configChecksum = parsed.configChecksum;
  }
  return merged;
}

// Load `.metaproject/security.config.json`, falling back to the built-in
// defaults when it is absent. Malformed JSON also falls back to defaults so the
// module keeps operating (advisory-safe).
export async function loadSecurityConfig(cwd: string): Promise<SecurityConfig> {
  const file = configPath(cwd);
  if (!(await pathExists(file))) {
    return mergeSecurityConfig({});
  }
  const parsed = await readJsonFileOr<Partial<SecurityConfig>>(file, {});
  return mergeSecurityConfig(parsed);
}

// Stable JSON stringify with sorted object keys, so the checksum is stable
// regardless of key order in the source file.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

// §14: `configChecksum` = sha256 of the normalized `policies` block.
export function computeConfigChecksum(config: SecurityConfig): string {
  return createHash("sha256").update(stableStringify(config.policies)).digest("hex");
}

export function verifyConfigChecksum(config: SecurityConfig): {
  match: boolean;
  expected: string;
  actual: string | null;
} {
  const expected = computeConfigChecksum(config);
  const actual = config.configChecksum ?? null;
  // When no checksum is recorded (fresh/default config), treat as a match:
  // there is nothing to tamper with yet.
  return { match: actual === null || actual === expected, expected, actual };
}

// Render a config file with a freshly-computed checksum, for `policy set`/init.
export function renderSecurityConfig(config: SecurityConfig = DEFAULT_SECURITY_CONFIG): string {
  const withChecksum: SecurityConfig = {
    ...config,
    configChecksum: computeConfigChecksum(config),
  };
  return `${JSON.stringify(withChecksum, null, 2)}\n`;
}

export function validateSecurityConfig(config: unknown): string[] {
  return validateAgainstSchema(config, SECURITY_CONFIG_SCHEMA).map(
    (e) => `${e.path.replace(/^\$\.?/, "") || "(root)"}: ${e.message}`,
  );
}
