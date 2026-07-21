// Project-level non-secret sandbox policy (P2).
//
// Path: <project-root>/.keryx/sandbox-policy.json
// Project root = git toplevel when available, else absolute cwd
// (same as session scoping — resolveProjectRoot).
//
// Never stores API key values. Resolution consumers use:
//   env > project policy > global sandbox.json > built-in
// All loaders are best-effort and never throw.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveProjectRoot } from "../session/paths";
import type { SandboxMaskModeDefault } from "./sandbox-config";
import { parseMaskSpec } from "../harness/process/sandbox/network-run";

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

  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      continue;
    }
  }

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
 * Write skeleton if missing. Does not overwrite an existing policy.
 * Returns true when a new file was written. Never throws.
 */
export function writeProjectSandboxPolicySkeletonIfMissing(cwdOrRoot: string): boolean {
  try {
    const file = projectSandboxPolicyPath(cwdOrRoot);
    if (existsSync(file)) {
      return false;
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, projectSandboxPolicySkeleton(), { mode: 0o644 });
    return true;
  } catch {
    return false;
  }
}
