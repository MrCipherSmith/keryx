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
import { readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveKeryxHomeDir } from "../../lib/keryx-home";
import { validateAgainstSchemaObject } from "../../contracts/validator";
import { BUILTIN_HOOK_REGISTRATIONS } from "./builtins";
import HOOK_CONFIG_SCHEMA from "./hook-config.schema.json";
import {
  digestProjectHooks,
  loadHooksTrustStore,
  PROJECT_HOOKS_REL,
  projectHooksTrustKey,
  projectHooksTrustState,
} from "./trust";
import type { HooksTrustStore, ProjectHooksTrustState } from "./trust";
import { HOOK_EVENT_NAMES } from "./types";
import type { HookClass, HookEventName, HookRegistration, HookScope } from "./types";
import type { PolicyProfileId } from "../policy/types";

export type HookConfigDiagnosticCode =
  | "invalid-json"
  | "schema-invalid"
  | "unknown-schema-version"
  | "hook-id-collides-with-builtin"
  | "hook-id-duplicate"
  | "project-gate-disable-ignored"
  | "gate-disable-unacknowledged"
  | "user-home-inside-project";

export interface HookConfigDiagnostic {
  code: HookConfigDiagnosticCode;
  message: string;
  scope: HookScope;
  path?: string;
}

/**
 * R700-02 (D10/D11): the value a USER-scope disable override of a protected
 * built-in gate must carry for the override to take effect. Without it the
 * override is ignored (with a warning) — a project file can NEVER disable a
 * built-in gate, acknowledged or not (D12).
 */
export const GATE_DISABLE_ACKNOWLEDGEMENT = "disable-builtin-gate";

/** `class`es with decision power — protected by the tighten-only rule (D10). `observe`/`context` may be disabled from either scope. */
export function isProtectedBuiltinClass(cls: HookClass): boolean {
  return cls === "gate" || cls === "gate-advisory";
}

/** One built-in gate a USER scope file has turned off, for notices/`disabledBuiltinGates`. */
export interface DisabledBuiltinGate {
  id: string;
  file: string;
}

/** R700-01 (D4): the project file's trust state, plus every project full registration (trusted or not) for `list`/`trust`/notices. */
export interface ProjectHooksReport {
  state: ProjectHooksTrustState;
  filePath: string;
  trustKey: string;
  /** Absent only when `state === "none"`. */
  digest?: string;
  hooks: HookRegistration[];
}

export type LoadHookConfigResult =
  | {
      ok: true;
      registrations: HookRegistration[];
      diagnostics: HookConfigDiagnostic[];
      warnings: HookConfigDiagnostic[];
      projectHooks: ProjectHooksReport;
      disabledBuiltinGates: DisabledBuiltinGate[];
    }
  | { ok: false; diagnostics: HookConfigDiagnostic[] };

export interface LoadHookConfigInput {
  projectRoot: string;
  homeDir: string;
  /** Injectable file reader: returns file contents, or `undefined` when absent. Real errors (e.g. EACCES) throw. */
  readFile?: (filePath: string) => string | undefined;
  /**
   * R700-01: where project-hook trust is looked up. Omitted `trustRoot`
   * defaults to `projectRoot` — the one case that differs is trigger-dispatch,
   * which reads hooks from a worktree (`projectRoot`) but must look trust up
   * under the MAIN project root, because that is what the operator actually
   * approved (D9). Omitted `store` reads it fresh via `loadHooksTrustStore`;
   * a caller that already has one loaded (e.g. `keryx hooks list` rendering
   * several sections) can pass it to avoid re-reading the file.
   */
  projectTrust?: { configDir?: string; trustRoot?: string; store?: HooksTrustStore };
}

/**
 * Shared home-dir resolver for `~/.keryx/hooks.json` — `KERYX_HOME` first (an
 * explicit `homeDir` override, e.g. from a test, wins over even that), then
 * the real `os.homedir()`.
 *
 * Flow 306 fix round 2 (finding E): moved down from `commands/agent-hooks.ts`
 * (review finding 11's fix) because it is a PURE function of `env`/`homeDir`
 * with no dependency on `commands/`, and `src/lib/serve-turn.ts` — which
 * `lib/` rule forbids importing from `commands/` — needed the exact same
 * resolution `keryx hooks` and `buildShellHookRuntime` already share, not a
 * third copy calling `os.homedir()` unconditionally (which is what it had:
 * `serve-turn.ts` never honored a `KERYX_HOME` override at all).
 * `commands/agent-hooks.ts` and `commands/hooks.ts` both now call this one
 * function too, so all three call sites resolve the same home directory.
 *
 * Flow 313 (W4): delegates to the shared resolver in `src/lib/keryx-home.ts`.
 */
