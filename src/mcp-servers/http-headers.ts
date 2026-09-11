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
  /** Set when the problem is two keys differing only in case, not emptiness. */
  readonly duplicate?: boolean;
  /** Set when the header is unsendable rather than empty. */
  readonly malformed?: "control-character" | "name";
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

/**
 * A value that carries no credential however it looks.
 *
 * Whitespace counts. `Bearer ${T}` with `T=" "` expands to `"Bearer  "`,
 * which is neither empty nor trimmed-empty as a WHOLE — the emptiness is in
 * the substituted part. Rather than parse the scheme out, the test is
 * whether the value has anything after its first token: `Bearer` alone, or
 * `Bearer` followed by nothing but spaces, is hollow.
 */
function isHollowValue(value: string): boolean {
  if (value.trim() === "") return true;
  const parts = value.trim().split(/\s+/);
  // A single token is a whole value (an API key, an opaque header). Two or
  // more where everything after the first is empty cannot happen after
  // splitting — so the case to catch is a KNOWN scheme with nothing after
  // it.
  const first = parts[0]?.toLowerCase() ?? "";
  const SCHEMES = ["bearer", "basic", "token", "digest", "apikey"];
  return parts.length === 1 && SCHEMES.includes(first);
}

/** CR, LF, NUL and the rest — unsendable, and their rejection leaks the value. */
// eslint-disable-next-line no-control-regex -- the control characters ARE the thing being matched
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** RFC 9110 token. `fetch` throws on anything else, quoting the value. */
const VALID_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Header names that collide case-insensitively. */
function duplicateHeaderNames(headers: Record<string, string> | undefined): string[] {
  const seen = new Map<string, string[]>();
  for (const key of Object.keys(headers ?? {})) {
    const lower = key.toLowerCase();
    seen.set(lower, [...(seen.get(lower) ?? []), key]);
  }
  return [...seen.values()].filter((names) => names.length > 1).flat();
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

  // Two header keys differing only in case are a config nobody can reason
  // about, and they were worse than ambiguous: `findHeader` returns the
  // FIRST case-insensitive match, so the hollow-check for
  // `{"Authorization": "Basic static", "authorization": "Bearer ${TOKEN}"}`
  // read the wrong entry's raw value, found no unresolved variable, and
  // sent `Basic static, Bearer` to the far end with TOKEN unset. Refused
  // rather than resolved: there is no correct answer to pick.
  const duplicates = duplicateHeaderNames(expanded.headers);
  if (duplicates.length > 0) {
    for (const name of duplicates) hollow.push({ header: name, variable: undefined, duplicate: true });
  }

  for (const [name, value] of Object.entries(expanded.headers ?? {})) {
    if (duplicates.some((d) => d.toLowerCase() === name.toLowerCase())) continue;

    // The EXACT key, and only the exact key.
    //
    // This used to fall back to a case-insensitive `findHeader`, which was
    // dead code: `config.ts` expands header VALUES and copies the keys
    // through unchanged, so `expanded.headers` and `raw.headers` always
    // have identical keys and the fallback could never fire. The mutation
    // sweep found it by inverting `findHeader`'s comparison and watching
    // nothing fail — an unreachable branch is not a covered one, and it
    // read as a deliberate case-insensitive lookup that a future change
    // might have relied on.
    //
    // (Case-insensitive matching between two DIFFERENT keys is still
    // handled: the duplicate guard above refuses that config outright,
    // because there is no correct answer to pick.)
    const rawValue = raw.headers?.[name];
    const missing = unresolvedVariables(rawValue, env);
    if (missing.length > 0) {
      // The variable is what the operator can act on, so name it — even
      // though the expanded value may look plausible (`Bearer `).
      for (const variable of missing) hollow.push({ header: name, variable });
      continue;
    }
    if (isHollowValue(value)) {
      hollow.push({ header: name, variable: referencedVariable(rawValue) });
      continue;
    }
    if (CONTROL_CHARS.test(value)) {
      // Rejected HERE so the message names the variable. Left to `fetch`,
      // the TypeError it throws embeds the WHOLE header value — and that
      // string then reached `doctor --json` and `ServerState.error`,
      // printing the token. Measured.
      hollow.push({ header: name, variable: referencedVariable(rawValue), malformed: "control-character" });
      continue;
    }
    if (!VALID_HEADER_NAME.test(name)) {
      // `fetch` throws for this too, with the same leak.
      hollow.push({ header: name, variable: undefined, malformed: "name" });
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
      // `.trim()`, not just `=== ""`. A variable holding spaces produced
      // `Bearer    ` — a hollow credential by every argument in this
      // file's header, and the guard existed only on the explicit-header
      // branch.
      if (token === undefined || token.trim() === "") {
        hollow.push({ header: "Authorization", variable: tokenVar });
      } else {
        headers.Authorization = `Bearer ${token.trim()}`;
      }
    }
  }

  return hollow.length > 0 ? { ok: false, hollow } : { ok: true, headers };
}

/**
 * The same hollow rule, applied to the URL.
 *
 * `${VAR}` in a `url` was expanded and then never checked — the AC19
 * machinery looked only at headers. `https://api.example/${TENANT}/mcp`
 * with TENANT unset becomes `https://api.example//mcp`: a VALID url that
 * silently addresses the wrong path, reported as "nothing is listening".
 * The same defect one field to the left, which is the shape this package
 * keeps producing.
 */
