// Hook config loading + merge (flow 306, W6, T5).
//
// Reads `<homeDir>/.keryx/hooks.json` (user scope) and
// `<projectRoot>/.metaproject/hooks.json` (project scope), validates each
// against the byte-identical runtime copy of `hook-config.schema.json`, and
// merges them over the fixed built-in declarations (`builtins.ts`) per
// workstreams/W6-shell-hooks.md's precedence: built-in -> user -> project,
// file order within each, ties by `id`.
//
// Fail-closed: an absent file is empty (no diagnostic); anything else wrong
// with a present file — invalid JSON, schema-invalid, an unrecognised major
// `schemaVersion`, a full registration colliding with a built-in id, or a
// duplicate full-registration id within one event — is an error diagnostic
// and the whole load reports `ok: false`. Nothing is silently dropped.
import { readFileSync } from "node:fs";
import path from "node:path";
import { validateAgainstSchemaObject } from "../../contracts/validator";
import { BUILTIN_HOOK_REGISTRATIONS } from "./builtins";
import HOOK_CONFIG_SCHEMA from "./hook-config.schema.json";
import { HOOK_EVENT_NAMES } from "./types";
import type { HookEventName, HookRegistration, HookScope } from "./types";
import type { PolicyProfileId } from "../policy/types";

export type HookConfigDiagnosticCode =
  | "invalid-json"
  | "schema-invalid"
  | "unknown-schema-version"
  | "hook-id-collides-with-builtin"
  | "hook-id-duplicate";

export interface HookConfigDiagnostic {
  code: HookConfigDiagnosticCode;
  message: string;
  scope: HookScope;
  path?: string;
}

export type LoadHookConfigResult =
  | { ok: true; registrations: HookRegistration[]; diagnostics: HookConfigDiagnostic[] }
  | { ok: false; diagnostics: HookConfigDiagnostic[] };

export interface LoadHookConfigInput {
  projectRoot: string;
  homeDir: string;
  /** Injectable file reader: returns file contents, or `undefined` when absent. Real errors (e.g. EACCES) throw. */
  readFile?: (filePath: string) => string | undefined;
}

/** Default `readFile`: absent file (ENOENT) reads as `undefined`; anything else rethrows. */
function defaultReadFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

interface ParsedHookDoc {
  hooks: Record<string, unknown[]>;
}

/** Whether `raw` is the disable-only override shape: exactly `{id, enabled: false}`. */
function isDisableOverride(raw: unknown): raw is { id: string; enabled: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 2 &&
    keys[0] === "enabled" &&
    keys[1] === "id" &&
    record.enabled === false &&
    typeof record.id === "string"
  );
}

/** Scan a (possibly schema-invalid) parsed doc for full registrations whose id collides with a built-in namespace. */
function scanForBuiltinCollisions(doc: unknown, scope: HookScope): HookConfigDiagnostic[] {
  const diagnostics: HookConfigDiagnostic[] = [];
  if (typeof doc !== "object" || doc === null) return diagnostics;
  const hooks = (doc as Record<string, unknown>).hooks;
  if (typeof hooks !== "object" || hooks === null) return diagnostics;
  for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== "object" || raw === null) continue;
      const record = raw as Record<string, unknown>;
      const id = record.id;
      if (
        typeof id === "string" &&
        id.startsWith("keryx.") &&
        record.command !== undefined &&
        !isDisableOverride(raw)
      ) {
        diagnostics.push({
          code: "hook-id-collides-with-builtin",
          message: `Hook id "${id}" collides with a built-in id (event ${event})`,
          scope,
          path: id,
        });
      }
    }
  }
  return diagnostics;
}

function majorOf(schemaVersion: string): string {
  return schemaVersion.split(".")[0] ?? "";
}

/**
 * Validate one already-parsed hook-config document. Used both by
 * {@link loadHookConfig} (per file) and directly by `keryx hooks validate`.
 */