export function resolveHookHomeDir(env: NodeJS.ProcessEnv, homeDir?: string): string {
  return resolveKeryxHomeDir(env, homeDir);
}

/**
 * Realpath when possible, falling back to a plain resolve — mirrors
 * `realpathOrResolve` in `./trust.ts` (not exported from there, so this is a
 * second small copy rather than a cross-module reach-in for one helper). A
 * path that does not exist yet (e.g. `~/.keryx` before it has ever been
 * created) must still produce a stable, comparable value.
 */
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * R1-01 (flow 319, review round 1, blocker): a USER-scope `hooks.json` is
 * exempt from the trust gate entirely — the whole design's premise is "the
 * operator put this here themselves, on this machine" (see this file's own
 * header). `KERYX_HOME` (which `resolveKeryxHomeDir` resolves `homeDir`
 * from) is an ordinary environment variable, and Bun's shipped `dist/cli.js`
 * shebang used to auto-load a `.env` file from the process's CURRENT WORKING
 * DIRECTORY into `process.env` — so a cloned, hostile repository could commit
 * a `.env` setting `KERYX_HOME` to a directory INSIDE itself, plant a fully
 * un-gated, un-prompted `<that dir>/.keryx/hooks.json` there, and have it
 * treated as trusted user scope on a plain `keryx shell`. The real fix is
 * that keryx no longer starts under a shell that auto-loads a cwd `.env` or
 * `bunfig.toml` (see `src/cli.ts`'s shebang and `src/lib/safe-exec.ts`'s
 * startup guard) — this is defence in depth for whatever reaches here
 * anyway (a caller that resolves `homeDir` some other way, a future
 * regression in the shebang/guard, `KERYX_HOME` set some other way that
 * still lands inside the project).
 *
 * If the user-scope home's `.keryx` directory resolves (realpath) inside —
 * or equal to — the current project root, refuse it: fall back to the REAL
 * OS home directory (`os.homedir()`, never `env`/`homeDir` again — both are
 * exactly what a repo can steer) and report a warning so the operator sees
 * why their `KERYX_HOME` had no effect. An explicit test `homeDir` override
 * that legitimately points elsewhere (the normal case: a sibling tmp
 * directory, not inside the project fixture) is unaffected — this only ever
 * triggers when the resolved directory is actually inside/equal to the
 * project root, which is exactly the case a legitimate override does not hit.
 */
