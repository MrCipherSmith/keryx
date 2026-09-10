// The environment filter, as a TABLE — one row per case, organised by the
// class the module claims to close.
//
// This file exists because of a judgement an independent verifier made after
// the third round of fixes to `spawn-env.ts`:
//
//   "Every fix in this round is correct at the site it was given, and wrong
//    one step to the side. The acceptance criterion in use is 'does the
//    reported reproduction now pass'. That criterion cannot converge,
//    because the defect being found each round is not a bug — it is the
//    enumeration method."
//
// Three rounds of evidence for that. `spawn-env.ts`'s own header states the
// lesson — "the old test asserted the nine names from the report and could
// not have failed on any of the eighteen; what it needed to assert was the
// CLASS" — and the very next version then added four spellings of PASSWORD
// and missed `SSHPASS`, hand-listed twenty credential pointers and missed
// the certificate ones, and wrote one connection-string regex for a shape
// that has three variants.
//
// So the unit of this file is not the reported name. It is the CLASS, and
// every class carries:
//
//   - several members, including ones nobody has reported;
//   - its BOUNDARY — the nearby name that must survive, because a filter
//     that strips everything is a filter nobody can ship;
//   - where the danger depends on the value, both values.
//
// A class named in a docstring and represented here by fewer than three
// rows is a class this test is not really checking.

import { describe, expect, test } from "bun:test";
import { isDeniedForMcpChild } from "./spawn-env";

type Row = [name: string, value: string | undefined, denied: boolean];

