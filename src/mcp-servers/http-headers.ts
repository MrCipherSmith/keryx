// The headers a remote MCP server is dialled with, and the ones it is not.
//
// P1, AC19. This is a separate module from the transport for one reason: the
// interesting decision here is a REFUSAL, and a refusal buried inside a
// connect function is a refusal nobody can test without a socket.
//
// The rule the specification states, and the whole point of the file:
//
//   `headers.Authorization = "Bearer ${TOKEN}"` with TOKEN unset must NOT
//   reach the transport. Not as `Bearer `, not as `Bearer ${TOKEN}`.
//
// `expandVars` resolves an unset variable to the empty string — deliberately,
// because leaving the literal `${TOKEN}` would send it to a subprocess or a
// server and fail somewhere far from the config that caused it. That is the
// right choice for `args`. For a credential it produces a hollow one, and a
// hollow credential is worse than none: the request is sent, the operator
// sees a 401 from the server rather than a problem in their own config, and
// on a server that treats an empty bearer as anonymous it may even succeed
// with the wrong identity.
//
// So this module decides BEFORE the socket is opened, and returns the reason
// rather than a header.

import type { McpServerEntry } from "./config";

/**
 * A header whose value came out of expansion empty.
 *
 * Carried with the variable NAME — which is the actionable half — and never
 * the value, which is either a secret or nothing.
 */
export type HollowHeader = {
  readonly header: string;
  /** The variable the operator needs to set, when it can be identified. */
  readonly variable: string | undefined;
};

export type HeaderResolution =
  | { readonly ok: true; readonly headers: Record<string, string> }
  | { readonly ok: false; readonly hollow: HollowHeader[] };

/** `${VAR}` / `${VAR:-default}`, matching `config.ts`'s own pattern. */
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/;
const VAR_PATTERN_ALL = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * The variables in a raw header value that resolved to nothing.
 *
 * Comparing the EXPANDED value against `""` is not enough, and the class
 * table caught it before any reviewer did: `Bearer ${TOKEN}` with `TOKEN`
 * unset expands to `"Bearer "` — a non-empty string, and precisely the
 * hollow credential AC19 is about. The emptiness is in the variable, not in
 * the result, so that is where it has to be looked for.
 *
 * A `${VAR:-default}` that falls back is NOT hollow: the operator supplied
 * the value, in the config, on purpose.
 */
function unresolvedVariables(
  raw: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (raw === undefined) return [];
  const missing: string[] = [];
  for (const match of raw.matchAll(VAR_PATTERN_ALL)) {
    const name = match[1] as string;
    const fallback = match[2];
    const value = env[name];
    if ((value === undefined || value === "") && (fallback === undefined || fallback === "")) {
      missing.push(name);
    }
  }
  return missing;
}

/**
 * The variable an unexpanded value referred to, for the error message.
 *
 * Read from the RAW entry, because by the time a value is empty the name it
 * came from has been expanded away. Returns undefined when the raw value
 * names no variable — an operator who literally wrote `"Authorization": ""`
 * gets a different message, and should.
 */
export function referencedVariable(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  return VAR_PATTERN.exec(raw)?.[1];
}

/** Header name comparison is case-insensitive, per RFC 9110. */
function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

function hasHeader(headers: Record<string, string> | undefined, name: string): boolean {
  const wanted = name.toLowerCase();
  return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === wanted);
}

/**
 * Build the request headers for a remote server, or refuse.
 *
 * `expanded` is the entry after `${VAR}` substitution — what would be sent.
 * `raw` is the entry as written — what the operator can act on. Both are
 * needed: the first to know a value came out empty, the second to say which
 * variable to set.
 *
 * `env` is passed rather than read, so the decision is testable without
 * touching the process environment.
 *
 * Precedence, asserted rather than assumed: an explicit `Authorization`
 * header WINS over `bearer_token_env_var`. Writing both is a config the
 * operator should not have written, and the explicit one is the more
 * specific statement of intent.
 */
export function resolveHttpHeaders(
  expanded: McpServerEntry,
  raw: McpServerEntry,
  env: Readonly<Record<string, string | undefined>>,
): HeaderResolution {
  // Note the two entries. `expanded` is what would be sent; `raw` is what
  // was written. The decision needs both, because a hollow credential is
  // detectable only in the raw form (`Bearer ${TOKEN}` expands to a
  // non-empty `"Bearer "`) while the value to send exists only in the
  // expanded one.
  const headers: Record<string, string> = {};
  const hollow: HollowHeader[] = [];

  for (const [name, value] of Object.entries(expanded.headers ?? {})) {
    const rawValue = findHeader(raw.headers, name);
    const missing = unresolvedVariables(rawValue, env);
    if (missing.length > 0) {
      // The variable is what the operator can act on, so name it — even
      // though the expanded value may look plausible (`Bearer `).
      for (const variable of missing) hollow.push({ header: name, variable });
      continue;
    }
    if (value === "" || value.trim() === "") {
      // No variable to blame: either written empty, or whitespace.
      hollow.push({ header: name, variable: undefined });
      continue;
    }
    headers[name] = value;
  }

  const tokenVar = expanded.bearer_token_env_var;
  if (tokenVar !== undefined && tokenVar !== "") {
    if (hasHeader(expanded.headers, "Authorization")) {
      // Explicit wins. Not an error: the operator may be migrating, and
      // refusing a config that specifies the same thing twice compatibly
      // would be pedantry.
    } else {
      const token = env[tokenVar];
      if (token === undefined || token === "") {
        hollow.push({ header: "Authorization", variable: tokenVar });
      } else {
        headers.Authorization = `Bearer ${token}`;
      }
    }
  }

  return hollow.length > 0 ? { ok: false, hollow } : { ok: true, headers };
}

/** One line naming what is missing, for `doctor` and the connect failure. */
export function describeHollow(hollow: readonly HollowHeader[]): string {
  return hollow
    .map(({ header, variable }) =>
      variable === undefined
        ? `header "${header}" is empty`
        : `header "${header}" needs ${variable}, which is unset`,
    )
    .join("; ");
}
