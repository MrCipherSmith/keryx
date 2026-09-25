// Whether a PROJECT-scoped command hook in `.metaproject/hooks.json` may run
// at all (R700-01/R700-02, flow 319, lane A).
//
// The hole this closes: `.metaproject/hooks.json` is a committed file, and
// every one of its full registrations was merged straight into a session's
// `registrations` and executed at `SessionStart` — before the operator had
// read a single line of it. `git clone … && cd … && keryx shell` ran
// whatever `argv` the repository's author had written, `runsIn: "unsandboxed"`
// included. Cloning a repository is not consent to run its code — the exact
// shape `src/mcp-servers/trust.ts` closed for MCP servers, here for lifecycle
// hooks.
//
// The design mirrors that file on purpose:
//
//   - the record is keyed by what will EXECUTE, not by the file's name or a
//     "trusted: true" flag inside the file itself (a repository could write
//     that for itself). The digest covers argv/cwd/env/runsIn/network/etc —
//     see {@link digestProjectHooks} — so approving one version never
//     silently approves a later commit that changes the command.
//   - the record lives in the operator's own config directory
//     (`hooks-trust.json`, beside `mcp-servers-trust.json`), never in the
//     repository. A trust marker a repository can commit is not a trust
//     marker.
//
// USER-scope hooks (`~/.keryx/hooks.json`) need none of this: the operator
// wrote that file themselves, on this machine.
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  ensureKeryxConfigDir,
  isDefiniteAbsence,
  keryxConfigDir,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "../../lib/config-dir";
import { TerminalSafeTracker } from "../../lib/terminal-safe";
import type { HookRegistration } from "./types";

export const HOOKS_TRUST_FILENAME = "hooks-trust.json";
export const PROJECT_HOOKS_REL = ".metaproject/hooks.json";

export type ProjectHooksTrustState = "none" | "trusted" | "untrusted" | "changed";

export interface HooksTrustEntry {
  digest: string;
  trustedAt: string;
  hookIds: string[];
}

export type HooksTrustStore = Record<string, HooksTrustEntry>;

export type HooksTrustResult =
  | { readonly ok: true; readonly file: string }
  | { readonly ok: false; readonly error: string };

/** Path to the trust store. Does NOT create the directory — a reader must not conjure one into existence. */
export function hooksTrustFile(configDir?: string): string {
  return path.join(keryxConfigDir(configDir), HOOKS_TRUST_FILENAME);
}

/**
 * Realpath when possible, falling back to a plain resolve.
 *
 * A symlinked project root (or one that no longer exists, e.g. a deleted
 * test fixture) must still produce a stable, usable key — both the lookup
 * and the record side call this SAME function so they never disagree.
 */
function realpathOrResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The key one project's trust entry is filed under. */
export function projectHooksTrustKey(trustRoot: string): string {
  return `${realpathOrResolve(trustRoot)}::${PROJECT_HOOKS_REL}`;
}

function isValidEntry(value: unknown): value is HooksTrustEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.digest === "string" &&
    typeof record.trustedAt === "string" &&
    Array.isArray(record.hookIds) &&
    record.hookIds.every((id) => typeof id === "string")
  );
}

interface StoredShape {
  version: number;
  projects: Record<string, unknown>;
}

function isStoredShape(value: unknown): value is StoredShape {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.version === "number" && typeof record.projects === "object" && record.projects !== null;
}

/**
 * Load the trust store. `{}` on an absent, corrupt, or wrong-shape file —
 * fail closed: the cost of a bad read is re-approving, the alternative is a
 * corrupt/tampered file being read as blanket permission. A malformed
 * individual entry is dropped rather than poisoning the whole read.
 */
export function loadHooksTrustStore(configDir?: string): HooksTrustStore {
  const read = readConfigFile(hooksTrustFile(configDir));
  if (!read.ok) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch {
    return {};
  }
  if (!isStoredShape(parsed)) return {};
  const clean: HooksTrustStore = {};
  for (const [key, value] of Object.entries(parsed.projects)) {
    if (isValidEntry(value)) clean[key] = value;
  }
  return clean;
}

