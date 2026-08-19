// Tests for the external child environment (flow 176, T6). Pure: the parent
// environment is a literal, never `process.env`.
import { describe, expect, test } from "bun:test";
import {
  ENV_EXTERNAL_DEPTH,
  EXTERNAL_ENV_DENY,
  buildExternalChildEnv,
  canNestExternalChild,
  readExternalDepth,
} from "./env";

const PARENT: Record<string, string | undefined> = {
  PATH: "/usr/bin",
  HOME: "/home/op",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  ANTHROPIC_AUTH_TOKEN: "tok",
  ANTHROPIC_BASE_URL: "https://router.example",
  ANTHROPIC_MODEL: "some-other-model",
  CLAUDE_CONFIG_DIR: "/home/op/.claude-alt",
  CODEX_HOME: "/home/op/.codex-alt",
  CLAUDECODE: "1",
  CLAUDE_CODE_SIMPLE: "1",
  CLAUDE_CODE_ANYTHING_ELSE: "x",
  KERYX_SESSION_ID: "s-1",
  KERYX_SUBAGENT_MODEL: "deepseek",
  UNSET_ONE: undefined,
};

describe("buildExternalChildEnv", () => {
  const env = buildExternalChildEnv({ parent: PARENT, depth: 1 });

  test("keeps ordinary variables the toolchain needs", () => {
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
  });

  test("removes every named denial", () => {
    for (const key of EXTERNAL_ENV_DENY) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("strips ANTHROPIC_API_KEY — which makes the subscription work, not for secrecy", () => {
    // Measured on claude 2.1.220: with a key present the CLI initialises, burns
    // eight api_retry events, then ends error_during_execution. The failure is
    // slow and looks like a network fault rather than a config one.
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  test("sweeps the CLAUDE_CODE_ namespace rather than enumerating it", () => {
    expect(env).not.toHaveProperty("CLAUDE_CODE_SIMPLE");
    expect(env).not.toHaveProperty("CLAUDE_CODE_ANYTHING_ELSE");
  });

  test("sweeps KERYX_ so a nested CLI cannot inherit our session identity", () => {
    expect(env).not.toHaveProperty("KERYX_SESSION_ID");
    expect(env).not.toHaveProperty("KERYX_SUBAGENT_MODEL");
  });

  test("drops keys whose parent value is undefined instead of copying them", () => {
    expect(env).not.toHaveProperty("UNSET_ONE");
  });

  test("suppresses colour so a parser never sees escape sequences", () => {
    expect(env.FORCE_COLOR).toBe("0");
    expect(env.NO_COLOR).toBe("1");
  });

  test("adds the depth marker AFTER the KERYX_ sweep, so the sweep cannot eat it", () => {
    expect(env[ENV_EXTERNAL_DEPTH]).toBe("1");
  });

  test("every value is a string, so the result is directly spawnable", () => {
    for (const value of Object.values(env)) {
      expect(typeof value).toBe("string");
    }
  });

  test("does not mutate the parent environment it was given", () => {
    expect(PARENT.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
  });
});

describe("readExternalDepth", () => {
  test("unset means depth zero — not inside an external child", () => {
    expect(readExternalDepth({})).toBe(0);
    expect(readExternalDepth({ [ENV_EXTERNAL_DEPTH]: "   " })).toBe(0);
  });

  test("reads a set marker", () => {
    expect(readExternalDepth({ [ENV_EXTERNAL_DEPTH]: "2" })).toBe(2);
  });

  test("garbage and negatives read as zero rather than throwing", () => {
    expect(readExternalDepth({ [ENV_EXTERNAL_DEPTH]: "abc" })).toBe(0);
    expect(readExternalDepth({ [ENV_EXTERNAL_DEPTH]: "-3" })).toBe(0);
  });

  test("round-trips what buildExternalChildEnv wrote", () => {
    const env = buildExternalChildEnv({ parent: {}, depth: 3 });
    expect(readExternalDepth(env)).toBe(3);
  });
});

describe("canNestExternalChild is checked on entry, fail-closed", () => {
  test("allows nesting below the cap", () => {
    expect(canNestExternalChild({ [ENV_EXTERNAL_DEPTH]: "0" }, 2)).toEqual({ ok: true });
    expect(canNestExternalChild({ [ENV_EXTERNAL_DEPTH]: "1" }, 2)).toEqual({ ok: true });
  });

  test("refuses at the cap and names the reason", () => {
    // The vendor CLI spawning the grandchild has never heard of maxTreeDepth, so
    // refusing at our own boundary is the only control we actually hold.
    const result = canNestExternalChild({ [ENV_EXTERNAL_DEPTH]: "2" }, 2);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("depth cap 2");
  });

  test("refuses beyond the cap too", () => {
    expect(canNestExternalChild({ [ENV_EXTERNAL_DEPTH]: "9" }, 2).ok).toBe(false);
  });

  test("a cap of zero forbids any external child at all", () => {
    expect(canNestExternalChild({}, 0).ok).toBe(false);
  });
});
