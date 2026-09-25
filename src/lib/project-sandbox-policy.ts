// Project-level non-secret sandbox policy (P2).
//
// Path: <project-root>/.keryx/sandbox-policy.json
// Project root = git toplevel when available, else absolute cwd
// (same as session scoping — resolveProjectRoot).
//
// Never stores API key values. Resolution consumers use:
//   env > project policy > global sandbox.json > built-in
// All loaders are best-effort and never throw.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveProjectRoot } from "../session/paths";
import type { SandboxMaskModeDefault } from "./sandbox-config";
import { parseMaskSpec } from "../harness/process/sandbox/network-run";
import { writeContained } from "./contained-write";

/** Relative path under the project root. */
export const PROJECT_SANDBOX_POLICY_REL = path.join(".keryx", "sandbox-policy.json");

/**
 * Project policy shape (schema: project-sandbox-policy.schema.json).
 * extraMasks are NAME@host specs only — never secret values.
 */
export interface ProjectSandboxPolicy {
  maskMode?: SandboxMaskModeDefault;
  extraMasks?: string[];
  allowedDomains?: string[];
  tlsTerminate?: boolean;
}

const SECRET_KEY_PATTERN = /api[_-]?key|secret|token|password|credential/i;

function isMaskMode(v: unknown): v is SandboxMaskModeDefault {
  return v === "auto" || v === "manual" || v === "off";
}

/** Absolute path to the policy file for a cwd (or explicit project root). */
export function projectSandboxPolicyPath(cwdOrRoot: string): string {
  const root = resolveProjectRoot(cwdOrRoot);
  return path.join(root, PROJECT_SANDBOX_POLICY_REL);
}

/**
 * Sanitize raw JSON into ProjectSandboxPolicy.
 * Drops secret-shaped keys; keeps only valid extraMasks NAME@host specs.
 */
export function sanitizeProjectSandboxPolicy(raw: unknown): ProjectSandboxPolicy {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: ProjectSandboxPolicy = {};

  // Note: unknown/secret-shaped keys need no explicit stripping — `out` is built
  // by an allowlist below (maskMode / tlsTerminate / extraMasks / allowedDomains
  // only), so a key like `apiKey` or `token` is never copied in the first place.

  if (isMaskMode(obj.maskMode)) {
    out.maskMode = obj.maskMode;
  }
  if (typeof obj.tlsTerminate === "boolean") {
    out.tlsTerminate = obj.tlsTerminate;
  }
  if (Array.isArray(obj.extraMasks)) {
    const masks: string[] = [];
    for (const item of obj.extraMasks) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (trimmed.length === 0) continue;
      // Reject anything that looks like a secret assignment or lacks @host.
      if (SECRET_KEY_PATTERN.test(trimmed) && !trimmed.includes("@")) continue;
      if (parseMaskSpec(trimmed) === undefined) continue;
      masks.push(trimmed);
    }
    if (masks.length > 0) {
      out.extraMasks = masks;
    }
  }
  if (Array.isArray(obj.allowedDomains)) {
    const domains = obj.allowedDomains
      .filter((d): d is string => typeof d === "string")
      .map((d) => d.trim())
      .filter((d) => d.length > 0 && !SECRET_KEY_PATTERN.test(d));
    if (domains.length > 0) {
      out.allowedDomains = domains;
    }
  }
  return out;
}

/** Load policy; `{}` when missing/malformed. Never throws. */
export function loadProjectSandboxPolicy(cwdOrRoot: string): ProjectSandboxPolicy {
  try {
    const file = projectSandboxPolicyPath(cwdOrRoot);
    if (!existsSync(file)) {
      return {};
    }
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return sanitizeProjectSandboxPolicy(raw);
  } catch {
    return {};
  }
}

/**
 * Skeleton content for `keryx init` — comments via `_comment` fields are stripped
 * by sanitize on load; written as a JSON object with only safe keys.
 * Uses a companion README note in the skeleton string for operators.
 */
export function projectSandboxPolicySkeleton(): string {
  const body = {
    _comment:
      "Non-secret project sandbox policy. API keys: use `keryx shell` → /connect (user-global auth.json), never put secrets here.",
    maskMode: "manual",
    tlsTerminate: false,
    extraMasks: [] as string[],
    allowedDomains: [] as string[],
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * Write skeleton if missing. Does not overwrite an existing policy. Routed
 * through `writeContained` (root = project root, rel = the policy's
 * project-relative path) so a symlink at `.keryx/` or `.keryx/sandbox-policy.json`
 * that escapes the project is refused rather than followed (R5-F1-style
 * containment, mirrors the flow 313/315 T5 retrofit of init's other writers).
 * `exclusive: true` gives the "if missing" semantics directly — no separate
 * `existsSync` check, so there is no TOCTOU gap between the check and the
 * write. Returns true when a new file was written, false when a policy
 * already existed OR the write was refused (escaping symlink, cycle, etc.).
 * Never throws.
 */
export async function writeProjectSandboxPolicySkeletonIfMissing(cwdOrRoot: string): Promise<boolean> {
  try {
    const root = resolveProjectRoot(cwdOrRoot);
    await writeContained(root, PROJECT_SANDBOX_POLICY_REL, projectSandboxPolicySkeleton(), {
      mode: 0o644,
      exclusive: true,
    });
    return true;
  } catch {
    // Any refusal (already-exists, escaping-symlink, symlink-cycle, ...) or
    // unexpected I/O error is treated as "did not write" — see doc above.
    return false;
  }
}