function guardUserHomeDir(
  homeDir: string,
  projectRoot: string,
): { homeDir: string; warning?: HookConfigDiagnostic } {
  const userKeryxDir = path.join(homeDir, ".keryx");
  const projectReal = realpathOrResolve(projectRoot);
  const userReal = realpathOrResolve(userKeryxDir);
  const inside = userReal === projectReal || userReal.startsWith(projectReal + path.sep);
  if (!inside) return { homeDir };
  return {
    homeDir: os.homedir(),
    warning: {
      code: "user-home-inside-project",
      scope: "user",
      path: userKeryxDir,
      message: `keryx hooks: ignored user hooks at ${userKeryxDir}: KERYX_HOME points inside this project, so a repository could supply them. Set KERYX_HOME outside the project.`,
    },
  };
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

/**
 * Whether `raw` is the disable-only override shape: `{id, enabled: false}`,
 * optionally with `acknowledge` (R700-02, D11) — never any other key.
 */
export function isDisableOverride(raw: unknown): raw is { id: string; enabled: false; acknowledge?: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const keys = new Set(Object.keys(record));
  if (!keys.has("id") || !keys.has("enabled")) return false;
  keys.delete("id");
  keys.delete("enabled");
  keys.delete("acknowledge");
  if (keys.size !== 0) return false;
  if (record.enabled !== false || typeof record.id !== "string") return false;
  if ("acknowledge" in record && typeof record.acknowledge !== "string") return false;
  return true;
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

/**
 * Every project full registration (never a disable override), normalised,
 * in file order per event, in `HOOK_EVENT_NAMES` order — exactly the array
 * {@link digestProjectHooks} (D1) and `ProjectHooksReport.hooks` need.
 */
export function extractProjectRegistrations(hooks: Record<string, unknown[]>): HookRegistration[] {
  const regs: HookRegistration[] = [];
  let order = 0;
  for (const event of HOOK_EVENT_NAMES) {
    const rawList = hooks[event];
    if (!Array.isArray(rawList)) continue;
    for (const raw of rawList) {
      if (isDisableOverride(raw)) continue;
      regs.push(normalizeFullRegistration(raw as Record<string, unknown>, event, "project", order++));
    }
  }
  return regs;
}

export interface ResolveHookRegistrationsInput {
  builtins: readonly HookRegistration[];
  user?: ParsedHookDoc;
  project?: ParsedHookDoc;
  userFile?: string;
  projectFile?: string;
}

/**
 * Merge already-validated (or absent) docs over the built-ins. Pure: no fs,
 * no clock. Applies disable-only overrides by id and rejects duplicate
 * full-registration ids within one event.
 *
 * R700-02 (D10/D11): an override that targets a PROTECTED built-in (`gate`/
 * `gate-advisory`) is handled specially instead of being applied like any
 * other disable — see the per-branch comments below. `observe`/`context`
 * built-ins (only `keryx.learning-observer` today) are unaffected: either
 * scope may disable them, exactly as before this flow.
 */
export function resolveHookRegistrations(
  input: ResolveHookRegistrationsInput,
): {
  registrations: HookRegistration[];
  diagnostics: HookConfigDiagnostic[];
  warnings: HookConfigDiagnostic[];
  disabledBuiltinGates: DisabledBuiltinGate[];
} {
  const registrations: HookRegistration[] = [];
  const diagnostics: HookConfigDiagnostic[] = [];
  const warnings: HookConfigDiagnostic[] = [];
  const disabledBuiltinGates: DisabledBuiltinGate[] = [];
  const warnedGateIds = new Set<string>();
  const disabledGateIds = new Set<string>();
  let order = 0;

  for (const event of HOOK_EVENT_NAMES) {
    const byId = new Map<string, HookRegistration>();

    for (const reg of input.builtins) {
      if (reg.event !== event) continue;
      const resolved: HookRegistration = { ...reg, scope: "builtin", order: order++ };
      registrations.push(resolved);
      byId.set(resolved.id, resolved);
    }

    const layers: Array<{ scope: HookScope; doc: ParsedHookDoc | undefined; file: string | undefined }> = [
      { scope: "user", doc: input.user, file: input.userFile },
      { scope: "project", doc: input.project, file: input.projectFile },
    ];

    for (const { scope, doc, file } of layers) {
      const rawList = doc?.hooks[event];
      if (!Array.isArray(rawList)) continue;
      for (const raw of rawList) {
        if (isDisableOverride(raw)) {
          const target = byId.get(raw.id);
          if (target === undefined) continue;
          if (target.scope === "builtin" && isProtectedBuiltinClass(target.class)) {
            if (scope === "project") {
              if (!warnedGateIds.has(`project:${target.id}`)) {
                warnedGateIds.add(`project:${target.id}`);
                warnings.push({
                  code: "project-gate-disable-ignored",
                  scope,
                  path: target.id,
                  message: `keryx hooks: ignored the disable of built-in gate ${target.id} in ${
                    file ?? PROJECT_HOOKS_REL
                  }: a project file cannot turn off a built-in gate. The gate stays on.`,
                });
              }
              continue;
            }
            // scope === "user"
            if (raw.acknowledge !== GATE_DISABLE_ACKNOWLEDGEMENT) {
              if (!warnedGateIds.has(`user:${target.id}`)) {
                warnedGateIds.add(`user:${target.id}`);
                warnings.push({
                  code: "gate-disable-unacknowledged",
                  scope,
                  path: target.id,
                  message: `keryx hooks: ignored the disable of built-in gate ${target.id} in ${
                    file ?? "~/.keryx/hooks.json"
                  }: it needs "acknowledge": "disable-builtin-gate". The gate stays on. To turn it off for yourself, run: keryx hooks disable ${
                    target.id
                  } --user --acknowledge-gate-risk`,
                });
              }
              continue;
            }
            target.enabled = false;
            if (!disabledGateIds.has(target.id)) {
              disabledGateIds.add(target.id);
              disabledBuiltinGates.push({ id: target.id, file: file ?? "~/.keryx/hooks.json" });
            }
            continue;
          }
          // Not a protected built-in (observe/context built-in, or a
          // project/user full registration already merged): disable applies
          // as before this flow.
          target.enabled = false;
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

  return { registrations, diagnostics, warnings, disabledBuiltinGates };
}

/**
 * Validate + extract + digest a raw project hooks.json document in one call
 * — `undefined` when the document is invalid, or has no full registrations
 * (nothing to digest/trust). Used by `keryx hooks` for enable/disable
 * carry-over (D13): comparing the digest before and after a CLI-driven
 * rewrite, without duplicating the validate/extract/digest sequence.
 */
export function projectHooksDigestOfDoc(doc: unknown): string | undefined {
  const validated = validateHookConfigDocument(doc, "project");
  if (!validated.valid) return undefined;
  const regs = extractProjectRegistrations(validated.hooks);
  if (regs.length === 0) return undefined;
  return digestProjectHooks(regs);
}

/**
 * Read, validate, and merge both config files over the built-in registrations.
 * Fail-closed: any diagnostic is an error here (there is no "warning that
 * still loads" case in v1) — a caller must treat `ok: false` as "hooks did
 * not load", never silently proceed with a partial set. Validation/merge run
 * over the FULL project file regardless of trust (D5) — trust only gates
 * whether the resulting project registrations are allowed into the
 * `registrations` a runtime executes.
 */
export function loadHookConfig(input: LoadHookConfigInput): LoadHookConfigResult {
  const readFile = input.readFile ?? defaultReadFile;
  const homeGuard = guardUserHomeDir(input.homeDir, input.projectRoot);
  const userPath = path.join(homeGuard.homeDir, ".keryx", "hooks.json");
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
    userFile: userPath,
    projectFile: projectPath,
  });
  if (merged.diagnostics.length > 0) {
    return { ok: false, diagnostics: merged.diagnostics };
  }

  // R700-01: project-hook trust (D2/D9). The digest comes from the SAME
  // parsed `project` doc `resolveHookRegistrations` just merged — never a
  // second read — so there is no TOCTOU between what was validated/shown and
  // what is checked for trust. `projectTrust.trustRoot` lets a caller (only
  // trigger-dispatch today) look trust up under the MAIN project root while
  // still digesting the WORKTREE's hooks.json — the file actually loaded
  // above via `input.projectRoot` (D9): trust is recorded against the main
  // root's key, but the digest inside that record is always of the exact
  // document that will execute, wherever it was read from. A worktree with
  // an identical hooks.json therefore matches; one with a different
  // hooks.json digests differently and reports `changed`, never silently
  // running content the operator never saw.
  const trustRoot = input.projectTrust?.trustRoot ?? input.projectRoot;
  const trustStore = input.projectTrust?.store ?? loadHooksTrustStore(input.projectTrust?.configDir);
  const trustKey = projectHooksTrustKey(trustRoot);
  const projectRegs = extractProjectRegistrations(project?.hooks ?? {});
  const digest = projectRegs.length > 0 ? digestProjectHooks(projectRegs) : undefined;
  const state = projectHooksTrustState(trustKey, digest, trustStore);

  let registrations = merged.registrations;
  if (state === "untrusted" || state === "changed") {
    // D5: removed from `registrations`, not merely disabled — so no code
    // path that ignores `enabled` (e.g. a future `hooks test` bypass) can
    // run them, and a child agent cannot inherit them (`forChild` only ever
    // sees `registrations`).
    registrations = registrations.filter((r) => r.scope !== "project");
  }

  return {
    ok: true,
    registrations,
    diagnostics: [],
    warnings: homeGuard.warning !== undefined ? [homeGuard.warning, ...merged.warnings] : merged.warnings,
    projectHooks: {
      state,
      filePath: projectPath,
      trustKey,
      ...(digest !== undefined ? { digest } : {}),
      hooks: projectRegs,
    },
    disabledBuiltinGates: merged.disabledBuiltinGates,
  };
}