/** `[class name, why it is a class, rows]` */
const TABLE: Array<{ klass: string; why: string; rows: Row[] }> = [
  {
    klass: "live agent sockets and desktop session authority",
    why: "a handle to every credential the operator holds, with nothing in the process list to notice",
    rows: [
      ["SSH_AUTH_SOCK", "/tmp/agent.1", true],
      ["SSH_AGENT_PID", "1234", true],
      ["GPG_AGENT_INFO", "/run/gpg", true],
      ["GNOME_KEYRING_CONTROL", "/run/keyring", true],
      ["GNOME_KEYRING_PID", "999", true],
      // The X11 magic cookie: read access is keylogging plus screen capture
      // of the whole desktop — a strictly larger grant than any API key.
      ["XAUTHORITY", "/home/u/.Xauthority", true],
      // Boundary: the session bus address and session type are how a
      // browser server picks X11 vs Wayland. Not credentials.
      ["DBUS_SESSION_BUS_ADDRESS", "unix:path=/run/bus", false],
      ["XDG_SESSION_TYPE", "wayland", false],
      ["SESSION_MANAGER", "local/host:@/tmp/.ICE", false],
    ],
  },
  {
    klass: "credential-harvesting primitives",
    why: "holds no secret; makes the operator's helper hand one over on demand",
    rows: [
      ["GIT_ASKPASS", "/usr/bin/helper", true],
      ["SSH_ASKPASS", "/usr/bin/helper", true],
      ["SUDO_ASKPASS", "/usr/bin/helper", true],
      ["GIT_CREDENTIAL_HELPER", "store", true],
      ["GIT_SSH_COMMAND", "ssh -i /key", true],
      // Boundary: an editor is not a credential helper.
      ["GIT_EDITOR", "vim", false],
      ["EDITOR", "vim", false],
    ],
  },
  {
    klass: "credential POINTERS — a path to a file full of secrets is a secret",
    why: "the class the module declares, and has now had members found in three separate rounds",
    rows: [
      ["NETRC", "/home/u/.netrc", true],
      ["KUBECONFIG", "/home/u/.kube/config", true],
      ["PGPASSFILE", "/home/u/.pgpass", true],
      ["GOOGLE_APPLICATION_CREDENTIALS", "/key.json", true],
      ["CURLRC", "/home/u/.curlrc", true],
      ["WGETRC", "/home/u/.wgetrc", true],
      ["NPMRC", "/home/u/.npmrc", true],
      ["RCLONE_CONFIG", "/home/u/rclone.conf", true],
      ["HGRCPATH", "/home/u/.hgrc", true],
      ["GNUPGHOME", "/home/u/.gnupg", true],
      // Certificate and identity pointers: found in round four, same class.
      ["AZURE_CLIENT_CERTIFICATE_PATH", "/c.pem", true],
      ["ARM_CLIENT_CERTIFICATE_PATH", "/c.pem", true],
      ["VAULT_CLIENT_CERT", "/c.pem", true],
      ["SSL_CLIENT_CERT_PATH", "/c.pem", true],
      ["IDENTITY_FILE", "/home/u/.ssh/id", true],
      ["SSH_IDENTITY_FILE", "/home/u/.ssh/id", true],
      ["GOOGLE_CLOUD_KEYFILE_JSON", "/key.json", true],
      ["GCLOUD_KEYFILE_JSON", "/key.json", true],
      ["GCP_SERVICE_ACCOUNT", "base64blob", true],
      // Boundary: a config path that holds no credential.
      ["XDG_CONFIG_HOME", "/home/u/.config", false],
      ["TMPDIR", "/tmp", false],
    ],
  },
  {
    klass: "secret-shaped names, whole-word",
    why: "the lists are what someone thought of; the shape is what they did not",
    rows: [
      ["ACME_API_TOKEN", "x", true],
      ["SOME_CLIENT_SECRET", "x", true],
      ["VENDOR_PRIVATE_KEY", "x", true],
      ["OPENAI_KEY", "x", true],
      ["SSH_KEY", "x", true],
      ["ANTHROPIC_KEY", "x", true],
      ["GITHUB_PAT", "x", true],
      ["MY_JWT", "x", true],
      ["SOME_BEARER", "x", true],
      ["APP_COOKIE", "x", true],
      ["SLACK_WEBHOOK_URL", "https://hooks.slack.com/T/B/xyz", true],
      // Boundary: names that merely contain a secret word as a fragment.
      ["KEYBOARD_LAYOUT", "us", false],
      ["MONKEY_PATCH", "1", false],
      ["TOKENIZER", "bpe", false],
      ["TOKENIZERS_PARALLELISM", "true", false],
      ["PASSAGE", "x", false],
      ["COMPASS", "x", false],
      ["PATH", "/usr/bin", false],
    ],
  },
  {
    klass: "secret-shaped names, GLUED — no underscore boundary",
    why: "round two's stated lesson, and round four still found SSHPASS",
    rows: [
      ["PGPASSWORD", "x", true],
      ["MYSQL_PWD", "x", true],
      ["PGPASSFILE", "/p", true],
      ["SSHPASS", "hunter2", true],
      ["MYSQLPASSWORD", "x", true],
      ["SNOWFLAKEPASSWD", "x", true],
      ["MYPASSPHRASE", "x", true],
      ["NPM_CONFIG__AUTH", "base64", true],
      // Boundary: `PWD` is the segment that catches `MYSQL_PWD`, so the
      // working directory has to be excepted by exact name.
      ["PWD", "/repo", false],
      ["OLDPWD", "/", false],
    ],
  },
  {
    klass: "credentials carried in the VALUE, whatever the name",
    why: "a name list caught MONGO_URL and missed MONGOHQ_URL; the shape needs no list",
    rows: [
      ["DATABASE_URL", "postgres://u:hunter2@db/app", true],
      ["JDBC_DATABASE_URL", "jdbc:postgresql://u:pw@h/db", true],
      ["MONGOHQ_URL", "mongodb://u:pw@h/db", true],
      ["http_proxy", "http://u:pw@proxy:8080", true],
      ["HTTPS_PROXY", "http://u:pw@proxy:8080", true],
      // Empty username — the Redis convention, and the first shape the
      // regex missed.
      ["REDIS_URL", "redis://:hunter2@localhost:6379/0", true],
      ["AMQP_URL", "amqp://:pass@h", true],
      // Bare token as userinfo, no colon — how a token is embedded in a git
      // remote, and the second shape it missed.
      ["GIT_REMOTE", "https://ghp_deadbeef@github.com/o/r.git", true],
      // Boundary: the same names with NO credential in the value are
      // ordinary configuration.
      ["http_proxy", "http://proxy:8080", false],
      ["DATABASE_URL", "postgres://db/app", false],
      ["API_BASE_URL", "https://api.example.com", false],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "http://collector:4317", false],
    ],
  },
  {
    klass: "value-dependent danger",
    why: "DOCKER_HOST was stripped unconditionally and broke rootless Docker",
    rows: [
      ["DOCKER_HOST", "tcp://1.2.3.4:2375", true],
      ["DOCKER_HOST", "ssh://user@host", true],
      // Rootless Docker, Podman, colima and Rancher Desktop all set this.
      ["DOCKER_HOST", "unix:///run/user/1000/docker.sock", false],
      ["DOCKER_HOST", "fd://", false],
      // Nothing to judge by means judge it dangerous.
      ["DOCKER_HOST", undefined, true],
    ],
  },
  {
    klass: "namespaces the sweeps used to take wholesale",
    why: "removing the sweeps was itself a fix; these must stay reachable",
    rows: [
      // The canonical MCP launch is `npx -y @scope/server`, and npm exports
      // its whole config. Stripping the registry sent a private-registry
      // shop to the public one.
      ["npm_config_registry", "https://registry.internal/", false],
      ["npm_config_cache", "/home/u/.npm", false],
      ["NPM_CONFIG_PREFIX", "/usr/local", false],
      ["AWS_REGION", "eu-west-1", false],
      ["AWS_DEFAULT_REGION", "eu-west-1", false],
      ["AWS_PROFILE", "dev", false],
      ["GOOGLE_CLOUD_PROJECT", "my-project", false],
      ["CLOUDSDK_CORE_PROJECT", "my-project", false],
      ["PRIVATE_REGISTRY_URL", "https://registry.internal/", false],
      // But the credentials INSIDE those namespaces still go.
      ["AWS_SECRET_ACCESS_KEY", "x", true],
      ["AWS_ACCESS_KEY_ID", "x", true],
      ["AWS_SESSION_TOKEN", "x", true],
      ["AZURE_CLIENT_SECRET", "x", true],
      ["ARM_CLIENT_SECRET", "x", true],
      ["CLOUDSDK_AUTH_ACCESS_TOKEN", "x", true],
      ["CLOUDSDK_CONFIG", "/home/u/.config/gcloud", true],
    ],
  },
  {
    klass: "case insensitivity",
    why: "one sweep compared the raw name and another the uppercased one",
    rows: [
      ["github_token", "x", true],
      ["ssh_auth_sock", "/tmp/a", true],
      ["pgpassword", "x", true],
      ["keryx_thing", "x", true],
      ["Aws_Secret_Access_Key", "x", true],
      ["path", "/usr/bin", false],
    ],
  },
  {
    klass: "the ordinary environment a toolchain needs",
    why: "copy-then-strip exists so a server that is fine keeps working",
    rows: [
      ["PATH", "/usr/bin", false],
      ["HOME", "/home/u", false],
      ["LANG", "en_US.UTF-8", false],
      ["TERM", "xterm", false],
      ["SHELL", "/bin/bash", false],
      ["USER", "u", false],
      ["NODE_ENV", "production", false],
      ["CI", "true", false],
      ["npm_package_version", "1.0.0", false],
      ["PYTHONPATH", "/usr/lib/python3", false],
      ["VIRTUAL_ENV", "/home/u/.venv", false],
    ],
  },
];

