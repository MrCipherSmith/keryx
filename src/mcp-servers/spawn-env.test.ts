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
