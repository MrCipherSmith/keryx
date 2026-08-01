// The `keryx serve` configuration (flow 128 / roadmap R4b).
//
// Shape and constraints come from
// docs/requirements/keryx-remote-entry/schemas/remote-entry-config.schema.json.
// The schema is `additionalProperties: false` and states, in its own
// description, that "a raw bearer token is forbidden in this document" — the
// token lives only in the credential store (src/lib/serve-credential.ts) and is
// referenced here by an opaque id.
//
// That prohibition is enforced STRUCTURALLY rather than by a name heuristic:
// `projectServeConfig` projects only the keys the schema declares, at every
// level, and `saveServeConfig` writes nothing else. A key outside the schema
// cannot reach the file, whatever it is called.
//
// R4a's `stripSecretShapedFields` is deliberately NOT reused here. Its
// SECRET_WORDS set contains "credential", so it would delete `credentialRef` —
// the one field this schema requires. A filter that removes the safe reference
// and keeps an unrecognised key would be worse than no filter at all.
//
// Every function is best-effort and never throws: a damaged serve.json must
// leave the operator with "nothing is configured", not a stack trace.

import { existsSync } from "node:fs";
import path from "node:path";
import { ensureKeryxConfigDir, keryxConfigDir, readConfigFile, writeOwnerOnlyFile } from "./config-dir";

export const SERVE_CONFIG_SCHEMA_VERSION = "1.0.0";

/** Loopback by default. Non-loopback needs a flag AND an acknowledgement. */
export const DEFAULT_SERVE_BIND_ADDRESS = "127.0.0.1";
/** Arbitrary but stable; chosen from the IANA dynamic range. */
export const DEFAULT_SERVE_PORT = 7377;
/**
 * Name only. This slice runs no turn and evaluates no policy decision, so the
 * profile is carried and reported, never resolved. Resolution — and the
 * non-weakening check in specification.md AC-04 — belongs with the slice that
 * actually runs a turn.
 */
export const DEFAULT_SERVE_PROFILE = "remote-restricted";

export interface ServeBind {
  address: string;
  /** 1..65535 on disk. 0 is legal only for an in-memory test configuration. */
  port: number;
  acknowledgeNonLoopback?: boolean;
}

export interface ServeCredentialRef {
  store: "auth-json" | "os-credential-store";
  /** Opaque. Not a token, and not usable as one. */
  id: string;
}

export interface ServeApproval {
  expirySeconds: number;
  maxPendingPerSession: number;
}

export interface ServeBounds {
  maxBodyBytes?: number;
  maxPromptChars?: number;
  maxConcurrentTurnsPerSession?: number;
  eventBacklogSeconds?: number;
}

export interface ServeConfig {
  schemaVersion: typeof SERVE_CONFIG_SCHEMA_VERSION;
  enabled: boolean;
  bind: ServeBind;
  profile: string;
  credentialRef: ServeCredentialRef;
  approval: ServeApproval;
  bounds?: ServeBounds;
  retentionDays?: number;
}

/** Absolute path to `serve.json`, in the shared user-global config directory. */
export function serveConfigPath(dir?: string): string {
  return path.join(keryxConfigDir(dir), "serve.json");
}

// ---------------------------------------------------------------------------
// Address classification
// ---------------------------------------------------------------------------

/**
 * Parse a dotted-quad IPv4 literal, or null.
 *
 * A component with a leading zero is REFUSED rather than parsed: `0177.0.0.1`
 * and `010.0.0.1` mean different things to different resolvers, and a
 * classification that disagrees with the kernel about which address it just
 * approved is the one failure this function must not have.
 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    if (part.length > 1 && part.startsWith("0")) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  return octets;
}

/** Parse an IPv6 literal into its eight 16-bit groups, or null. */
function parseIpv6(value: string): number[] | null {
  if (!value.includes(":")) {
    return null;
  }
  let text = value;
  const embedded: number[] = [];

  // An IPv4 tail (`::ffff:127.0.0.1`) always occupies the last two groups.
  const dot = text.indexOf(".");
  if (dot >= 0) {
    const colon = text.lastIndexOf(":", dot);
    if (colon < 0) {
      return null;
    }
    const quad = parseIpv4(text.slice(colon + 1));
    if (quad === null) {
      return null;
    }
    embedded.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
    text = text.slice(0, colon);
  }

  const compressions = text.split("::").length - 1;
  if (compressions > 1) {
    return null;
  }

  let head: string[] = [];
  let tail: string[] = [];
  if (compressions === 1) {
    const [before, after] = text.split("::");
    head = before!.length > 0 ? before!.split(":") : [];
    tail = after!.length > 0 ? after!.split(":") : [];
  } else {
    head = text.length > 0 ? text.split(":") : [];
  }

  const written = [...head, ...tail];
  for (const group of written) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) {
      return null;
    }
  }
  const toNumber = (group: string): number => Number.parseInt(group, 16);
  const total = written.length + embedded.length;

  if (compressions === 0) {
    if (total !== 8) {
      return null;
    }
    return [...head.map(toNumber), ...embedded];
  }
  if (total > 7) {
    // `::` must stand for at least one elided group.
    return null;
  }
  return [
    ...head.map(toNumber),
    ...new Array<number>(8 - total).fill(0),
    ...tail.map(toNumber),
    ...embedded,
  ];
}

