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
  const env = buildExternalChildEnv({ parent: PARENT, depth: 1, runtimeId: "claude-cli" });

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
    const env = buildExternalChildEnv({ parent: {}, depth: 3, runtimeId: "claude-cli" });
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

describe("AC1: buildExternalChildEnv strips credential-shaped variables the old by-name list missed", () => {
  const LEAKY_PARENT: Record<string, string | undefined> = {
    PATH: "/usr/bin",
    HOME: "/home/op",
    // Live agent sockets / credential-harvesting primitives (spawn-env.ts's
    // MCP_ENV_DENY) — none of these was on EXTERNAL_ENV_DENY before AC1.
    SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
    GIT_ASKPASS: "/usr/bin/git-credential-helper",
    SSH_ASKPASS: "/usr/bin/ssh-askpass",
    // Credential pointers.
    AWS_SHARED_CREDENTIALS_FILE: "/home/op/.aws/credentials",
    GOOGLE_APPLICATION_CREDENTIALS: "/home/op/.gcp/sa.json",
    KUBECONFIG: "/home/op/.kube/config",
    NETRC: "/home/op/.netrc",
    // Git-host tokens, caught by the generic TOKEN segment rather than by name.
    GITHUB_TOKEN: "ghp_deadbeef",
    GH_TOKEN: "ghp_deadbeef",
    // Other providers' model keys.
    OPENAI_API_KEY: "sk-openai-secret",
    GEMINI_API_KEY: "gm-secret",
    GOOGLE_API_KEY: "goog-secret",
  };

  test("a claude-cli child — which needs none of these — gets none of them", () => {
    const env = buildExternalChildEnv({ parent: LEAKY_PARENT, depth: 0, runtimeId: "claude-cli" });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/op");
    for (const key of [
      "SSH_AUTH_SOCK",
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "AWS_SHARED_CREDENTIALS_FILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "KUBECONFIG",
      "NETRC",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "OPENAI_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ]) {
      expect(env).not.toHaveProperty(key);
    }
  });

  test("a codex-cli child keeps its OWN key (OPENAI_API_KEY) but not the other provider's", () => {
    const codexEnv = buildExternalChildEnv({ parent: LEAKY_PARENT, depth: 0, runtimeId: "codex-cli" });
    expect(codexEnv.OPENAI_API_KEY).toBe("sk-openai-secret");
    expect(codexEnv).not.toHaveProperty("GEMINI_API_KEY");
    expect(codexEnv).not.toHaveProperty("GOOGLE_API_KEY");
    // The harvesting primitives and pointers are not this agent's credential
    // either way — still stripped.
    expect(codexEnv).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(codexEnv).not.toHaveProperty("GITHUB_TOKEN");
  });

  test("both directions: a gemini-acp child keeps ITS keys and not codex's", () => {
    const geminiEnv = buildExternalChildEnv({ parent: LEAKY_PARENT, depth: 0, runtimeId: "gemini-acp" });
    expect(geminiEnv.GEMINI_API_KEY).toBe("gm-secret");
    expect(geminiEnv.GOOGLE_API_KEY).toBe("goog-secret");
    expect(geminiEnv).not.toHaveProperty("OPENAI_API_KEY");
  });

  test("an unrecognised runtimeId gets no exemption at all — fail closed", () => {
    const env = buildExternalChildEnv({ parent: LEAKY_PARENT, depth: 0, runtimeId: "some-future-cli" });
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("GEMINI_API_KEY");
    expect(env).not.toHaveProperty("GOOGLE_API_KEY");
  });

  test("a value-shaped credential (inline userinfo) is stripped regardless of its name or the target", () => {
    const env = buildExternalChildEnv({
      parent: { ...LEAKY_PARENT, SOME_SERVICE_URL: "https://ghp_deadbeef@github.com/o/r.git" },
      depth: 0,
      runtimeId: "codex-cli",
    });
    expect(env).not.toHaveProperty("SOME_SERVICE_URL");
  });
});
