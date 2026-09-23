import { describe, expect, test } from "bun:test";
import { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "../harness/external/env";
import { noteSavedCredentialEnv, savedCredentialEnvKeys } from "../lib/shell-config";
import { buildMcpChildEnv, isDeniedForMcpChild } from "./spawn-env";

describe("a third-party MCP server does not inherit keryx's credentials", () => {
  test("every name on the shared deny list is stripped", () => {
    // Asserted against the LIST, not against a copy of it here. A name added
    // to `EXTERNAL_ENV_DENY` tomorrow is covered without touching this test;
    // a hardcoded list would keep passing while the real one grew.
    const parent = Object.fromEntries(EXTERNAL_ENV_DENY.map((name) => [name, "secret"]));
    const env = buildMcpChildEnv({ parent: { ...parent, PATH: "/usr/bin" } });

    for (const name of EXTERNAL_ENV_DENY) {
      expect(env[name]).toBeUndefined();
    }
    expect(env.PATH).toBe("/usr/bin");
  });

  test("every swept namespace is swept", () => {
    const parent: Record<string, string> = {};
    for (const prefix of EXTERNAL_ENV_PREFIX_SWEEPS) parent[`${prefix}THING`] = "x";

    const env = buildMcpChildEnv({ parent });
    expect(Object.keys(env)).toEqual([]);
  });

  test("the deny list is not empty, so the two tests above are not vacuous", () => {
    expect(EXTERNAL_ENV_DENY.length).toBeGreaterThan(0);
    expect(EXTERNAL_ENV_PREFIX_SWEEPS.length).toBeGreaterThan(0);
  });
});

describe("the EIGHTEEN a real spawn found still leaking after the first fix", () => {
  // Not a list I wrote: this is what an independent verifier read out of a
  // child process whose command was `env | sort`, on a branch where the
  // suite was green and `spawn-env.test.ts` asserted the nine names from
  // the report. That is the whole lesson — the old test could not have
  // failed on any of these.
  // Name AND value, because one of these is only a credential by its
  // value. `DATABASE_URL=secret` is not a secret; the connection string
  // the verifier actually observed is. Giving every entry the placeholder
  // "secret" would have made this test assert a rule the code should not
  // have.
  const STILL_LEAKING: Array<[string, string]> = [
    ["ANTHROPIC_KEY", "sk-ant-bare"],
    ["OPENAI_KEY", "sk-openai-bare"],
    ["SSH_KEY", "/home/u/.ssh/id_ed25519"],
    ["SUPABASE_SERVICE_ROLE_KEY", "srk-secret"],
    ["PGPASSWORD", "pg_secret"],
    ["MYSQL_PWD", "mysql_secret"],
    ["PGPASSFILE", "/home/u/.pgpass"],
    ["NPM_CONFIG__AUTH", "bmFtZTpwdw=="],
    ["AUTHORIZATION", "Bearer abc"],
    ["JWT", "eyJ"],
    ["BW_SESSION", "bwsess"],
    ["OP_SESSION_myacct", "opsess"],
    ["KUBECONFIG", "/home/u/.kube/config"],
    ["NETRC", "/home/u/.netrc"],
    ["GNUPGHOME", "/home/u/.gnupg"],
    ["CLOUDSDK_CONFIG", "/home/u/.config/gcloud"],
    ["DOCKER_HOST", "tcp://1.2.3.4:2375"],
    ["DATABASE_URL", "postgres://u:hunter2@db/app"],
  ];

  test("none of them reaches the child now", () => {
    const parent = Object.fromEntries(STILL_LEAKING);
    const env = buildMcpChildEnv({ parent: { ...parent, PATH: "/usr/bin" } });
    expect(Object.keys(env)).toEqual(["PATH"]);
  });

  test("each one individually, so a failure names which", () => {
    for (const [name, value] of STILL_LEAKING) {
      expect({ name, denied: isDeniedForMcpChild(name, value) }).toEqual({ name, denied: true });
    }
  });

  test("a credential in the VALUE is caught whatever the name is", () => {
    // The rule that needs no list. `http_proxy` is the case where the
    // value is a secret and the name contains no secret word at all, and a
    // name list will always miss `MONGOHQ_URL` while catching `MONGO_URL`.
    expect(isDeniedForMcpChild("http_proxy", "http://user:pw@proxy:8080")).toBe(true);
    expect(isDeniedForMcpChild("JDBC_DATABASE_URL", "jdbc:postgresql://u:pw@h/db")).toBe(true);
    expect(isDeniedForMcpChild("MONGOHQ_URL", "mongodb://u:pw@h/db")).toBe(true);

    // And the same names WITHOUT credentials are ordinary configuration.
    expect(isDeniedForMcpChild("http_proxy", "http://proxy:8080")).toBe(false);
    expect(isDeniedForMcpChild("API_BASE_URL", "https://api.example.com")).toBe(false);
  });

  test("the classes a THIRD round found: keyring, rc-file pointers, askpass", () => {
    for (const name of [
      "GNOME_KEYRING_CONTROL", "CURLRC", "WGETRC", "NPMRC", "PIP_CONFIG_FILE",
      "RCLONE_CONFIG", "MAVEN_SETTINGS", "GIT_CONFIG", "HGRCPATH",
      // Not credentials — a credential-HARVESTING primitive. The child runs
      // `$GIT_ASKPASS "Password for https://github.com"` and the operator's
      // helper hands it a live token.
      "GIT_ASKPASS", "SSH_ASKPASS", "SUDO_ASKPASS",
      "GITHUB_PAT", "PASSCODE", "PASSKEY", "SLACK_WEBHOOK_URL",
    ]) {
      expect({ name, denied: isDeniedForMcpChild(name) }).toEqual({ name, denied: true });
    }
  });

  test("the OVER-reach a third round found is gone", () => {
    // Sweeping `NPM_CONFIG_` took `npm_config_registry`, so on a machine
    // with a private registry the canonical `npx -y @scope/server` launch
    // silently resolved against the public one. Sweeping `AWS_` took
    // `AWS_REGION`, so a server given its keys by `-e` then failed with
    // "you must specify a region" — which reads as the server being
    // broken, the exact outcome this design is meant to avoid.
    for (const name of [
      "npm_config_registry", "npm_config_cache", "NPM_CONFIG_PREFIX",
      "AWS_REGION", "AWS_DEFAULT_REGION", "GOOGLE_CLOUD_PROJECT",
      "CLOUDSDK_CORE_PROJECT", "XDG_SESSION_TYPE", "SESSION_MANAGER",
      "DBUS_SESSION_BUS_ADDRESS", "PRIVATE_REGISTRY_URL", "API_BASE_URL",
    ]) {
      expect({ name, denied: isDeniedForMcpChild(name) }).toEqual({ name, denied: false });
    }
  });

  test("a bare KEY segment is caught — the docstring used to claim this and the regex did not", () => {
    // The previous comment said "`_KEY` is matched only as a whole word
    // segment", and `_KEY` was matched nowhere. Every honest `FOO_KEY`
    // survived, including ANTHROPIC_KEY — the credential the module's own
    // header is about.
    expect(isDeniedForMcpChild("FOO_KEY")).toBe(true);
    expect(isDeniedForMcpChild("KEY")).toBe(true);
  });

  test("a glued password word is caught even with no underscore", () => {
    // The old sweep required a segment boundary, so one-word names walked
    // through.
    for (const name of ["PGPASSWORD", "MYSQLPASSWORD", "SNOWFLAKEPASSWD", "MYPASSPHRASE"]) {
      expect({ name, denied: isDeniedForMcpChild(name) }).toEqual({ name, denied: true });
    }
  });

  test("matching is case-insensitive on every layer", () => {
    // One sweep tested the raw name and another the uppercased one, so a
    // lowercase `keryx_secretish` survived what `KERYX_SECRETISH` did not.
    for (const name of ["keryx_thing", "github_token", "ssh_auth_sock", "pgpassword"]) {
      expect({ name, denied: isDeniedForMcpChild(name) }).toEqual({ name, denied: true });
    }
  });

  test("the working directory is NOT a secret", () => {
    // `PWD` is the segment that catches `MYSQL_PWD`, so the exception has
    // to be by exact name rather than by weakening the rule.
    expect(buildMcpChildEnv({ parent: { PWD: "/repo", OLDPWD: "/" } })).toEqual({
      PWD: "/repo",
      OLDPWD: "/",
    });
    expect(isDeniedForMcpChild("MYSQL_PWD")).toBe(true);
  });

  test("ordinary variables a toolchain needs still get through", () => {
    // The reason this is copy-then-strip and not an allow-list. A filter
    // that strips everything is a filter nobody can ship.
    const keep = [
      "PATH", "HOME", "LANG", "TMPDIR", "NODE_ENV", "TERM", "SHELL", "USER",
      "KEYBOARD_LAYOUT", "MONKEY_PATCH", "TOKENIZER", "PASSAGE", "COMPASS",
      "API_BASE_URL", "OTEL_EXPORTER_OTLP_ENDPOINT", "npm_package_version",
    ];
    const env = buildMcpChildEnv({ parent: Object.fromEntries(keep.map((k) => [k, "v"])) });
    expect(Object.keys(env).sort()).toEqual([...keep].sort());
  });
});

describe("the credentials the FIRST version of this module leaked", () => {
  // Every name here went straight through when this file reused
  // `EXTERNAL_ENV_DENY` alone — a list whose own docstring says
  // `ANTHROPIC_API_KEY` is on it "to make the SUBSCRIPTION work, not for
  // secrecy". Found in the review of PR #522.
  const LEAKED = [
    "SSH_AUTH_SOCK",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "NPM_TOKEN",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
  ];

  test("none of them reaches the child", () => {
    const parent = Object.fromEntries(LEAKED.map((n) => [n, "secret"]));
    const env = buildMcpChildEnv({ parent: { ...parent, PATH: "/usr/bin", HOME: "/home/u" } });

    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
  });

  test("SSH_AUTH_SOCK specifically, because it is the worst one", () => {
    // A live agent socket: the server signs with the operator's keys and
    // pushes to their repositories. No file to steal, nothing in `ps`.
    expect(buildMcpChildEnv({ parent: { SSH_AUTH_SOCK: "/tmp/agent.1" } })).toEqual({});
  });

  test("a secret-SHAPED name nobody enumerated is swept too", () => {
    // The lists are the variables someone thought of; this is the class.
    const env = buildMcpChildEnv({
      parent: {
        ACME_API_TOKEN: "x",
        SOME_CLIENT_SECRET: "x",
        DB_PASSWORD: "x",
        VENDOR_PRIVATE_KEY: "x",
        MY_CREDENTIALS: "x",
      },
    });
    expect(env).toEqual({});
  });

  test("a name that merely CONTAINS a secret word is not swept", () => {
    // Anti-overreach: the sweep matches whole segments, so ordinary
    // variables survive. A filter that strips everything is a filter nobody
    // can ship.
    const env = buildMcpChildEnv({
      parent: { KEYBOARD_LAYOUT: "us", MONKEY_PATCH: "1", PASSAGE: "x", TOKENIZER: "bpe" },
    });
    expect(Object.keys(env).sort()).toEqual(["KEYBOARD_LAYOUT", "MONKEY_PATCH", "PASSAGE", "TOKENIZER"]);
  });

  test("the ordinary environment a toolchain needs still gets through", () => {
    // The reason this is copy-then-strip and not an allow-list.
    const env = buildMcpChildEnv({
      parent: { PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", TMPDIR: "/tmp", NODE_ENV: "production" },
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "NODE_ENV", "PATH", "TMPDIR"]);
  });
});

describe("what it does NOT do", () => {
  test("no agent-CLI contract is stamped on an MCP server", () => {
    // `buildExternalChildEnv` writes KERYX_EXTERNAL_DEPTH, FORCE_COLOR and
    // NO_COLOR — a delegation-depth and output contract with external agent
    // CLIs. An MCP server honours none of it.
    const env = buildMcpChildEnv({ parent: { PATH: "/usr/bin" } });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("an undefined parent value is dropped, not copied as the string 'undefined'", () => {
    const env = buildMcpChildEnv({ parent: { A: undefined, B: "b" } });
    expect(env).toEqual({ B: "b" });
  });
});

describe("keryx's own saved-credential names never reach a launched MCP server (flow 296 AC1/AC2)", () => {
  // AC1: `keryx acp` and `keryx shell` both resolve providers by loading
  // saved keys into `process.env` (`applySavedApiKeys`/`noteSavedCredentialEnv`
  // in `../lib/shell-config`). A CUSTOM `llm-providers.json` provider may keep
  // its key under any name at all — one with none of KEY/TOKEN/SECRET in it
  // survives `isDeniedForMcpChild`'s shape sweep untouched, so this needs its
  // own strip, by the exact name keryx recorded.
  test("a saved provider key under a name with none of KEY, TOKEN or SECRET is stripped", () => {
    const env = buildMcpChildEnv({
      parent: { PATH: "/usr/bin", MY_LLM_GATEWAY: "saved-value", HOME: "/home/u" },
      savedCredentialKeys: new Set(["MY_LLM_GATEWAY"]),
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
  });

  test("an ordinary variable that merely happens to share no saved name still gets through", () => {
    const env = buildMcpChildEnv({
      parent: { PATH: "/usr/bin", OTHER_THING: "x" },
      savedCredentialKeys: new Set(["MY_LLM_GATEWAY"]),
    });
    expect(env).toEqual({ PATH: "/usr/bin", OTHER_THING: "x" });
  });

  // AC2: an operator who writes the server's OWN `env` block by that exact
  // name has asked for it, in a file they authored — explicit configuration
  // wins over the saved-key strip, same as it already wins over the
  // shape-based deny list (see "the server's own env block" below).
  test("the server's own env block hands over a saved-credential name deliberately", () => {
    const env = buildMcpChildEnv({
      parent: { MY_LLM_GATEWAY: "saved-value" },
      serverEnv: { MY_LLM_GATEWAY: "operator-chosen" },
      savedCredentialKeys: new Set(["MY_LLM_GATEWAY"]),
    });
    expect(env.MY_LLM_GATEWAY).toBe("operator-chosen");
  });

  // Not an isolated Set this time: proves the REAL wiring — the function's
  // default parameter reaches into `../lib/shell-config`'s live record of
  // what THIS process loaded, the same record `keryx shell`'s provider
  // resolution and `keryx acp`'s populate via `noteSavedCredentialEnv`. A
  // uniquely-named variable, because that record is process-lifetime and
  // add-only — this must not collide with a name another test in this
  // process asserts about.
  test("with no override, the default reaches keryx's real saved-credential record", () => {
    // NOT `KERYX_`-prefixed: that namespace is already swept by
    // `isDeniedForMcpChild` for an unrelated reason (AC10, the bus
    // identity), which would mask whether THIS strip — the saved-credential
    // one — is what removed it.
    const marker = `TEST_MARKER_SAVED_GATEWAY_${Math.random().toString(36).slice(2)}`;
    noteSavedCredentialEnv([marker]);
    expect(savedCredentialEnvKeys().has(marker)).toBe(true);

    const env = buildMcpChildEnv({ parent: { PATH: "/usr/bin", [marker]: "saved-value" } });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });
});

describe("the server's own env block", () => {
  test("is applied, and wins over the inherited value", () => {
    const env = buildMcpChildEnv({ parent: { PATH: "/usr/bin", X: "parent" }, serverEnv: { X: "server" } });
    expect(env.X).toBe("server");
  });

  test("can hand over a denied name deliberately, because the operator named it", () => {
    // The strip is about what leaks by default. An operator who writes
    // `"env": {"ANTHROPIC_API_KEY": "..."}` in a file they authored has asked
    // for exactly that.
    const denied = EXTERNAL_ENV_DENY[0] as string;
    const env = buildMcpChildEnv({ parent: { [denied]: "leaked" }, serverEnv: { [denied]: "chosen" } });
    expect(env[denied]).toBe("chosen");
  });
});