/**
 * True only for an address this function can positively identify as loopback.
 *
 * FAIL-CLOSED: anything unparseable, a hostname other than `localhost`, and the
 * wildcards `0.0.0.0` / `::` are reported as non-loopback, which routes them
 * into the explicit acknowledgement requirement. Refusing a genuine loopback
 * address costs the operator a flag; accepting a genuine public address as
 * loopback is the entire risk this slice exists to bound.
 *
 * `localhost` is the ONE name accepted, and it is accepted by name rather than
 * by resolution: RFC 6761 §6.3 reserves it and requires it to resolve to a
 * loopback address. No other name is classified, because resolution is
 * attacker-influenced (DNS) and time-varying, so a name that resolved to
 * 127.0.0.1 at startup proves nothing about what the socket is reachable from.
 *
 * Stated precisely because an earlier version of this comment claimed "a
 * hostname is never resolved", which was not true of the process as a whole:
 * `Bun.serve` does resolve whatever string it is handed, `localhost` included.
 * A host whose `/etc/hosts` maps `localhost` elsewhere would make this
 * classifier and the kernel disagree — an accepted residual, since an attacker
 * who can edit `/etc/hosts` has already won.
 */
export function isLoopbackAddress(address: string): boolean {
  const trimmed = address.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }
  let text = trimmed;
  if (text.startsWith("[") && text.endsWith("]")) {
    text = text.slice(1, -1);
  }
  const zone = text.indexOf("%");
  if (zone >= 0) {
    text = text.slice(0, zone);
  }
  if (text === "localhost") {
    return true;
  }

  const quad = parseIpv4(text);
  if (quad !== null) {
    return quad[0] === 127;
  }

  const groups = parseIpv6(text);
  if (groups === null) {
    return false;
  }
  if (groups.every((group, index) => (index === 7 ? group === 1 : group === 0))) {
    return true;
  }
  // IPv4-mapped (`::ffff:a.b.c.d`) is reachable exactly as the embedded address.
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  return mapped && groups[6]! >> 8 === 127;
}

// ---------------------------------------------------------------------------
// Projection and validation
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * Report and discard every key of `source` that is not in `declared`.
 *
 * `prefix` makes the report addressable (`credentialRef.value`), because a bare
 * key name does not tell an operator which object it was dropped from.
 */
function reportUndeclared(
  source: Record<string, unknown>,
  declared: readonly string[],
  prefix: string,
  onDrop?: (key: string) => void,
): void {
  for (const key of Object.keys(source)) {
    if (!declared.includes(key)) {
      onDrop?.(`${prefix}${key}`);
    }
  }
}

const CONFIG_KEYS = [
  "schemaVersion",
  "enabled",
  "bind",
  "profile",
  "credentialRef",
  "approval",
  "bounds",
  "retentionDays",
] as const;
const BIND_KEYS = ["address", "port", "acknowledgeNonLoopback"] as const;
const CREDENTIAL_REF_KEYS = ["store", "id"] as const;
const APPROVAL_KEYS = ["expirySeconds", "maxPendingPerSession"] as const;
const BOUNDS_KEYS = [
  "maxBodyBytes",
  "maxPromptChars",
  "maxConcurrentTurnsPerSession",
  "eventBacklogSeconds",
] as const;

/**
 * Project an arbitrary value onto the schema's declared shape.
 *
 * Returns null when the value cannot be a valid configuration — a half-valid
 * config is worse than none, because it starts a listener whose operator
 * believes something different about it than the file says.
 *
 * Every undeclared key is dropped and reported through `onDrop`. Dropping data
 * invisibly is how a future field gets destroyed with nobody able to explain
 * where it went.
 */
