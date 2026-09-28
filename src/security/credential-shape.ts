// Whether a name/value pair LOOKS like a credential — the shape check a
// third-party MCP server's environment (`mcp-servers/spawn-env.ts`) and an
// external agent CLI's environment (`harness/external/env.ts`) both filter
// their parent environment through.
//
// MOVED HERE from `mcp-servers/spawn-env.ts` (R-MIN1, flow 355 AC7): the
// classifier was reached cross-subsystem — `harness/external/env.ts` imported
// it from a sibling package it otherwise has nothing to do with — which said
// nothing about what it actually is. It is a SHAPE decision over an
// environment-variable name and value, independent of which child it is being
// built for; `src/security/` is what it is, not `src/mcp-servers/`.
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
// Pure: no I/O, no config, no global — a name and an optional value in,
// `true`/`false` out.
//
// `EXTERNAL_ENV_DENY`/`EXTERNAL_ENV_PREFIX_SWEEPS` move here TOO, for a rule
// this module cannot break: a core owner never imports a client module
// (`import-zones.ts`'s zero-tolerance RULE 1), and `isDeniedForMcpChild`
// depended on both — they used to live in `harness/external/env-deny.ts`
// (client zone). `harness/external/env-deny.ts` now re-exports them from
// here, so every existing importer of that module is unaffected.

/**
 * Variables removed by name, each for its own reason (security-policy §2.1).
 * Not alphabetised — grouped by the failure each prevents.
 */
export const EXTERNAL_ENV_DENY: readonly string[] = [
  // Break the subscription path, or silently redirect it to a third-party model
  // while the result still carries the external agent's name.
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  // Config pointers that can re-set the variables above from inside a settings
  // file. Stripping the variables while leaving the pointer achieves nothing.
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  // "You are running inside Claude Code" — a child that inherits it misidentifies
  // its own context.
  "CLAUDECODE",
];

/**
 * Namespaces swept rather than enumerated. A table of individual names is a table
 * that falls behind the vendor's next release, and this is exactly the kind of
 * list nobody notices has gone stale.
 */
export const EXTERNAL_ENV_PREFIX_SWEEPS: readonly string[] = ["CLAUDE_CODE_", "KERYX_"];

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
  // Certificate and identity POINTERS — the same class again, and the third
  // round of finding members of it one at a time is what prompted the
  // table test in `spawn-env.table.test.ts`.
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "ARM_CLIENT_CERTIFICATE_PATH",
  "VAULT_CLIENT_CERT",
  "VAULT_CLIENT_KEY",
  "SSL_CLIENT_CERT_PATH",
  "SSL_CLIENT_KEY_FILE",
  "IDENTITY_FILE",
  "SSH_IDENTITY_FILE",
  "GCP_SERVICE_ACCOUNT",
  // The X11 magic cookie. Read access is keylogging and screen capture of
  // the operator's entire desktop — a strictly larger grant than any API
  // key on this list, and it was missed while its keyring siblings were
  // caught.
  "XAUTHORITY",

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
const SECRET_SUBSTRING_RE =
  /(PASSWORD|PASSWD|PASSPHRASE|PASSCODE|SSHPASS|SECRET|CREDENTIAL|APIKEY|KEYFILE|PRIVKEY)/;

/**
 * PREFIX+SUFFIX credential shapes with NO underscore between the halves —
 * `PRIVATEKEY`, `REFRESHTOKEN`, `ACCESSTOKEN`, `APITOKEN`, `DBPASS` (flow 352
 * audit, AC4). `SECRET_SEGMENT_RE` above is boundary-anchored — it requires a
 * `_` (or the start/end of the whole name) immediately around the segment —
 * which a glued compound never has by definition, the same way round two's
 * glued-PASSWORD class (`PGPASSWORD`, `SSHPASS`, this file's header) escaped
 * the ORIGINAL underscore-anchored password check.
 *
 * A short, closed list of PREFIXES on each side, not a bare `KEY`, `TOKEN`,
 * `SECRET` or `PASS` substring: those already have documented boundary cases
 * this file must not re-break — a bare `KEY` substring takes
 * `KEYBOARD_LAYOUT`, a bare `TOKEN` substring takes `TOKENIZER`/
 * `TOKENIZERS_PARALLELISM`, a bare `PASS` substring takes `PASSAGE`/
 * `COMPASS`, and a bare `PRIVATE` substring takes `PRIVATE_REGISTRY_URL`
 * (`spawn-env.table.test.ts`'s own boundary rows). Requiring the suffix to be
 * GLUED directly onto the prefix is what keeps `PRIVATE_REGISTRY_URL` (an
 * underscore between them) out while catching `PRIVATEKEY` (none).
 *
 * ANCHORED (R-I2, flow 355 AC7 — then RE-ANCHORED, flow 355 review round
 * F-SEC-F3): the first version anchored the PREFIX side, `(^|_)PREFIX…`,
 * which was wrong in the opposite direction from the original unanchored
 * regex — it now REQUIRED the prefix to start the name (or follow a `_`),
 * so `PRODDBPASS`, `MYPRIVATEKEY`, `USERREFRESHTOKEN`, `LEGACYACCESSTOKEN`,
 * `V2APITOKEN`, `OAUTHACCESSTOKEN` and `SNOWFLAKEDBPASS` all evaded — a
 * REAL prefix (`GLUED_SECRET_RE`'s own `DBPASS`/`PRIVATEKEY`/etc.) preceded
 * by ANYTHING else at all was no longer glued-suffix shaped as far as this
 * regex was concerned. The anchor belongs on the SUFFIX side instead: the
 * credential shape a glued compound ends WITH is what makes it dangerous —
 * `PRODDBPASS` is exactly as much a password variable as `DBPASS` is — and
 * the prefix may be preceded by anything. `APITOKENIZER`/
 * `TOKENIZERS_PARALLELISM`/`KEYBOARD_LAYOUT` stay allowed under EITHER
 * anchoring, because none of them has the suffix at the true end of the
 * name (or against a `_`) — `APITOKENIZER` has "IZER" after "TOKEN", not a
 * boundary.
 */
