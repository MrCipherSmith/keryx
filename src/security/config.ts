import path from "node:path";
import { createHash } from "node:crypto";
import { resolveProjectRoot } from "../lib/contained-path";
import { pathExists } from "../lib/fs";
import { readJsonObjectFile } from "../lib/json";
import { SECURITY_CONFIG_SCHEMA, validateAgainstSchema } from "./schemas";
import type {
  ImpactEvidenceConfig,
  InjectionModelBackend,
  PolicyConfig,
  SecurityAction,
  SecurityConfig,
  SecurityMode,
  SourceOverrideTable,
} from "./types";

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
    egress: {
      enabled: true,
      action: "block",
      // GDCTX-2: `sourceOverrides` is deliberately ABSENT here — see
      // `SHIPPED_EGRESS_SOURCE_OVERRIDES` below for why, and
      // `resolve.ts#egressSourceOverrideAction` for where the shipped default
      // is actually applied.
    },
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

// Flow 308 (W8, Lane B, T6): defaults for the optional `impactEvidence`
// block (per the Lane B design: enabled true, strict false, no exemptions,
// dampen after 3 denials). Not part of `DEFAULT_SECURITY_CONFIG` itself —
// see `mergeSecurityConfig` below for why the key is filled in only when the
// parsed config actually declares it.
export const DEFAULT_IMPACT_EVIDENCE_CONFIG: ImpactEvidenceConfig = {
  enabled: true,
  strict: false,
  exemptGlobs: [],
  dampenAfter: 3,
};

// GDCTX-2's shipped default: a static, committed badge/logo `<img src>`/
// markdown-image URL (CI badge, npm badge, license badge — see README.md)
// reads as an exfil-shaped egress finding under `trusted-project` content even
// though nobody's secret ever reaches it. `resolve.ts#egressSourceOverrideAction`
// still gates this on the URL's query string: a credential-shaped parameter
// (or a value a secret/PII detector flags) keeps the ordinary `action` above.
//
// F1 (T-review): this used to live INSIDE `DEFAULT_SECURITY_CONFIG.policies.egress`
// and `mergeEgressPolicy` always copied it onto every merged config — including
// one loaded from a `security.config.json` a user never touched. `configChecksum`
// (§14) is `sha256(policies)` (`computeConfigChecksum` below), so every config
// file rendered before this feature shipped, with a checksum computed over a
// `policies.egress` that had NO `sourceOverrides` key at all, started reading as
// TAMPERED the moment this build loaded it (`security status` → MISMATCH,
// `security policy validate` → fail) — a false self-protection incident with no
// actual edit behind it. A shipped default is not something the OPERATOR wrote,
// so it must never enter the block their checksum protects; it is applied at
// RESOLUTION time instead (`egressSourceOverrideAction`), never materialized
// into `config.policies`. A project that wants its own override — including
// turning this shipped one back to `"redact"`/`"block"` — writes it into
// `security.config.json` directly; only THAT explicit entry is merged and
// checksummed (see `mergeEgressPolicy`).
export const SHIPPED_EGRESS_SOURCE_OVERRIDES: SourceOverrideTable = {
  "egress.html-image-exfil": { "trusted-project": "allow" },
  "egress.markdown-image-exfil": { "trusted-project": "allow" },
};

/**
 * The project whose `.metaproject/` this module reads and writes.
 *
 * Every security path used to be `path.join(cwd, ".metaproject", …)`, and `cwd`
 * is whatever directory the process happened to start in. Run from a
 * subdirectory — a docs folder, a fixture folder, a flow package — the module
 * did not find the project's config and instead CREATED a second
 * `.metaproject/` right there, holding `data/security/raw/hmac.key` and
 * `data/security/raw/state.json`. That is worse than a stray directory: the
 * per-project HMAC key that makes finding hashes non-brute-forceable was
 * regenerated per working directory, and the self-protection state
 * (`state.json`) that detects a mode downgrade or a disabled policy started
 * empty every time, so a downgrade in a subdirectory invocation was never
 * surfaced. The scattered directories are the visible half of a security
 * control silently resetting itself.
 *
 * `resolveProjectRoot` is the shared answer (`src/lib/contained-path.ts`) and is
 * already used by `security scan` to contain its target path — the same walk up
 * to the nearest `.metaproject/` or `.git/`. A directory that is genuinely its
 * own project root still resolves to itself, and a bare directory with neither
 * marker still resolves to itself, so a standalone root behaves exactly as
 * before.
 */