export function projectServeConfig(
  value: unknown,
  onDrop?: (key: string) => void,
): ServeConfig | null {
  if (!isRecord(value)) {
    return null;
  }
  reportUndeclared(value, CONFIG_KEYS, "", onDrop);

  if (value.schemaVersion !== SERVE_CONFIG_SCHEMA_VERSION) {
    return null;
  }
  if (typeof value.enabled !== "boolean") {
    return null;
  }
  if (typeof value.profile !== "string" || value.profile.length === 0) {
    return null;
  }

  const rawBind = value.bind;
  if (!isRecord(rawBind)) {
    return null;
  }
  reportUndeclared(rawBind, BIND_KEYS, "bind.", onDrop);
  if (typeof rawBind.address !== "string" || rawBind.address.trim().length === 0) {
    return null;
  }
  if (!isInteger(rawBind.port, 1, 65535)) {
    return null;
  }
  if (rawBind.acknowledgeNonLoopback !== undefined && typeof rawBind.acknowledgeNonLoopback !== "boolean") {
    return null;
  }

  const rawRef = value.credentialRef;
  if (!isRecord(rawRef)) {
    return null;
  }
  reportUndeclared(rawRef, CREDENTIAL_REF_KEYS, "credentialRef.", onDrop);
  if (rawRef.store !== "auth-json" && rawRef.store !== "os-credential-store") {
    return null;
  }
  if (typeof rawRef.id !== "string" || rawRef.id.length === 0) {
    return null;
  }

  const rawApproval = value.approval;
  if (!isRecord(rawApproval)) {
    return null;
  }
  reportUndeclared(rawApproval, APPROVAL_KEYS, "approval.", onDrop);
  if (!isInteger(rawApproval.expirySeconds, 30, 86400)) {
    return null;
  }
  if (!isInteger(rawApproval.maxPendingPerSession, 1, Number.MAX_SAFE_INTEGER)) {
    return null;
  }

  const config: ServeConfig = {
    schemaVersion: SERVE_CONFIG_SCHEMA_VERSION,
    enabled: value.enabled,
    bind: {
      address: rawBind.address,
      port: rawBind.port,
      ...(rawBind.acknowledgeNonLoopback === undefined
        ? {}
        : { acknowledgeNonLoopback: rawBind.acknowledgeNonLoopback }),
    },
    profile: value.profile,
    credentialRef: { store: rawRef.store, id: rawRef.id },
    approval: {
      expirySeconds: rawApproval.expirySeconds,
      maxPendingPerSession: rawApproval.maxPendingPerSession,
    },
  };

  if (value.bounds !== undefined) {
    if (!isRecord(value.bounds)) {
      return null;
    }
    reportUndeclared(value.bounds, BOUNDS_KEYS, "bounds.", onDrop);
    const bounds: ServeBounds = {};
    for (const key of BOUNDS_KEYS) {
      const bound = value.bounds[key];
      if (bound === undefined) {
        continue;
      }
      if (!isInteger(bound, 0, Number.MAX_SAFE_INTEGER)) {
        return null;
      }
      bounds[key] = bound;
    }
    config.bounds = bounds;
  }

  if (value.retentionDays !== undefined) {
    if (!isInteger(value.retentionDays, 0, Number.MAX_SAFE_INTEGER)) {
      return null;
    }
    config.retentionDays = value.retentionDays;
  }

  return config;
}