const GLUED_SECRET_RE =
  /(PRIVATE|SECRET|ACCESS|REFRESH|SESSION|CLIENT|API|APP)(KEY|TOKEN|SECRET)($|_)|DB(PASS|PWD)($|_)/;

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
const CREDENTIAL_IN_VALUE_RE = /:\/\/[^/\s@]*(:[^/\s@]*)?@/;
// Three shapes, not one. The first version required at least one character
// before the colon and a colon at all, so it saw `postgres://u:pw@h` and
// missed both `redis://:pw@h` (empty username, the Redis convention) and
// `https://ghp_deadbeef@github.com/o/r.git` (a bare token as userinfo,
// which is how a token gets embedded in a git remote). Anything with
// userinfo before the `@` is credential-shaped; there is no reason to
// require the colon.

/**
 * Names whose danger depends on the VALUE.
 *
 * `DOCKER_HOST` was stripped unconditionally on the grounds that a remote
 * daemon is root on another machine — true for `tcp://` and `ssh://`, and
 * false for `unix:///run/user/1000/docker.sock`, which is what rootless
 * Docker, Podman, colima and Rancher Desktop all set. Stripping that made a
 * `docker run -i mcp/...` server fall back to `/var/run/docker.sock` and die
 * with "cannot connect to the Docker daemon" — the server-looks-broken
 * outcome this module exists to avoid, for the second time.
 */
const VALUE_DEPENDENT: Record<string, (value: string) => boolean> = {
  DOCKER_HOST: (value) => !value.startsWith("unix://") && !value.startsWith("fd://"),
};

/**
 * True when this variable must not reach a third-party MCP server, or an
 * external agent CLI, by default.
 *
 * Case-insensitive throughout (R-I1, flow 355 AC7 restates it at the
 * shape-check level; the callers' own by-name checks are fixed at their own
 * sites). The previous version compared one sweep against the raw name and
 * another against the uppercased one, so a lowercase `keryx_secretish`
 * survived what `KERYX_SECRETISH` did not.
 */
export function isDeniedForMcpChild(name: string, value?: string): boolean {
  // The VALUE is checked first and independently of the name: an inline
  // `://user:pass@` is a credential however the variable is spelled, and
  // this is the only rule that does not depend on someone having thought
  // of the name.
  if (value !== undefined && CREDENTIAL_IN_VALUE_RE.test(value)) return true;

  const upper = name.toUpperCase();
  if (MCP_ENV_ALLOW_EXACT.includes(upper)) return false;

  const conditional = VALUE_DEPENDENT[upper];
  if (conditional !== undefined) {
    // No value to judge by means judge it dangerous.
    return value === undefined ? true : conditional(value);
  }

  if (EXTERNAL_ENV_DENY.some((denied) => denied.toUpperCase() === upper)) return true;
  if (MCP_ENV_DENY.includes(upper)) return true;
  if (EXTERNAL_ENV_PREFIX_SWEEPS.some((prefix) => upper.startsWith(prefix.toUpperCase()))) return true;
  if (MCP_ENV_PREFIX_SWEEPS.some((prefix) => upper.startsWith(prefix))) return true;

  return (
    SECRET_SEGMENT_RE.test(upper) ||
    SECRET_SUBSTRING_RE.test(upper) ||
    GLUED_SECRET_RE.test(upper) ||
    CONNECTION_STRING_RE.test(upper)
  );
}
