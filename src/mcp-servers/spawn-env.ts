// The environment a third-party MCP server is spawned with.
//
// An MCP server is code the operator installed with one `npx` line, from a
// registry, running with their user account. It gets a filtered environment,
// and the filter is built for THIS job — not borrowed from one built for
// another.
//
// TWO ROUNDS OF REVIEW SHAPED THIS FILE, and both are worth knowing.
//
// The first version reused `EXTERNAL_ENV_DENY` alone. That list's own
// docstring says `ANTHROPIC_API_KEY` is on it "to make the SUBSCRIPTION work,
// NOT for secrecy" — so it inherited that list's scope rather than its
// intent, and `OPENAI_API_KEY`, `GITHUB_TOKEN` and `SSH_AUTH_SOCK` went
// straight through.
//
// The second version — the fix for that — was verified by spawning a real
// server whose command was `env | sort` and reading what the child actually
// received. **Eighteen credential variables still arrived**, because the
// pattern sweep was written against the examples in the report:
//
//   - every segment required an underscore boundary, so `PGPASSWORD`,
//     `MYSQL_PWD` and `PGPASSFILE` escaped by being one word;
//   - a bare `KEY` segment was not in the alternation at all, so
//     `OPENAI_KEY`, `SSH_KEY` and even `ANTHROPIC_KEY` escaped — while the
//     docstring claimed `_KEY` was matched, which it never was;
//   - credential POINTERS were half-enumerated: the module already treated
//     `GOOGLE_APPLICATION_CREDENTIALS` as a secret, but not `KUBECONFIG`,
//     `NETRC`, `PGPASSFILE` or `GNUPGHOME`, which are the same thing;
//   - connection strings carrying an inline password (`DATABASE_URL`) were
//     not considered at all;
//   - and one sweep tested the raw name while another tested the uppercased
//     one, so a lowercase `keryx_secretish` survived what `KERYX_SECRETISH`
//     did not.
//
// The lesson is in the tests as much as the code: the old test asserted the
// nine names from the report and could not have failed on any of the
// eighteen. What it needed to assert was the CLASS.
//
// Still copy-then-strip rather than allow-list, for the reason `env.ts`
// gives: an allow-list has to enumerate everything a build toolchain needs
// and fails in ways that look like the server being broken. A false positive
// costs one explicit `-e`, which is the right side to be wrong on.
//
// NOT the last word on the child environment: the SDK re-injects
// `HOME`/`PATH`/`SHELL`/`TERM`/`USER`/`LOGNAME` after this runs. None is a
// credential, and a server without `PATH` cannot start.
//
// Pure: the parent environment is a parameter, never read from a global.

import { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "../harness/external/env";

/**
 * Names that survive despite looking like they should not.
 *
 * `PWD` is the shell's working directory and `OLDPWD` its predecessor.
 * Stripping them would break any server that reads either, and neither is a
 * secret — but `PWD` is also the segment that catches `MYSQL_PWD`, so the
 * exception has to be by exact name rather than by weakening the rule.
 */
export const MCP_ENV_ALLOW_EXACT: readonly string[] = ["PWD", "OLDPWD"];

/**
 * Names stripped for this surface specifically, each for its own reason.
 *
 * Not alphabetised — grouped by what it prevents. Anything the patterns
 * below already catch is deliberately NOT repeated here.
 */
export const MCP_ENV_DENY: readonly string[] = [
  // Live agent sockets and their state. Not a credential on disk to steal —
  // a handle to one, so the server can sign and authenticate as the operator
  // with nothing appearing in the process list.
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GPG_AGENT_INFO",
  "GNUPGHOME",
  // The desktop keyring fronts every password the user has stored. It was
  // missed while its three siblings above were caught — the same
  // half-enumeration this file's header describes, one round later.
  "GNOME_KEYRING_CONTROL",
  "GNOME_KEYRING_PID",
  "KDE_FULL_SESSION",

  // CREDENTIAL-HARVESTING PRIMITIVES, not credentials.
  //
  // The child runs `$GIT_ASKPASS "Password for https://github.com"` and the
  // operator's credential helper hands it a live token — no interaction,
  // nothing in the process list. Holding no secret itself, this is the most
  // directly exploitable thing on the list.
  "GIT_ASKPASS",
  "SSH_ASKPASS",
  "SUDO_ASKPASS",
  "GIT_CREDENTIAL_HELPER",
  "GIT_SSH_COMMAND",

  // Credential POINTERS: a path to a file full of secrets is a secret. The
  // module already treated GOOGLE_APPLICATION_CREDENTIALS this way; these
  // are the rest of the same class.
  "KUBECONFIG",
  "NETRC",
  "PGPASSFILE",
  "PGSERVICEFILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUDSDK_CONFIG",
  "DOCKER_CONFIG",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "BOTO_CONFIG",
  "AZURE_CONFIG_DIR",
  // Same class, found in a second pass: each of these names a file that
  // holds credentials in plain text. `.curlrc` and `.wgetrc` carry
  // `user = name:password`; `.npmrc` carries `_authToken`; `rclone.conf`
  // carries cloud tokens.
  "CURLRC",
  "WGETRC",
  "NPMRC",
  "NPM_CONFIG_USERCONFIG",
  "PIP_CONFIG_FILE",
  "RCLONE_CONFIG",
  "MAVEN_SETTINGS",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "HGRCPATH",
  "ANSIBLE_VAULT_PASSWORD_FILE",

  // A remote Docker daemon is root on another machine.
  "DOCKER_HOST",

  // Model-provider credentials keryx itself reads. ANTHROPIC_* is on the
  // shared list; these are the ones that list was never about.
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
];

/**
 * Namespaces swept whole, in addition to the shared ones.
 *
 * MUCH shorter than the first attempt, which swept `AWS_`, `AZURE_`,
 * `GCP_`, `GOOGLE_CLOUD_`, `CLOUDSDK_` and `NPM_CONFIG_`. Verification
 * showed what that cost:
 *
 *   - `npm_config_registry` went with it, so on a machine with a private
 *     registry the canonical `npx -y @scope/server` launch silently
 *     resolved against the public one;
 *   - `AWS_REGION` and `GOOGLE_CLOUD_PROJECT` went with it, so a server
 *     given its keys explicitly by `-e` then failed with "you must specify
 *     a region" — which reads as the server being broken, the exact
 *     outcome this file's header says the design avoids.
 *
 * None of those namespaces needed a sweep: every credential in them ends in
 * `SECRET`, `KEY`, `TOKEN` or `PASSWORD` and is caught by the segment rule,
 * and the handful of pointers are named above. A sweep is for a namespace
 * that is credential-bearing THROUGHOUT, which is these two and no others.
 */
export const MCP_ENV_PREFIX_SWEEPS: readonly string[] = [
  // Password-manager unlock sessions: `OP_SESSION_<account>`, Bitwarden.
  "OP_SESSION",
  "BW_SESSION",
];

/**
 * Whole-word segments that mean "this holds a credential".
 *
 * Segment-matched, so `KEYBOARD_LAYOUT` and `MONKEY_PATCH` survive `KEY`
 * while `OPENAI_KEY` and `SSH_KEY` do not. This is what the previous
 * docstring claimed and the previous regex did not do.
 */
const SECRET_SEGMENTS = [
  "KEY", "KEYS", "TOKEN", "TOKENS", "SECRET", "SECRETS", "PASSWORD", "PASSWD",
  "PWD", "PASS", "PASSPHRASE", "PASSCODE", "PASSKEY", "CREDENTIAL",
  "CREDENTIALS", "CREDS", "AUTH", "AUTHORIZATION", "BEARER", "JWT", "COOKIE",
  "SIGNATURE", "APIKEY", "SECRETKEY", "ACCESSKEY", "AUTHTOKEN",
  // Personal access token, which no rule spelled out.
  "PAT",
  // A webhook URL is a bearer credential with no `user:pass@` in it, so
  // the value scan cannot see it.
  "WEBHOOK",
];
// NOT segments, and each for a measured reason:
//   SESSION — took `XDG_SESSION_TYPE` (how a browser server picks X11 vs
//     Wayland), `SESSION_MANAGER` and `DBUS_SESSION_BUS_ADDRESS` with it.
//     Real session credentials are `*_SESSION_TOKEN` (caught by TOKEN) or
//     the two password-manager prefixes above.
//   PRIVATE — `PRIVATE_KEY` is already caught by KEY, and the bare segment
//     took `PRIVATE_REGISTRY_URL`.

const SECRET_SEGMENT_RE = new RegExp(`(^|_)(${SECRET_SEGMENTS.join("|")})($|_)`);

/**
 * Substrings that mean it whatever they are glued to.
 *
 * A much shorter list than the segments, because a substring rule
 * over-reaches easily. Each of these appears in no ordinary variable name:
 * `PGPASSWORD`, `MYSQL_PWD`'s cousins `SNOWFLAKE_PASSWORD`, `PGPASSFILE`.
 * `TOKEN` is deliberately NOT here — it would take `TOKENIZER` with it, and
 * the segment rule already catches every real `*_TOKEN`.
 */
const SECRET_SUBSTRING_RE = /(PASSWORD|PASSWD|PASSPHRASE|PASSCODE|SECRET|CREDENTIAL|APIKEY)/;

/**
 * Connection strings that conventionally carry an inline password.
 *
 * `postgres://user:hunter2@host/db` is a credential in a field nobody calls
 * a credential. Scoped to the systems where the convention is real rather
 * than sweeping every `*_URL`, which would take ordinary service endpoints
 * with it.
 */
const CONNECTION_STRING_RE = /(^|_)(DSN|CONNECTION_STRING|CONNECTIONSTRING)($|_)/;
// NOT `URL`/`URI` as a segment. Trying that took `API_BASE_URL` and
// `OTEL_EXPORTER_OTLP_ENDPOINT`-shaped configuration with it — ordinary
// service endpoints a server needs. A `*_URL` is a secret exactly when its
// VALUE carries credentials, which is what the value scan below decides
// without needing anyone to have listed the name. The one exception is a
// webhook, where the URL itself IS the credential and there is no
// `user:pass@` to spot, so `WEBHOOK` is a segment.

/**
 * A VALUE that carries an inline credential, whatever the variable is
 * called.
 *
 * The name-based list above will always be incomplete — `MONGO_URL` was
 * caught and `MONGOHQ_URL` was not, `DATABASE_URL` and not
 * `JDBC_DATABASE_URL` — and `http_proxy` is the case where the value is a
 * secret and the name contains no secret word at all. `://user:pass@` is
 * the shape itself, and it needs no list.
 */
const CREDENTIAL_IN_VALUE_RE = /:\/\/[^/\s:@]+:[^/\s@]+@/;

/**
 * True when this variable must not reach a third-party MCP server by
 * default.
 *
 * Case-insensitive throughout. The previous version compared one sweep
 * against the raw name and another against the uppercased one, so a
 * lowercase `keryx_secretish` survived what `KERYX_SECRETISH` did not.
 */
export function isDeniedForMcpChild(name: string, value?: string): boolean {
  // The VALUE is checked first and independently of the name: an inline
  // `://user:pass@` is a credential however the variable is spelled, and
  // this is the only rule that does not depend on someone having thought
  // of the name.
  if (value !== undefined && CREDENTIAL_IN_VALUE_RE.test(value)) return true;

  const upper = name.toUpperCase();
  if (MCP_ENV_ALLOW_EXACT.includes(upper)) return false;

  if (EXTERNAL_ENV_DENY.some((denied) => denied.toUpperCase() === upper)) return true;
  if (MCP_ENV_DENY.includes(upper)) return true;
  if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => upper.startsWith(prefix.toUpperCase()))) return true;
  if (MCP_ENV_PREFIX_SWEEPS.some((prefix) => upper.startsWith(prefix))) return true;

  return SECRET_SEGMENT_RE.test(upper) || SECRET_SUBSTRING_RE.test(upper) || CONNECTION_STRING_RE.test(upper);
}

export type McpChildEnvInput = {
  readonly parent: Readonly<Record<string, string | undefined>>;
  /** The server's own `env` block, already variable-expanded. Applied last. */
  readonly serverEnv?: Record<string, string> | undefined;
};

/**
 * The parent environment minus everything {@link isDeniedForMcpChild} names,
 * plus whatever the server's own `env` declares.
 *
 * The server's block is applied AFTER the strip, deliberately: an operator
 * who writes `"env": {"GITHUB_TOKEN": "${GITHUB_TOKEN}"}` has asked for that
 * key to go to that server, by name, in a file they wrote. The strip is
 * about what leaks by default, not about overruling an explicit instruction.
 */
export function buildMcpChildEnv(input: McpChildEnvInput): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.parent)) {
    if (value === undefined) continue;
    if (isDeniedForMcpChild(key, value)) continue;
    env[key] = value;
  }

  for (const [key, value] of Object.entries(input.serverEnv ?? {})) {
    env[key] = value;
  }

  return env;
}