/** A loopback-bound, credential-referencing configuration with schema defaults. */
export function defaultServeConfig(
  credentialId: string,
  overrides: {
    address?: string;
    port?: number;
    profile?: string;
    acknowledgeNonLoopback?: boolean;
  } = {},
): ServeConfig {
  return {
    schemaVersion: SERVE_CONFIG_SCHEMA_VERSION,
    enabled: true,
    bind: {
      address: overrides.address ?? DEFAULT_SERVE_BIND_ADDRESS,
      port: overrides.port ?? DEFAULT_SERVE_PORT,
      acknowledgeNonLoopback: overrides.acknowledgeNonLoopback ?? false,
    },
    profile: overrides.profile ?? DEFAULT_SERVE_PROFILE,
    credentialRef: { store: "auth-json", id: credentialId },
    approval: { expirySeconds: 300, maxPendingPerSession: 4 },
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Read the configuration, or null when nothing valid is configured.
 *
 * The projection runs on READ as well as on write. The writer cannot create an
 * undeclared key, but a hand-edit can, and a value that never entered the
 * process cannot leak out of it.
 */
export function loadServeConfig(dir?: string, onWarn?: (message: string) => void): ServeConfig | null {
  const file = serveConfigPath(dir);
  if (!existsSync(file)) {
    return null;
  }
  const read = readConfigFile(file);
  if (!read.ok) {
    onWarn?.(
      read.reason === "too-large"
        ? "serve.json is far too large to be a configuration; treating the server as not configured"
        : "serve.json exists but could not be read; treating the server as not configured",
    );
    return null;
  }
  const text = read.text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    onWarn?.("serve.json is malformed; treating the server as not configured");
    return null;
  }
  const config = projectServeConfig(parsed, (key) =>
    onWarn?.(`serve.json: ignored undeclared field "${key}"`),
  );
  if (config === null) {
    onWarn?.("serve.json does not match the remote-entry configuration schema; treating the server as not configured");
  }
  return config;
}

/**
 * What is on disk, distinguishing the four cases a caller must treat apart.
 *
 * `loadServeConfig` collapses all of them to `null`, which is right for "should
 * the server start" and wrong for "may I overwrite this". A review chmodded a
 * valid configuration to 0200 and watched `config init` replace it at exit 0:
 * the overwrite guard read `null` as "there is nothing worth protecting" when
 * it actually meant "I cannot see what I am about to destroy".
 *
 * - `absent`     — no file. Anything may create one.
 * - `valid`      — parses and matches the schema. Replacing it needs `--force`.
 * - `malformed`  — exists and does not parse, or fails the schema. It protects
 *                  nothing, so it is repairable without `--force`; refusing
 *                  would leave a broken file the CLI cannot fix.
 * - `unreadable` — exists and cannot be read. Treated like `valid`, because the
 *                  safe assumption about a file you cannot see is that it
 *                  matters.
 */
export type ServeConfigState = "absent" | "valid" | "malformed" | "unreadable";

/**
 * What to tell an operator whose configuration is not usable, given what is
 * actually on disk.
 *
 * One function because there are four sites that need it — the `no-configuration`
 * startup refusal, the `serve status` note, `config show`, and `config set` —
 * and the previous round proved they drift. Two of them were left naming a bare
 * `keryx serve config init` after `config init` had been taught to refuse in the
 * `unreadable` state, so the instruction failed when followed; a third told an
 * operator with a MALFORMED file that their configuration was "present but
 * disabled", which was both a false diagnosis and a non-working instruction.
 *
 * Every string returned here names a command that exits 0 in the state it is
 * returned for. `serve.recovery.test.ts` executes them.
 */
export function serveConfigAdvice(state: ServeConfigState): string {
  switch (state) {
    case "absent":
      return "no serve configuration was found. Run `keryx serve config init` to create one.";
    case "malformed":
      return "the serve configuration does not match the schema. Run `keryx serve config init` to replace it with defaults.";
    case "unreadable":
      // "Fix its permissions" leads, because that is the usual cause — but not
      // the only one: an oversized file routes here too, and the warning
      // printed immediately above says which it was. Naming both keeps the
      // instruction correct for either.
      return "the serve configuration exists but could not be read — check its permissions and size, or run `keryx serve config init --force` to replace it with defaults.";
    case "valid":
      // Reached only when the configuration parses and is disabled — every
      // other `valid` path has a real configuration to act on.
      return "the serve configuration is present but disabled. Run `keryx serve config set --enable` to enable it.";
  }
}

export function serveConfigState(dir?: string): ServeConfigState {
  const file = serveConfigPath(dir);
  if (!existsSync(file)) {
    return "absent";
  }
  const read = readConfigFile(file);
  if (!read.ok) {
    // `too-large` maps to `unreadable`, not `malformed`: it may well be a valid
    // configuration with something appended, and the safe assumption about a
    // file this module declines to open is that it matters. `config init
    // --force` still replaces it, which is the documented way out.
    return "unreadable";
  }
  const text = read.text;
  try {
    return projectServeConfig(JSON.parse(text) as unknown) === null ? "malformed" : "valid";
  } catch {
    return "malformed";
  }
}

/**
 * Write the configuration at mode 0600, through the projection.
 *
 * Owner-only because it sits beside `auth.json`, and because even a
 * credential *reference* plus a bind address is operational intelligence.
 * Returns false rather than throwing.
 */
export function saveServeConfig(
  config: ServeConfig,
  dir?: string,
  onWarn?: (message: string) => void,
): boolean {
  const projected = projectServeConfig(config, (key) =>
    onWarn?.(`serve.json: dropped undeclared field "${key}"`),
  );
  if (projected === null) {
    onWarn?.("refusing to write a serve configuration that does not match the schema");
    return false;
  }
  try {
    // `mode` on `mkdirSync` applies at creation only, and this is rarely the
    // first writer of the shared directory. See `ensureKeryxConfigDir`.
    ensureKeryxConfigDir(dir);
    // `writeOwnerOnlyFile`, not `writeFileSync(..., { mode })`: the mode applies
    // at creation only, so a `serve.json` that already exists group-readable
    // stays that way through every write. `config set` is always a rewrite.
    writeOwnerOnlyFile(serveConfigPath(dir), `${JSON.stringify(projected, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}