export function urlProblem(
  raw: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const missing = unresolvedVariables(raw, env);
  if (missing.length > 0) {
    return `url needs ${[...new Set(missing)].join(", ")}, which ${missing.length > 1 ? "are" : "is"} unset`;
  }
  return undefined;
}

/**
 * Credentials in the URL itself.
 *
 * `https://alice:hunter2@host/mcp` puts a secret in every message that
 * names the URL — `doctor` text, `--json`, `keryx mcp list`. And under
 * Bun's fetch the userinfo is silently DROPPED, so the operator gets the
 * secret on screen and an unauthenticated connection. keryx's own web
 * transport already refuses userinfo for the same reason.
 */
export function userinfoProblem(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined; // Not our error to report; the transport will say so.
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return "url carries a username/password; put the credential in a header or bearer_token_env_var instead — it would be printed in every report and is dropped by the HTTP client anyway";
  }
  return undefined;
}

/**
 * Everything wrong with a remote server's TARGET, before any socket.
 *
 * The two url checks existed and were called from exactly one place —
 * `doctor` — while the dial the shell actually uses called neither. So
 * `keryx mcp doctor` reported "url needs TENANT, which is unset" and the
 * session it was pre-flighting went on to connect to `https://host//mcp`
 * anyway. A pre-flight STRICTER than the flight is worse than no
 * pre-flight: it reports a problem the operator then cannot reproduce,
 * and it hides one they will meet.
 *
 * This function exists so there is one list of target problems and two
 * callers of it, rather than two lists that drift. It is the same lesson
 * the duplicated `defaultConnect` taught one file over.
 */
export function remoteTargetProblem(
  raw: McpServerEntry,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return urlProblem(raw.url, env) ?? userinfoProblem(raw.url);
}

/**
 * Elide a credential WITHOUT parsing, so it works on anything.
 *
 * Userinfo and the query string, by text. This is the floor every
 * return path of `displayUrl` stands on: whatever else happens, these
 * two are gone.
 */
function elideCredentialText(raw: string): string {
  const query = raw.indexOf("?");
  const trimmed = query === -1 ? raw : `${raw.slice(0, query)}?…`;
  // Scheme-relative (`//user:pw@host`) as well as absolute, because
  // `new URL` rejects the former and it was printed verbatim.
  return trimmed.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:)?\/\/[^/@]*@/, (_m, scheme: string | undefined) =>
    `${scheme ?? ""}//…@`,
  );
}

/**
 * A URL safe to print.
 *
 * Query strings carry `?api_key=`. Printing the RAW url keeps `${VAR}`
 * unexpanded, but a literal secret written into the config would still
 * show, so the query is replaced wholesale rather than guessed at.
 *
 * FAILS CLOSED. The catch used to `return raw` — the whole url, password
 * and all — excused by a comment saying it was "most likely because a
 * `${VAR}` is still in it". That case cannot reach the catch: the `${`
 * branch above returns first. So the justification was unreachable by
 * construction and the branch it excused made a redaction function
 * return its input unredacted, for every url `new URL` rejects:
 * `//user:pw@host/v1`, `https://user:pw@host:notaport/mcp`,
 * `https://user:pw@[bad/mcp`. Three callers print this — `keryx mcp
 * list`, the `/mcp` view, and the TRUST PROMPT, which is the moment the
 * operator is deciding.
 *
 * Known and deliberate: the PATH is kept. `https://host/v1/sk-live-x/mcp`
 * still shows the secret. Eliding the path would make the row unable to
 * say which endpoint it is, which is most of why it is shown; a
 * credential in a path segment is also not a form any of the MCP
 * vendors use. Recorded rather than silently accepted.
 */
export function displayUrl(raw: string | undefined): string {
  if (raw === undefined) return "";

  // A `${VAR}` has to survive VERBATIM, and `new URL` will not leave it
  // alone: `https://${REGION}.api.test/mcp` parses, and the WHATWG parser
  // lowercases the host — so the message told the operator to set
  // `${region}`, an environment variable that does not exist, while
  // `REGION` sat there unset. Elide by hand instead of normalising.
  if (raw.includes("${")) return elideCredentialText(raw);

  try {
    const parsed = new URL(raw);
    const query = parsed.search === "" ? "" : "?…";
    const auth = parsed.username === "" ? "" : "…@";
    return `${parsed.protocol}//${auth}${parsed.host}${parsed.pathname}${query}`;
  } catch {
    // Unparseable. Elide by text rather than surrendering the string.
    return elideCredentialText(raw);
  }
}

/** One line naming what is missing, for `doctor` and the connect failure. */
export function describeHollow(hollow: readonly HollowHeader[]): string {
  return hollow
    .map(({ header, variable, duplicate, malformed }) => {
      if (duplicate === true) {
        return `header "${header}" is declared more than once with different capitalisation; HTTP header names are case-insensitive, so remove one`;
      }
      if (malformed === "control-character") {
        return variable === undefined
          ? `header "${header}" contains a control character and cannot be sent`
          : `header "${header}" contains a control character — check ${variable}`;
      }
      if (malformed === "name") {
        return `"${header}" is not a valid HTTP header name`;
      }
      return variable === undefined
        ? `header "${header}" is empty`
        : `header "${header}" needs ${variable}, which is unset`;
    })
    .join("; ");
}
