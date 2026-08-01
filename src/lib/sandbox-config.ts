// Global non-secret sandbox defaults (P1).
//
// Stored next to auth.json as `sandbox.json` (owner-only 0600). Never holds API
// keys — only shell mode, maskMode, and tlsTerminate preference.
// Resolution order for consumers: process env > this file > built-in defaults.
// All functions are best-effort and never throw; `dir` override is for tests.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, writeOwnerOnlyFile } from "./config-dir";
import { shellConfigPath } from "./shell-config";

/** Allowed values for the `shell` field (mirrors KERYX_SANDBOX_SHELL surface). */
export type SandboxShellDefault = "off" | "workspace" | "strict" | "1";

/** Allowed mask modes (mirrors KERYX_SANDBOX_MASK_MODE). */
export type SandboxMaskModeDefault = "auto" | "manual" | "off";

/**
 * User-global sandbox defaults. Must never include API key material.
 * @see docs/requirements/keryx-sandbox-credential-auto-mask/schemas/sandbox-defaults.schema.json
 */
export interface SandboxDefaults {
  shell?: SandboxShellDefault;
  tlsTerminate?: boolean;
  maskMode?: SandboxMaskModeDefault;
}

const SECRET_KEY_PATTERN = /api[_-]?key|secret|token|password|credential/i;

/** Absolute path to `sandbox.json` (same directory as `auth.json`). */
export function sandboxConfigPath(dir?: string): string {
  return path.join(path.dirname(shellConfigPath(dir)), "sandbox.json");
}

function isShellDefault(v: unknown): v is SandboxShellDefault {
  return v === "off" || v === "workspace" || v === "strict" || v === "1";
}

function isMaskModeDefault(v: unknown): v is SandboxMaskModeDefault {
  return v === "auto" || v === "manual" || v === "off";
}

/**
 * Parse and sanitize a raw JSON object into SandboxDefaults.
 * Drops unknown keys and anything that looks like a secret field name.
 */
export function sanitizeSandboxDefaults(raw: unknown): SandboxDefaults {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const out: SandboxDefaults = {};
  for (const key of Object.keys(obj)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      continue; // never load secret-shaped keys
    }
  }
  if (isShellDefault(obj.shell)) {
    out.shell = obj.shell;
  }
  if (typeof obj.tlsTerminate === "boolean") {
    out.tlsTerminate = obj.tlsTerminate;
  }
  if (isMaskModeDefault(obj.maskMode)) {
    out.maskMode = obj.maskMode;
  }
  return out;
}

/** Read sandbox.json; `{}` when absent/unreadable/malformed. Never throws. */
export function loadSandboxDefaults(dir?: string): SandboxDefaults {
  try {
    const file = sandboxConfigPath(dir);
    if (!existsSync(file)) {
      return {};
    }
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    return sanitizeSandboxDefaults(raw);
  } catch {
    return {};
  }
}

/**
 * Merge `patch` into sandbox.json (0600). Strips secret-shaped keys from patch.
 * Best-effort; never throws.
 */
export function saveSandboxDefaults(patch: Partial<SandboxDefaults>, dir?: string): void {
  try {
    const sanitizedPatch = sanitizeSandboxDefaults(patch);
    // Through the shared helpers: a mode passed to `mkdirSync`/`writeFileSync`
    // applies at creation only, and this writer shares a directory with
    // `auth.json`. See `ensureKeryxConfigDir`.
    ensureKeryxConfigDir(path.dirname(sandboxConfigPath(dir)));
    const next: SandboxDefaults = { ...loadSandboxDefaults(dir), ...sanitizedPatch };
    // Re-sanitize the merge so we never persist junk.
    const clean = sanitizeSandboxDefaults(next);
    writeOwnerOnlyFile(sandboxConfigPath(dir), `${JSON.stringify(clean, null, 2)}\n`);
  } catch {
    // best-effort
  }
}

/**
 * Whether an env var is "set" for override purposes (non-empty after trim).
 */
export function envVarIsSet(value: string | undefined): boolean {
  return value !== undefined && value.trim().length > 0;
}