/** Key-order-independent sort so a `hooks enable/disable` rewrite of unrelated fields does not perturb the digest. */
function sortedEnv(env: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(env ?? {}).sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The digest material for one project full registration (D1): canonicalised
 * EXECUTABLE material, not raw file bytes. Excludes `description`,
 * `_keryxManaged`, and `schemaVersion` — none of them affect what runs — so
 * neither a `keryx hooks enable/disable` version-stamp rewrite nor a plain
 * reformat revokes trust on its own; only a change to what would actually
 * execute does.
 *
 * GUARD: if a future field is added to `HookRegistration` that affects
 * execution, it MUST be added here too — `trust.test.ts`'s "digest changes
 * when any executable field changes" table is what holds that true; it is
 * not enforced by the type system.
 */
function digestMaterialOf(reg: HookRegistration): unknown {
  if (reg.handler.kind !== "command") {
    throw new Error(`digestProjectHooks: expected a command handler, got "${reg.handler.kind}" for hook "${reg.id}"`);
  }
  return {
    event: reg.event,
    id: reg.id,
    matcher: reg.matcher,
    class: reg.class,
    argv: reg.handler.argv,
    cwd: reg.handler.cwd ?? null,
    env: sortedEnv(reg.handler.env),
    timeoutMs: reg.timeoutMs,
    runsIn: reg.runsIn,
    network: reg.network,
    appliesToChildAgents: reg.appliesToChildAgents,
    profiles: [...reg.profiles].sort(),
    enabled: reg.enabled,
  };
}

/**
 * `sha256:<hex>` of the canonicalised, ordered array of every project full
 * registration's digest material (D1). Array order is preserved — execution
 * order matters — so this is NOT independent of registration order, only of
 * object key order/whitespace within each entry.
 *
 * `regs` must all be scope `"project"` with a `command` handler; a caller
 * gets that from {@link extractProjectRegistrations} in `config.ts`.
 */
export function digestProjectHooks(regs: readonly HookRegistration[]): string {
  const material = regs.map((reg) => digestMaterialOf(reg));
  const hash = createHash("sha256").update(JSON.stringify(material)).digest("hex");
  return `sha256:${hash}`;
}

/**
 * D4: `none` when there are no project full registrations at all (nothing to
 * trust — never reported as untrusted), `trusted` when the stored digest for
 * this key matches, `changed` when an entry exists but the digest differs,
 * `untrusted` when there is no entry.
 */
export function projectHooksTrustState(
  key: string,
  digest: string | undefined,
  store: HooksTrustStore,
): ProjectHooksTrustState {
  if (digest === undefined) return "none";
  const entry = store[key];
  if (entry === undefined) return "untrusted";
  return entry.digest === digest ? "trusted" : "changed";
}

/**
 * Record trust for exactly this digest. Refuses (writes nothing) when the
 * store file exists but cannot be read — mirrors `approveServer`: a corrupt
 * file must not be silently replaced with a store that has "forgotten"
 * whatever else was in it.
 */
export function recordProjectHooksTrust(input: {
  trustRoot: string;
  digest: string;
  hookIds: readonly string[];
  configDir?: string;
  now?: () => Date;
}): HooksTrustResult {
  const file = hooksTrustFile(input.configDir);
  const read = readConfigFile(file);
  if (!read.ok && !isDefiniteAbsence(read.reason)) {
    return { ok: false, error: `${file} could not be read (${read.reason}); nothing was written` };
  }
  const store = loadHooksTrustStore(input.configDir);
  const key = projectHooksTrustKey(input.trustRoot);
  const now = input.now ?? (() => new Date());
  store[key] = {
    digest: input.digest,
    trustedAt: now().toISOString(),
    hookIds: [...input.hookIds],
  };
  ensureKeryxConfigDir(input.configDir);
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ version: 1, projects: store }, null, 2)}\n`);
  return { ok: true, file };
}

/** Withdraw trust for one project. A no-op (reported) when there was nothing to remove. */
export function revokeProjectHooksTrust(input: {
  trustRoot: string;
  configDir?: string;
}): HooksTrustResult & { removed?: boolean } {
  const file = hooksTrustFile(input.configDir);
  const read = readConfigFile(file);
  if (!read.ok && !isDefiniteAbsence(read.reason)) {
    return { ok: false, error: `${file} could not be read (${read.reason}); nothing was written` };
  }
  const store = loadHooksTrustStore(input.configDir);
  const key = projectHooksTrustKey(input.trustRoot);
  const existed = key in store;
  if (!existed) {
    return { ok: true, file, removed: false };
  }
  delete store[key];
  ensureKeryxConfigDir(input.configDir);
  writeOwnerOnlyFileAtomic(file, `${JSON.stringify({ version: 1, projects: store }, null, 2)}\n`);
  return { ok: true, file, removed: true };
}

/** One argv token, JSON-quoted only when it contains whitespace (so a plain command line stays readable). */
function quoteArg(arg: string): string {
  return /\s/.test(arg) ? JSON.stringify(arg) : arg;
}

/**
 * R1-03 (flow 319 review round 1): trust is bound to argv/cwd/env/etc — the
 * COMMAND LINE — never to the bytes of a script or binary that command line
 * runs. A hook `argv: ["/bin/sh", "scripts/h.sh"]` stays digest-stable while
 * `scripts/h.sh` is rewritten to anything, and the operator gets no re-trust
 * prompt. When an argv token resolves to a real file inside the project,
 * this surfaces that gap right where the operator is deciding to trust —
 * one line per distinct matching token, using the RAW (unsanitised) token
 * only to resolve/check existence; the printed form still goes through
 * `safe.render`.
 */
function repoRelativeScriptNotes(reg: HookRegistration, projectRoot: string, safe: TerminalSafeTracker): string[] {
  if (reg.handler.kind !== "command") return [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const token of reg.handler.argv) {
    if (token.length === 0) continue;
    const candidate = path.isAbsolute(token) ? path.resolve(token) : path.resolve(projectRoot, token);
    const relativeToRoot = path.relative(projectRoot, candidate);
    // Must land strictly inside projectRoot: not the root itself, and no
    // ".." escape.
    if (relativeToRoot === "" || relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) continue;
    if (path.isAbsolute(relativeToRoot)) continue;
    if (seen.has(candidate)) continue;
    let isFile: boolean;
    try {
      isFile = statSync(candidate).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) continue;
    seen.add(candidate);
    notes.push(
      `    NOTE: ${safe.render(reg.id)} runs ${safe.render(token)} from this repository; trust does not cover changes to that file.`,
    );
  }
  return notes;
}

/**
 * Lines describing one project hook for `keryx hooks trust`'s approval
 * display (§3 of the design). Never includes an env VALUE — only the keys —
 * for the same reason `describeForApproval` in `mcp-servers/trust.ts` omits
 * credential values: this text is shown at the exact moment the operator is
 * paying attention, and is the last place a secret should appear.
 *
 * R1-02 (flow 319 review round 1): every string below comes straight out of
 * `.metaproject/hooks.json` — a committed file an attacker fully controls —
 * and is rendered through `TerminalSafeTracker` before it ever reaches
 * `console.log`. A token with no whitespace used to skip `quoteArg`'s
 * JSON-quoting entirely and reach the terminal with raw control bytes
 * (ESC/CSI, bidi overrides, zero-width characters) intact, letting it
 * repaint the operator's screen at the exact moment they decide whether to
 * trust the file. `escaped` on the result tells the caller whether anything
 * needed escaping, so it can print the one-line warning that follows.
 */
export function describeProjectHookForApproval(
  reg: HookRegistration,
  opts: { projectRoot: string },
): { lines: string[]; escaped: boolean } {
  if (reg.handler.kind !== "command") return { lines: [], escaped: false };
  const safe = new TerminalSafeTracker();
  const id = safe.render(reg.id);
  const matcher = safe.render(reg.matcher);
  const disabledSuffix = reg.enabled ? "" : "  (disabled)";
  const header = `  ${id}  ${reg.event} matcher=${matcher}  class=${reg.class}  runsIn=${
    reg.runsIn === "unsandboxed" ? "UNSANDBOXED" : "sandbox"
  }  network=${reg.network}${disabledSuffix}`;
  const argvLine = `    ${reg.handler.argv.map((arg) => quoteArg(safe.render(arg))).join(" ")}`;
  const lines = [header, argvLine];
  const extras: string[] = [];
  if (reg.handler.cwd !== undefined) extras.push(`cwd=${safe.render(reg.handler.cwd)}`);
  const envEntries = sortedEnv(reg.handler.env);
  if (envEntries.length > 0) {
    extras.push(`env: ${envEntries.map(([k, v]) => `${safe.render(k)}=${safe.render(v)}`).join(", ")}`);
  }
  if (extras.length > 0) lines.push(`    ${extras.join("  ")}`);
  lines.push(...repoRelativeScriptNotes(reg, opts.projectRoot, safe));
  return { lines, escaped: safe.escaped };
}