describe("the environment filter, by CLASS", () => {
  for (const { klass, why, rows } of TABLE) {
    describe(`${klass} — ${why}`, () => {
      for (const [name, value, denied] of rows) {
        const label = `${name}${value === undefined ? " (no value)" : `=${value.slice(0, 32)}`}`;
        test(`${denied ? "stripped" : "kept"}: ${label}`, () => {
          expect({ name, denied: isDeniedForMcpChild(name, value) }).toEqual({ name, denied });
        });
      }
    });
  }

  test("every class carries a BOUNDARY — a nearby name that must survive", () => {
    // A class with only positive rows is a class whose filter could be
    // `() => true` and pass. This is the property that makes the table
    // worth more than the list it replaced.
    for (const { klass, rows } of TABLE) {
      const kept = rows.filter(([, , denied]) => !denied).length;
      expect({ klass, hasBoundary: kept > 0 }).toEqual({ klass, hasBoundary: true });
    }
  });

  test("every class carries at least three rows", () => {
    // Two examples is how a class gets 'closed' by handling the reported
    // one and its nearest neighbour, which is the pattern this file exists
    // to break.
    for (const { klass, rows } of TABLE) {
      expect({ klass, rows: rows.length >= 3 }).toEqual({ klass, rows: true });
    }
  });

  test("the table is large enough to be doing work", () => {
    const total = TABLE.reduce((sum, { rows }) => sum + rows.length, 0);
    expect(total).toBeGreaterThan(100);
  });
});