export function securityProjectRoot(cwd: string): string {
  return resolveProjectRoot(cwd);
}

export function securityDataRoot(cwd: string): string {
  return path.join(securityProjectRoot(cwd), ".metaproject", "data", "security");
}

export function configPath(cwd: string): string {
  return path.join(securityProjectRoot(cwd), ".metaproject", "security.config.json");
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

const VALID_ACTIONS: ReadonlySet<string> = new Set<SecurityAction>([
  "allow",
  "redact",
  "block",
  "require-approval",
  "warn",
]);

function isSecurityAction(value: unknown): value is SecurityAction {
  return typeof value === "string" && VALID_ACTIONS.has(value);
}

// Merge `sourceOverrides` (GDCTX-2) per policyId: the override config replaces
// the DEFAULT'S entry for a policyId it names (so a project can turn the
// shipped `trusted-project -> allow` for `egress.html-image-exfil` back to
// `redact`/`block` with a two-line config, or add its own entries for other
// policy ids/sources) while every policyId it does not mention keeps the
// default untouched. A malformed leaf (not a recognized `SecurityAction`
// string) is dropped rather than merged, so a typo in the config file cannot
// silently produce `undefined`-as-allow.
export function mergeSourceOverrides(
  base: SourceOverrideTable | undefined,
  override: unknown,
): SourceOverrideTable | undefined {
  if (override === undefined) {
    return base;
  }
  if (typeof override !== "object" || override === null || Array.isArray(override)) {
    return base;
  }
  const merged: SourceOverrideTable = { ...(base ?? {}) };
  for (const [policyId, sources] of Object.entries(override as Record<string, unknown>)) {
    if (typeof sources !== "object" || sources === null || Array.isArray(sources)) {
      continue;
    }
    const bySource: Partial<Record<string, SecurityAction>> = { ...(merged[policyId] ?? {}) };
    for (const [source, action] of Object.entries(sources as Record<string, unknown>)) {
      if (isSecurityAction(action)) {
        bySource[source] = action;
      }
    }
    merged[policyId] = bySource;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

// Merge the egress policy, carrying through a user-provided host allowlist
// (Block E, E3) and per-source policy overrides (GDCTX-2). The allowlist is
// only materialized when the source config provides a valid string[] — an
// absent or malformed value leaves the field undefined so the default config,
// its rendered form, and its `configChecksum` stay byte-identical to today
// (AC0.1, AC2.3). A non-empty allowlist IS included (and thus checksummed) so
// tampering is detected (§5).
//
// `sourceOverrides` (F1): unlike the allowlist, the SHIPPED default
// (`SHIPPED_EGRESS_SOURCE_OVERRIDES`) is never merged in here — `base` is
// `DEFAULT_SECURITY_CONFIG.policies.egress`, whose own `sourceOverrides` is
// intentionally absent (see that constant's comment), so `base.sourceOverrides`
// is always `undefined`. Only a `sourceOverrides` block the OPERATOR actually
// wrote in `security.config.json` is merged and thus checksummed; the shipped
// default is applied later, at resolution time
// (`resolve.ts#egressSourceOverrideAction`), never stored on the config object
// this function returns.
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
  const sourceOverrides = mergeSourceOverrides(base.sourceOverrides, override?.sourceOverrides);
  if (sourceOverrides !== undefined) {
    merged.sourceOverrides = sourceOverrides;
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

// Merge the optional `impactEvidence` block field-by-field over its defaults,
// but ONLY when the parsed config actually has the key — an absent key stays
// absent on the merged result (see `mergeSecurityConfig` below), which is
// what keeps `computeConfigChecksum` byte-identical for every config written
// before this feature shipped.
function mergeImpactEvidence(
  override: Partial<ImpactEvidenceConfig> | undefined,
): ImpactEvidenceConfig {
  const base = DEFAULT_IMPACT_EVIDENCE_CONFIG;
  const exemptGlobs = Array.isArray(override?.exemptGlobs)
    ? override.exemptGlobs.filter((g): g is string => typeof g === "string")
    : base.exemptGlobs;
  // F17 (review round 1): `dampenAfter` is a denial COUNT — zero or negative
  // would dampen (or never inject at all) on the very first touch, silently
  // neutering the gate. A valid override is clamped to a whole number >= 1;
  // anything else (including 0, negative, NaN, Infinity) falls back to the
  // default rather than being merged as-is.
  const dampenAfter =
    typeof override?.dampenAfter === "number" && Number.isFinite(override.dampenAfter) && override.dampenAfter >= 1
      ? Math.trunc(override.dampenAfter)
      : base.dampenAfter;
  return {
    enabled: override?.enabled ?? base.enabled,
    strict: override?.strict ?? base.strict,
    exemptGlobs,
    dampenAfter,
  };
}

/**
 * The effective `impactEvidence` block for `config` — defaults filled in
 * whether or not the config declared the key at all. Distinct from
 * `config.impactEvidence` itself, which stays `undefined` on a config that
 * never mentioned it (see `mergeSecurityConfig`); a caller that only wants
 * to KNOW the effective policy (the impact-evidence provider, `security
 * impact-evidence status`) should call this rather than read the field
 * directly and risk treating an absent block as "disabled".
 */
export function resolveImpactEvidenceConfig(config: SecurityConfig): ImpactEvidenceConfig {
  return config.impactEvidence ? mergeImpactEvidence(config.impactEvidence) : DEFAULT_IMPACT_EVIDENCE_CONFIG;
}

/**
 * F11 (review round 1, blocker-adjacent): `resolveImpactEvidenceConfig` above
 * takes `config.impactEvidence` on trust — including its `enabled: false`
 * kill switch — even when `configChecksum` does not verify (or the file
 * could not be read at all, `config.configUnreadable`). A tampered
 * `security.config.json` could flip `impactEvidence.enabled` to `false`
 * without resealing the checksum and the gate would honor it, which defeats
 * the entire point of checksumming the block in the first place (§14).
 *
 * When the checksum verifies, this is exactly `resolveImpactEvidenceConfig`.
 * When it does NOT — or the config could not be established at all — the
 * whole block is untrusted, not just `enabled`: `exemptGlobs` and
 * `dampenAfter` could just as easily be tuned to defeat the gate quietly
 * (exempt everything; dampen after 1). The fallback is the shipped defaults
 * (`enabled: true`, no exemptions, `dampenAfter: 3`), with one exception: a
 * tampered `strict: true` is honored, because a FALSE claim of strict mode is
 * strictly more protective, never a bypass, so there is no reason to distrust
 * it even from data we otherwise cannot trust.
 */
export function resolveImpactEvidenceConfigTrusted(config: SecurityConfig): {
  config: ImpactEvidenceConfig;
  tampered: boolean;
} {
  const resolved = resolveImpactEvidenceConfig(config);
  const checksum = verifyConfigChecksum(config);
  const tampered = !checksum.match || config.configUnreadable === true;
  if (!tampered) {
    return { config: resolved, tampered: false };
  }
  return {
    config: {
      ...DEFAULT_IMPACT_EVIDENCE_CONFIG,
      strict: resolved.strict === true ? true : DEFAULT_IMPACT_EVIDENCE_CONFIG.strict,
    },
    tampered: true,
  };
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
  // Flow 308 (W8, Lane B, T6): filled in ONLY when the parsed config
  // actually has the key — an absent key must stay absent on `merged` too
  // (never defaulted-in), which is what keeps `computeConfigChecksum`
  // byte-identical for a config written before this feature shipped.
  if (parsed.impactEvidence !== undefined) {
    merged.impactEvidence = mergeImpactEvidence(parsed.impactEvidence);
  }
  return merged;
}

/**
 * The closed `SecurityMode` union (`types.ts`), which the shipped config schema
 * also enumerates (`schemas.ts`), as a runtime check.
 *
 * `mergeSecurityConfig` takes `parsed.mode` on trust, and every consumer that
 * branches on the mode -- `isBlockingMode` in `guard.ts`, `exitCodeFor` and
 * `reportExitCode` in `commands/security.ts`, `MODE_RANK` in `self-protect.ts`
 * -- tests it for the STRICT values and falls through to the permissive side.
 * So a mode this build does not know (`"ENFORCED"`, a trailing space, a typo,
 * a schema drift between versions) used to make an enforced/ci workspace
 * report-only with no operator-visible signal at any decision point, and
 * `MODE_RANK[mode]` being `undefined` kept the §14 downgrade check silent about
 * it too (T39 F-002). That is the same shape T35 F-003 described for the config
 * file's SHAPE, one field further in: a declared posture this build cannot
 * recognize is an UNESTABLISHED posture, not a permissive one.
 */
const SECURITY_MODES: ReadonlySet<string> = new Set<SecurityMode>([
  "advisory",
  "enforced",
  "ci",
  "gateway",
]);

function isSecurityMode(value: unknown): value is SecurityMode {
  return typeof value === "string" && SECURITY_MODES.has(value);
}

// Load `.metaproject/security.config.json`, falling back to the built-in
// defaults when the file is ABSENT -- that is the ordinary, non-blocking
// "never configured" case and is unchanged from before.
//
// A file that EXISTS but cannot be read as one -- invalid JSON, or JSON that
// parses to something other than a plain object (`null`, an array, a number,
// a string) -- is a different case: the workspace's own posture cannot be
// established, so the result is the defaults with `mode` forced to
// `"enforced"` and `configUnreadable: true`, not the permissive `advisory`
// default a missing file gets (T35 F-003, the residual of T30 F-001/T33: a
// destroyed config used to silently downgrade an enforced/ci workspace to
// report-only with no operator-visible signal at any decision point).
// `guardOutput` and `securityFlowGate` treat `configUnreadable` through their
// existing posture-unavailable branches, so this stays leak-safe -- the flag
// carries no error text, path, or source bytes.
//
// A file that parses to a mergeable object but DECLARES a mode outside the
// closed `SecurityMode` union takes the same path (T39 F-002). The rest of that
// config is kept -- it parsed fine, and the operator's own `policies` and the
// `configChecksum` §14 verifies against them are still theirs -- but the mode
// is forced to `"enforced"` and the posture is flagged unreadable, because an
// unrecognized mode is a posture this build cannot establish and must never be
// more permissive than the strictest mode it can. An ABSENT `mode` key is not
// that case: it is the ordinary "no mode configured" a bare `{}` produces, and
// keeps resolving to the `advisory` default exactly as before.
export async function loadSecurityConfig(cwd: string): Promise<SecurityConfig> {
  const file = configPath(cwd);
  if (!(await pathExists(file))) {
    return mergeSecurityConfig({});
  }
  // `readJsonObjectFile` (`../lib/json`) answers the two questions this branch
  // has to tell apart -- "did it parse" and "is it the object `mergeSecurityConfig`
  // can merge" -- in one result. It replaces a module-local `Symbol` sentinel
  // and a local `isMergeableConfigPayload` predicate that existed only because
  // `readJsonFileOr` collapses a parse failure into whatever fallback is
  // passed, and `{}` is a value a real config file can also produce (T39
  // "Judgement calls" #4). The verdict is unchanged: a payload that does not
  // parse and a payload that parses to `null`/`[]`/`42`/`"advisory"` are both
  // a posture this workspace cannot establish.
  const read = await readJsonObjectFile(file);
  if (read.state !== "object") {
    return { ...mergeSecurityConfig({}), mode: "enforced", configUnreadable: true };
  }
  const parsed = read.value as Partial<SecurityConfig>;
  const merged = mergeSecurityConfig(parsed);
  // The value that must be recognized is the one the FILE declares. `merged.mode`
  // cannot answer this alone: `mergeSecurityConfig` applies `??`, so a present
  // `"mode": null` -- a key that is there and is not a mode -- would otherwise
  // arrive here already replaced by the permissive default.
  const declaredMode = read.value.mode;
  const configuredMode = declaredMode === undefined ? merged.mode : declaredMode;
  if (!isSecurityMode(configuredMode)) {
    return { ...merged, mode: "enforced", configUnreadable: true };
  }
  return merged;
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

/**
 * sha256 (hex) of `value` under the same key-sorted canonical JSON the config
 * checksum uses. Exported so other checksum-guarded config artifacts (flow 308:
 * the harness-audit baseline file) reuse this one mechanism instead of a second.
 */
export function computeObjectChecksum(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

// §14: `configChecksum` = sha256 of the normalized `policies` block.
//
// Flow 308 (W8, Lane B, T6): when `impactEvidence` is present, the checksum
// covers `{policies, impactEvidence}` instead — so tampering with the kill
// switch (`impactEvidence.enabled: false` without resealing) is caught the
// same way tampering with `policies` always was. When it is ABSENT the
// checksum is exactly `computeObjectChecksum(config.policies)`, unchanged
// from before this block existed, so every config written before this
// feature shipped keeps verifying against its existing checksum.
export function computeConfigChecksum(config: SecurityConfig): string {
  if (config.impactEvidence === undefined) {
    return computeObjectChecksum(config.policies);
  }
  return computeObjectChecksum({ policies: config.policies, impactEvidence: config.impactEvidence });
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
