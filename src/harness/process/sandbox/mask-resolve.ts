// Credential-mask resolution for restricted-network sandbox runs (P0 auto-mask).
//
// Pure: same env + providers + explicit specs → same MaskResolution.
// Real secret values are NEVER part of the resolution object — callers read
// env[name] only when building MaskedCredential for setupNetworkRun.
//
// P0.a migration: unset mask mode defaults to **manual** (explicit MASK_ENV only).
// Opt in: KERYX_SANDBOX_MASK_MODE=auto (or harness --mask-mode auto / --auto-mask).
// P1: when env unset, maskMode/tls may come from ~/.local/share/keryx/sandbox.json.

import { envVarIsSet, loadSandboxDefaults } from "../../../lib/sandbox-config";
import { loadProjectSandboxPolicy } from "../../../lib/project-sandbox-policy";
import { parseMaskSpec } from "./network-run";

export type MaskMode = "auto" | "manual" | "off";

export interface ProviderMaskSource {
  envKey: string;
  baseUrl: string;
}

export interface ResolvedMask {
  name: string;
  injectHosts: string[];
  source: "auto" | "explicit" | "merged";
}

export interface MaskResolution {
  mode: MaskMode;
  masks: ResolvedMask[];
  tlsTerminate: boolean;
  tlsSource: "env" | "flag" | "auto-derived" | "defaults" | "off";
  notes: string[];
}

export type MaskResolveResult =
  | { ok: true; resolution: MaskResolution }
  | { ok: false; reason: string };

/**
 * Build the default auto-mask provider list: every OpenAI-compat registry entry
 * plus Anthropic. Callers pass `OPENAI_COMPAT_PROVIDERS` (or a test double).
 */
export function buildDefaultMaskProviders(
  openaiCompat: readonly { envKey: string; baseUrl: string }[],
): ProviderMaskSource[] {
  const out: ProviderMaskSource[] = [];
  for (const p of openaiCompat) {
    out.push({ envKey: p.envKey, baseUrl: p.baseUrl });
  }
  out.push({ envKey: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com" });
  return out;
}

/**
 * Parse mask mode. P0.a: unset / empty → `manual`. Invalid → `manual` with no throw
 * (callers that need fail-closed on invalid can use {@link parseMaskModeStrict}).
 */
export function parseMaskMode(raw: string | undefined): MaskMode {
  if (raw === undefined || raw.trim().length === 0) return "manual";
  const v = raw.trim().toLowerCase();
  if (v === "auto" || v === "manual" || v === "off") return v;
  return "manual";
}

/** Strict mode parse for CLI: invalid string is an error. */
export function parseMaskModeStrict(raw: string): MaskMode | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "auto" || v === "manual" || v === "off") return v;
  return undefined;
}

/**
 * TLS explicit tri-state from env:
 * - `1` / `true` / `on` → true
 * - `0` / `false` / `off` → false
 * - unset / empty → undefined
 */
export function tlsExplicitFromEnv(env: Record<string, string | undefined>): boolean | undefined {
  const raw = env.KERYX_SANDBOX_TLS_TERMINATE;
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return undefined;
}

