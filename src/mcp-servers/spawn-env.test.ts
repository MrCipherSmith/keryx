import { describe, expect, test } from "bun:test";
import { EXTERNAL_ENV_DENY, EXTERNAL_ENV_PREFIX_SWEEPS } from "../harness/external/env";
import { buildMcpChildEnv } from "./spawn-env";

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