export function validateHookConfigDocument(
  doc: unknown,
  scope: HookScope = "project",
  label = "hooks.json",
): { valid: true; hooks: Record<string, unknown[]> } | { valid: false; diagnostics: HookConfigDiagnostic[] } {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return {
      valid: false,
      diagnostics: [{ code: "schema-invalid", scope, path: label, message: `${label}: must be a JSON object` }],
    };
  }
  const record = doc as Record<string, unknown>;
  const schemaVersion = typeof record.schemaVersion === "string" ? record.schemaVersion : undefined;
  if (schemaVersion === undefined || majorOf(schemaVersion) !== "1") {
    return {
      valid: false,
      diagnostics: [
        {
          code: "unknown-schema-version",
          scope,
          path: label,
          message: `${label}: unrecognised schemaVersion "${String(record.schemaVersion)}"`,
        },
      ],
    };
  }
  const validation = validateAgainstSchemaObject(HOOK_CONFIG_SCHEMA, doc);
  if (!validation.valid) {
    const diagnostics: HookConfigDiagnostic[] = [
      {
        code: "schema-invalid",
        scope,
        path: label,
        message: `${label}: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
      },
      ...scanForBuiltinCollisions(doc, scope),
    ];
    return { valid: false, diagnostics };
  }
  const hooks = (record.hooks as Record<string, unknown[]> | undefined) ?? {};
  return { valid: true, hooks };
}

function normalizeFullRegistration(
  raw: Record<string, unknown>,
  event: HookEventName,
  scope: HookScope,
  order: number,
): HookRegistration {
  const command = raw.command as Record<string, unknown>;
  const commandCwd = typeof command.cwd === "string" ? command.cwd : undefined;
  const commandEnv = typeof command.env === "object" && command.env !== null ? (command.env as Record<string, string>) : undefined;
  const description = typeof raw.description === "string" ? raw.description : undefined;
  return {
    id: raw.id as string,
    event,
    matcher: typeof raw.matcher === "string" ? raw.matcher : "*",
    class: raw.class as HookRegistration["class"],
    handler: {
      kind: "command",
      argv: (command.argv as string[]) ?? [],
      ...(commandCwd !== undefined ? { cwd: commandCwd } : {}),
      ...(commandEnv !== undefined ? { env: commandEnv } : {}),
    },
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : 5000,
    runsIn: raw.runsIn === "unsandboxed" ? "unsandboxed" : "sandbox",
    network: raw.network === "restricted" ? "restricted" : "none",
    appliesToChildAgents: raw.appliesToChildAgents !== false,
    profiles: Array.isArray(raw.profiles) ? (raw.profiles as PolicyProfileId[]) : [],
    enabled: raw.enabled !== false,
    scope,
    order,
    ...(description !== undefined ? { description } : {}),
  };
}

export interface ResolveHookRegistrationsInput {
  builtins: readonly HookRegistration[];
  user?: ParsedHookDoc;
  project?: ParsedHookDoc;
}

/**
 * Merge already-validated (or absent) docs over the built-ins. Pure: no fs,
 * no clock. Applies disable-only overrides by id and rejects duplicate
 * full-registration ids within one event.
 */
export function resolveHookRegistrations(
  input: ResolveHookRegistrationsInput,
): { registrations: HookRegistration[]; diagnostics: HookConfigDiagnostic[] } {
  const registrations: HookRegistration[] = [];
  const diagnostics: HookConfigDiagnostic[] = [];
  let order = 0;

  for (const event of HOOK_EVENT_NAMES) {
    const byId = new Map<string, HookRegistration>();

    for (const reg of input.builtins) {
      if (reg.event !== event) continue;
      const resolved: HookRegistration = { ...reg, scope: "builtin", order: order++ };
      registrations.push(resolved);
      byId.set(resolved.id, resolved);
    }

    const layers: Array<{ scope: HookScope; doc: ParsedHookDoc | undefined }> = [
      { scope: "user", doc: input.user },
      { scope: "project", doc: input.project },
    ];

    for (const { scope, doc } of layers) {
      const rawList = doc?.hooks[event];
      if (!Array.isArray(rawList)) continue;
      for (const raw of rawList) {
        if (isDisableOverride(raw)) {
          const target = byId.get(raw.id);
          if (target !== undefined) {
            target.enabled = false;
          }
          continue;
        }
        const record = raw as Record<string, unknown>;
        const id = record.id as string;
        const existing = byId.get(id);
        if (existing !== undefined) {
          diagnostics.push({
            code: "hook-id-duplicate",
            message: `Duplicate hook id "${id}" for event ${event} (already registered at ${existing.scope} scope)`,
            scope,
            path: id,
          });
          continue;
        }
        const resolved = normalizeFullRegistration(record, event, scope, order++);
        registrations.push(resolved);
        byId.set(resolved.id, resolved);
      }
    }
  }

  return { registrations, diagnostics };
}

/**
 * Read, validate, and merge both config files over the built-in registrations.
 * Fail-closed: any diagnostic is an error here (there is no "warning that
 * still loads" case in v1) — a caller must treat `ok: false` as "hooks did
 * not load", never silently proceed with a partial set.
 */
export function loadHookConfig(input: LoadHookConfigInput): LoadHookConfigResult {
  const readFile = input.readFile ?? defaultReadFile;
  const userPath = path.join(input.homeDir, ".keryx", "hooks.json");
  const projectPath = path.join(input.projectRoot, ".metaproject", "hooks.json");

  const diagnostics: HookConfigDiagnostic[] = [];
  let user: ParsedHookDoc | undefined;
  let project: ParsedHookDoc | undefined;

  for (const { scope, filePath, assign } of [
    { scope: "user" as const, filePath: userPath, assign: (doc: ParsedHookDoc) => (user = doc) },
    { scope: "project" as const, filePath: projectPath, assign: (doc: ParsedHookDoc) => (project = doc) },
  ]) {
    const raw = readFile(filePath);
    if (raw === undefined) {
      assign({ hooks: {} });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      diagnostics.push({
        code: "invalid-json",
        scope,
        path: filePath,
        message: `${filePath}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }
    const validated = validateHookConfigDocument(parsed, scope, filePath);
    if (!validated.valid) {
      diagnostics.push(...validated.diagnostics);
      continue;
    }
    assign({ hooks: validated.hooks });
  }

  if (diagnostics.length > 0) {
    return { ok: false, diagnostics };
  }

  const merged = resolveHookRegistrations({
    builtins: BUILTIN_HOOK_REGISTRATIONS,
    ...(user !== undefined ? { user } : {}),
    ...(project !== undefined ? { project } : {}),
  });
  if (merged.diagnostics.length > 0) {
    return { ok: false, diagnostics: merged.diagnostics };
  }
  return { ok: true, registrations: merged.registrations, diagnostics: [] };
}
