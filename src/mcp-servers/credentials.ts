// Where a remote MCP server's OAuth tokens live.
//
// P3b, spec AC14. One file, `{keryxConfigDir()}/mcp-credentials.json`,
// written only through `writeOwnerOnlyFileAtomic` — the same seam
// `search-credentials.json` already uses, so there is one answer in
// this repository to "where do secrets go and who can read them".
//
// Three rules, and each exists because its absence has a name:
//
//   - OWNER-ONLY, asserted on the mode rather than assumed from the
//     helper's name. A credential file readable by the machine's other
//     users is the whole attack, and "we called the right function" is
//     not the same fact as "the bits on disk are 0600".
//
//   - KEYED BY NAME AND URL. A token belongs to an identity at a host,
//     not to a name in a config file. Keying by name alone means
//     pointing `linear` at a different url silently reuses the token
//     issued to the first one — sending a live credential to a host
//     that never received it before, because somebody edited a string.
//
//   - NEVER PRINTED. `describe` exists so callers have something safe
//     to show; the token values are reachable only through `tokensFor`,
//     which is called by the transport and by nothing that renders.
//     0.2.91 shipped a `keryx mcp list` that printed a password, so
//     "no surface prints it" is a property this package has already
//     failed once and now tests per surface.

import path from "node:path";
import {
  ensureKeryxConfigDir,
  isDefiniteAbsence,
  readConfigFile,
  writeOwnerOnlyFileAtomic,
} from "../lib/config-dir";
import { parseJsonTolerant } from "./config";

/** What an authorisation server gave us, as the SDK models it. */
export type StoredTokens = {
  readonly access_token: string;
  readonly token_type?: string;
  readonly refresh_token?: string;
  readonly scope?: string;
  /** Absolute epoch ms, computed from `expires_in` at the time of issue. */
  readonly expires_at?: number;
};

/** A registered client, when the server required dynamic registration. */
export type StoredClient = {
  readonly client_id: string;
  readonly client_secret?: string;
  readonly client_id_issued_at?: number;
  readonly client_secret_expires_at?: number;
};

export type CredentialRecord = {
  readonly tokens?: StoredTokens;
  readonly client?: StoredClient;
  /** PKCE verifier, held only between redirect and exchange. */
  readonly code_verifier?: string;
};

type CredentialFile = {
  schemaVersion?: number;
  credentials?: Record<string, CredentialRecord>;
};

export const CREDENTIALS_SCHEMA_VERSION = 1;

export function credentialsFile(configDir?: string): string {
  return path.join(configDir ?? ensureKeryxConfigDir(), "mcp-credentials.json");
}

/**
 * The key a token is filed under: the server NAME and the URL it was
 * issued for.
 *
 * Both, because either alone is wrong in a way that hands a credential
 * somewhere it was never issued. Name alone: repointing `linear` at
 * another host reuses the token. URL alone: two servers sharing a host
 * — a plausible thing for one vendor — share a token that may have been
 * granted different scopes.
 */
export function credentialKey(serverName: string, serverUrl: string): string {
  return `${serverName}:${serverUrl}`;
}

function readAll(configDir?: string): { file: CredentialFile; problem?: string } {
  const file = credentialsFile(configDir);
  const read = readConfigFile(file);
  if (!read.ok) {
    return isDefiniteAbsence(read.reason)
      ? { file: {} }
      : { file: {}, problem: `${file} could not be read (${read.reason})` };
  }
  try {
    const parsed = parseJsonTolerant(read.text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { file: {}, problem: `${file} must be a JSON object` };
    }
    return { file: parsed as CredentialFile };
  } catch (error) {
    // REFUSED, not reset. Unlike the disable overlay — which holds only
    // toggles and is rebuilt in one command — this file holds tokens
    // that cost the operator a browser round trip each. Silently
    // replacing it with `{}` would log them out of every server at once
    // and report success.
    return {
      file: {},
      problem: `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); nothing was changed`,
    };
  }
}

export function readCredential(
  serverName: string,
  serverUrl: string,
  configDir?: string,
): { record: CredentialRecord | undefined; problem?: string } {
  const { file, problem } = readAll(configDir);
  const record = file.credentials?.[credentialKey(serverName, serverUrl)];
  return problem === undefined ? { record } : { record, problem };
}

/**
 * Merge one record and write the file owner-only.
 *
 * Read-modify-write on the whole file, because the alternative — a
 * per-server file — multiplies the number of paths whose mode has to be
 * right, and mode is the thing that matters here.
 */
