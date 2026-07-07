import path from "node:path";
import { createHash } from "node:crypto";
import { pathExists } from "../lib/fs";
import { readJsonFileOr } from "../lib/json";
import { SECURITY_CONFIG_SCHEMA, validateAgainstSchema } from "./schemas";
import type { PolicyConfig, SecurityConfig } from "./types";

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
    piiModel: { enabled: false, provider: "custom" },
    externalApi: { enabled: false },
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
      egress: mergePolicy(base.policies.egress, policies.egress),
      artifactSafety: mergePolicy(base.policies.artifactSafety, policies.artifactSafety),
    },
    backends: {
      rules: { enabled: parsed.backends?.rules?.enabled ?? base.backends.rules.enabled },
      entropy: { enabled: parsed.backends?.entropy?.enabled ?? base.backends.entropy.enabled },
      piiModel: {
        enabled: parsed.backends?.piiModel?.enabled ?? base.backends.piiModel.enabled,
        provider: parsed.backends?.piiModel?.provider ?? base.backends.piiModel.provider,
      },
      externalApi: {
        enabled: parsed.backends?.externalApi?.enabled ?? base.backends.externalApi.enabled,
      },
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