/** Split `KERYX_SANDBOX_MASK_ENV` (`;`-separated NAME@host specs). */
export function splitMaskEnvSpecs(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim().length === 0) return [];
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function hostnameFromBaseUrl(baseUrl: string): string | undefined {
  try {
    const host = new URL(baseUrl).hostname;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve credential masks for a restricted-network run.
 *
 * @param allowAutoTls — when true (typically mode===auto), unset tls may become
 *   auto-derived true if masks are non-empty. When false, masks without explicit
 *   TLS fail closed (current manual behavior).
 */
export function resolveCredentialMasks(input: {
  mode: MaskMode;
  env: Record<string, string | undefined>;
  explicitSpecs: string[];
  providers: readonly ProviderMaskSource[];
  tlsExplicit?: boolean | undefined;
  allowAutoTls: boolean;
}): MaskResolveResult {
  const notes: string[] = [];
  const { mode, env, providers, allowAutoTls } = input;
  const tlsExplicit = input.tlsExplicit;

  if (mode === "off") {
    if (input.explicitSpecs.length > 0) {
      notes.push("maskMode=off: ignoring explicit mask specs");
    }
    return {
      ok: true,
      resolution: {
        mode,
        masks: [],
        tlsTerminate: false,
        tlsSource: "off",
        notes,
      },
    };
  }

  // Parse explicit specs (fail closed on any malformed entry).
  const explicitParsed: { name: string; injectHosts: string[] }[] = [];
  for (const spec of input.explicitSpecs) {
    const parsed = parseMaskSpec(spec);
    if (!parsed) {
      return {
        ok: false,
        reason: `invalid mask spec "${spec}" (expected NAME@host[,host])`,
      };
    }
    explicitParsed.push(parsed);
  }

  const byName = new Map<string, ResolvedMask>();

  if (mode === "auto") {
    for (const p of providers) {
      const value = env[p.envKey];
      if (typeof value !== "string" || value.length === 0) continue;
      const host = hostnameFromBaseUrl(p.baseUrl);
      if (host === undefined) {
        notes.push(`auto-mask skipped ${p.envKey}: invalid baseUrl`);
        continue;
      }
      byName.set(p.envKey, {
        name: p.envKey,
        injectHosts: [host],
        source: "auto",
      });
    }
  }

  if (mode === "auto" || mode === "manual") {
    for (const ex of explicitParsed) {
      const prev = byName.get(ex.name);
      if (prev !== undefined && prev.source === "auto") {
        byName.set(ex.name, {
          name: ex.name,
          injectHosts: ex.injectHosts,
          source: "merged",
        });
      } else if (prev !== undefined) {
        byName.set(ex.name, {
          name: ex.name,
          injectHosts: ex.injectHosts,
          source: "explicit",
        });
      } else {
        byName.set(ex.name, {
          name: ex.name,
          injectHosts: ex.injectHosts,
          source: "explicit",
        });
      }
    }
  }

  // Stable order: auto providers order first, then remaining explicit names.
  const masks: ResolvedMask[] = [];
  const seen = new Set<string>();
  if (mode === "auto") {
    for (const p of providers) {
      const m = byName.get(p.envKey);
      if (m !== undefined && !seen.has(m.name)) {
        masks.push(m);
        seen.add(m.name);
      }
    }
  }
  for (const ex of explicitParsed) {
    const m = byName.get(ex.name);
    if (m !== undefined && !seen.has(m.name)) {
      masks.push(m);
      seen.add(m.name);
    }
  }
  // Any leftover (shouldn't happen)
  for (const m of byName.values()) {
    if (!seen.has(m.name)) {
      masks.push(m);
      seen.add(m.name);
    }
  }

  if (masks.length === 0) {
    return {
      ok: true,
      resolution: {
        mode,
        masks: [],
        tlsTerminate: tlsExplicit === true,
        tlsSource: tlsExplicit === true ? "env" : "off",
        notes,
      },
    };
  }

  // Non-empty masks require TLS.
  if (tlsExplicit === false) {
    return {
      ok: false,
      reason:
        "credential masks require TLS termination, but TLS was explicitly disabled " +
        "(unset KERYX_SANDBOX_TLS_TERMINATE=0 or pass --tls-terminate)",
    };
  }

  if (tlsExplicit === true) {
    return {
      ok: true,
      resolution: {
        mode,
        masks,
        tlsTerminate: true,
        tlsSource: "env",
        notes,
      },
    };
  }

  // tlsExplicit === undefined
  if (allowAutoTls) {
    notes.push("tlsTerminate auto-derived because masks are non-empty");
    return {
      ok: true,
      resolution: {
        mode,
        masks,
        tlsTerminate: true,
        tlsSource: "auto-derived",
        notes,
      },
    };
  }

  return {
    ok: false,
    reason:
      "credential masks require TLS termination (set KERYX_SANDBOX_TLS_TERMINATE=1 or --tls-terminate; " +
      "or KERYX_SANDBOX_MASK_MODE=auto for auto-derived TLS when masks apply)",
  };
}

/**
 * Shared input builder used by shell_exec and harness so AC8 can compare
 * equivalent env + explicit specs + mode → same MaskResolution.
 *
 * Resolution order for mode / tls (P1 + P2):
 *   CLI override → process env → project policy → global sandbox.json → built-in.
 * Project `extraMasks` merge into explicitSpecs (after env MASK_ENV / CLI).
 */
export function resolveMasksFromSandboxEnv(input: {
  env: Record<string, string | undefined>;
  /** Extra explicit specs (e.g. harness --mask-env), merged with env MASK_ENV. */
  extraExplicitSpecs?: string[];
  /** Override mode (e.g. harness --mask-mode); else from KERYX_SANDBOX_MASK_MODE. */
  modeOverride?: MaskMode;
  /** Override TLS flag (e.g. harness --tls-terminate true). */
  tlsFlag?: boolean;
  providers: readonly ProviderMaskSource[];
  /**
   * Optional keryx data dir (for tests) so sandbox.json loads from a temp path
   * instead of the user home. Production callers omit this.
   */
  sandboxConfigDir?: string;
  /**
   * Project cwd/root for `.keryx/sandbox-policy.json` (P2). When omitted,
   * project policy is not loaded (P1-only behavior) — tests that only cover
   * global defaults should omit this; production shell/harness pass the root.
   */
  projectRoot?: string;
}): MaskResolveResult {
  const defaults = loadSandboxDefaults(input.sandboxConfigDir);
  const project =
    input.projectRoot !== undefined ? loadProjectSandboxPolicy(input.projectRoot) : {};

  let mode: MaskMode;
  if (input.modeOverride !== undefined) {
    mode = input.modeOverride;
  } else if (envVarIsSet(input.env.KERYX_SANDBOX_MASK_MODE)) {
    mode = parseMaskMode(input.env.KERYX_SANDBOX_MASK_MODE);
  } else if (project.maskMode !== undefined) {
    mode = project.maskMode;
  } else if (defaults.maskMode !== undefined) {
    mode = defaults.maskMode;
  } else {
    mode = "manual"; // P0.a built-in default
  }

  const explicitSpecs = [
    ...splitMaskEnvSpecs(input.env.KERYX_SANDBOX_MASK_ENV),
    ...(input.extraExplicitSpecs ?? []),
    ...(project.extraMasks ?? []),
  ];

  let tlsExplicit = tlsExplicitFromEnv(input.env);
  let tlsFromFile = false;
  if (tlsExplicit === undefined && typeof project.tlsTerminate === "boolean") {
    tlsExplicit = project.tlsTerminate;
    tlsFromFile = true;
  }
  if (tlsExplicit === undefined && typeof defaults.tlsTerminate === "boolean") {
    tlsExplicit = defaults.tlsTerminate;
    tlsFromFile = true;
  }
  if (input.tlsFlag === true) {
    tlsExplicit = true;
    tlsFromFile = false;
  }

  const allowAutoTls = mode === "auto";
  const result = resolveCredentialMasks({
    mode,
    env: input.env,
    explicitSpecs,
    providers: input.providers,
    tlsExplicit,
    allowAutoTls,
  });
  if (!result.ok || !tlsFromFile) {
    return result;
  }
  // Relabel tlsSource when the explicit TLS preference came from policy/file.
  if (result.resolution.tlsTerminate && result.resolution.tlsSource === "env") {
    return {
      ok: true,
      resolution: { ...result.resolution, tlsSource: "defaults" },
    };
  }
  return result;
}

/**
 * Allowed domains for restricted network: env wins if set; else project policy.
 * Pure helper for shell_exec profile building (P2).
 */
export function resolveAllowedDomains(
  env: Record<string, string | undefined>,
  projectRoot?: string,
): string[] {
  const raw = env.KERYX_SANDBOX_ALLOWED_DOMAINS;
  if (raw !== undefined && raw.trim().length > 0) {
    return raw
      .split(",")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);
  }
  if (projectRoot === undefined) return [];
  const project = loadProjectSandboxPolicy(projectRoot);
  return project.allowedDomains ?? [];
}