export function writeCredential(
  serverName: string,
  serverUrl: string,
  patch: CredentialRecord,
  configDir?: string,
): { ok: true; file: string } | { ok: false; error: string } {
  const { file, problem } = readAll(configDir);
  if (problem !== undefined) {
    // A corrupt store is not overwritten. Losing every other server's
    // token to save this one is not a trade the operator agreed to.
    return { ok: false, error: problem };
  }
  const target = credentialsFile(configDir);
  const key = credentialKey(serverName, serverUrl);
  const credentials = { ...file.credentials, [key]: { ...file.credentials?.[key], ...patch } };
  writeOwnerOnlyFileAtomic(
    target,
    `${JSON.stringify({ schemaVersion: CREDENTIALS_SCHEMA_VERSION, credentials }, null, 2)}\n`,
  );
  return { ok: true, file: target };
}

/** Forget one server's credential entirely. */
export function clearCredential(
  serverName: string,
  serverUrl: string,
  configDir?: string,
): { ok: true; file: string } | { ok: false; error: string } {
  const { file, problem } = readAll(configDir);
  if (problem !== undefined) return { ok: false, error: problem };
  const credentials = { ...file.credentials };
  delete credentials[credentialKey(serverName, serverUrl)];
  const target = credentialsFile(configDir);
  writeOwnerOnlyFileAtomic(
    target,
    `${JSON.stringify({ schemaVersion: CREDENTIALS_SCHEMA_VERSION, credentials }, null, 2)}\n`,
  );
  return { ok: true, file: target };
}

/** Is this access token still usable, with a margin for the round trip? */
export const EXPIRY_MARGIN_MS = 30_000;

export function isExpired(tokens: StoredTokens | undefined, now: number): boolean {
  if (tokens === undefined) return true;
  if (tokens.expires_at === undefined) {
    // No expiry stated means the server did not give one. Treating that
    // as "expired" would refresh on every call; treating it as "valid
    // forever" is what the server asked for.
    return false;
  }
  // The margin is not decoration: a token that expires during the
  // request is indistinguishable, from the operator's side, from a
  // server that rejected it.
  return tokens.expires_at - EXPIRY_MARGIN_MS <= now;
}

/**
 * What a surface may SHOW about a credential.
 *
 * The only function in this module a renderer should call. It returns
 * no token material at all — not a prefix, not a length, not a hash —
 * because each of those is a fact about the secret, and the operator
 * needs exactly one fact: whether they have to authenticate again.
 */
export function describeCredential(record: CredentialRecord | undefined, now: number): string {
  if (record?.tokens === undefined) return "no stored credential";
  if (isExpired(record.tokens, now)) {
    return record.tokens.refresh_token === undefined
      ? "stored credential has expired; re-authenticate"
      : "stored credential has expired; it will be refreshed on the next connect";
  }
  if (record.tokens.expires_at === undefined) return "stored credential, no stated expiry";
  const minutes = Math.max(0, Math.round((record.tokens.expires_at - now) / 60_000));
  return `stored credential, valid for about ${minutes} more minute(s)`;
}

/**
 * Does this server authenticate with OAuth?
 *
 * Only when it has said nothing else. A header or a
 * `bearer_token_env_var` is an explicit instruction about how to
 * authenticate, and starting an OAuth flow anyway would be keryx
 * overriding the operator. `oauth: false` opts a public server out.
 */
export function usesOAuth(server: {
  readonly url?: string | undefined;
  /** `false` is the opt-out the specification spells, not `{enabled:false}`. */
  readonly oauth?: false | { clientId?: string; scopes?: string[]; callbackPort?: number } | undefined;
  readonly bearer_token_env_var?: string | undefined;
  /** The RAW headers, as declared. See below for why not the resolved ones. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}): boolean {
  // Remote only: there is nothing to authorise against for a stdio child.
  if (typeof server.url !== "string" || server.url === "") return false;
  // `oauth: false` — the operator says this server is public.
  if (server.oauth === false) return false;
  // An explicit credential is an explicit instruction. Starting an
  // OAuth flow anyway would be keryx overriding what it was told.
  if (server.bearer_token_env_var !== undefined && server.bearer_token_env_var !== "") return false;
  // The DECLARED headers, not the resolved ones.
  //
  // Resolution fails precisely when a credential variable is unset —
  // which is exactly the moment this question gets asked. Reading the
  // resolved headers meant `Authorization: "Bearer ${T}"` with `T`
  // unset looked like a server that had declared no credential at all,
  // so keryx offered to start an OAuth flow instead of saying "set
  // T". Declaring the header IS the instruction, whether or not the
  // variable currently holds anything.
  return !Object.keys(server.headers ?? {}).some((name) => name.toLowerCase() === "authorization");
}
