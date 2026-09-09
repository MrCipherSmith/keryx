import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertEnvIsolated,
  assertNoManagedSettings,
  buildIsolatedEnv,
  createIsolatedHome,
  FORBIDDEN_ENV_KEYS,
} from "./retrieval-isolation";

describe("buildIsolatedEnv", () => {
  test("carries the allowlist and drops everything else", () => {
    // An allowlist rather than a copy with exclusions, because the dangerous
    // keys are the ones nobody thought to exclude.
    const env = buildIsolatedEnv({
      parent: { PATH: "/usr/bin", LANG: "en_US.UTF-8", EDITOR: "vim", SOME_AGENT_RULES: "/x" },
      home: "/tmp/h",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect("EDITOR" in env).toBe(false);
    expect("SOME_AGENT_RULES" in env).toBe(false);
  });

  test("HOME is the isolated one even when the parent names another", () => {
    const env = buildIsolatedEnv({ parent: { HOME: "/Users/real" }, home: "/tmp/isolated" });
    expect(env.HOME).toBe("/tmp/isolated");
  });

  test("a key absent from the parent is absent, not empty", () => {
    // An empty string is a value. A tool reading TMPDIR="" behaves differently
    // from one reading no TMPDIR at all.
    const env = buildIsolatedEnv({ parent: { PATH: "/usr/bin", TMPDIR: undefined }, home: "/tmp/h" });
    expect("TMPDIR" in env).toBe(false);
  });

  test("allowExtra widens the list without opening it", () => {
    const env = buildIsolatedEnv({
      parent: { XAI_API_KEY: "k", OTHER: "o" },
      home: "/tmp/h",
      allowExtra: ["XAI_API_KEY"],
    });
    expect(env.XAI_API_KEY).toBe("k");
    expect("OTHER" in env).toBe(false);
  });

  test("overrides are applied after the allowlist", () => {
    const env = buildIsolatedEnv({ parent: { PORT: "3847" }, home: "/tmp/h", overrides: { PORT: "1" } });
    expect(env.PORT).toBe("1");
  });
});

describe("assertEnvIsolated", () => {
  test("a clean environment passes, so the refusals below are not vacuous", () => {
    expect(() => assertEnvIsolated({ PATH: "/usr/bin", HOME: "/tmp/h" }, "claude")).not.toThrow();
  });

  test.each(FORBIDDEN_ENV_KEYS.map((key) => [key]))("refuses %s", (key) => {
    expect(() => assertEnvIsolated({ PATH: "/usr/bin", [key]: "x" }, "claude")).toThrow(new RegExp(key));
  });

  test("refuses a whole family by prefix, not only the names listed today", () => {
    // MCP_TIMEOUT is not on any list. The point of the prefix is that the next
    // MCP_* variable is refused without anyone remembering to add it.
    expect(() => assertEnvIsolated({ MCP_TIMEOUT: "5000" }, "grok")).toThrow(/MCP_TIMEOUT/);
    expect(() => assertEnvIsolated({ CLAUDE_CODE_ANYTHING: "1" }, "claude")).toThrow(/CLAUDE_CODE_ANYTHING/);
  });

  test("names the harness, so a failure in a sweep says which leg", () => {
    expect(() => assertEnvIsolated({ GH_TOKEN: "t" }, "grok")).toThrow(/^grok:/);
  });
});

describe("assertNoManagedSettings", () => {
  test("passes when no policy file exists outside HOME", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-managed-"));
    expect(() => assertNoManagedSettings([path.join(dir, "absent.json")])).not.toThrow();
  });

  test("refuses a machine that applies tool policy a temporary HOME cannot hide", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "keryx-managed-"));
    const file = path.join(dir, "managed-settings.json");
    writeFileSync(file, "{}");
    expect(() => assertNoManagedSettings([file])).toThrow(/managed settings present/);
  });
});

describe("createIsolatedHome", () => {
  function fakeHome(): string {
    const home = mkdtempSync(path.join(tmpdir(), "keryx-fakehome-"));
    mkdirSync(path.join(home, ".grok"), { recursive: true });
    writeFileSync(path.join(home, ".grok", "auth.json"), "{}");
    return home;
  }

  test("links the credential rather than copying it", () => {
    // A credential is not duplicated to run a benchmark.
    const real = fakeHome();
    const isolated = createIsolatedHome({
      prefix: "keryx-test-home-",
      realHome: real,
      credentials: [{ from: path.join(".grok", "auth.json"), to: ".grok/auth.json", required: true }],
    });
    try {
      expect(existsSync(path.join(isolated.home, ".grok", "auth.json"))).toBe(true);
      expect(isolated.home).not.toBe(real);
    } finally {
      isolated.dispose();
    }
    expect(existsSync(isolated.home)).toBe(false);
  });

  test("holds nothing the operator configured", () => {
    // The whole reason the home is temporary: a global instruction file reaching
    // the control arm tells it to route through the system under test.
    const real = fakeHome();
    writeFileSync(path.join(real, "CLAUDE.md"), "# route everything through keryx");
    const isolated = createIsolatedHome({
      prefix: "keryx-test-home-",
      realHome: real,
      credentials: [{ from: path.join(".grok", "auth.json"), to: ".grok/auth.json", required: true }],
    });
    try {
      expect(existsSync(path.join(isolated.home, "CLAUDE.md"))).toBe(false);
    } finally {
      isolated.dispose();
    }
  });

  test("a missing REQUIRED credential fails loudly, and leaves no home behind", () => {
    // Not at the first model call: an unauthenticated arm produces an empty
    // answer, which scores zero recall and is indistinguishable from an arm
    // that searched honestly and found nothing.
    const empty = mkdtempSync(path.join(tmpdir(), "keryx-noauth-"));
    let leaked: string | undefined;
    expect(() => {
      try {
        createIsolatedHome({
          prefix: "keryx-test-home-",
          realHome: empty,
          credentials: [{ from: "missing.json", to: "missing.json", required: true, hint: "run login" }],
        });
      } catch (error) {
        leaked = (error as Error).message;
        throw error;
      }
    }).toThrow(/no credentials/);
    expect(leaked).toMatch(/run login/);
  });

  test("a missing OPTIONAL credential is fine — macOS keeps claude's in the Keychain", () => {
    // Scoped to the user rather than to HOME, so an isolated HOME authenticates
    // normally and there is no file to link. Linux reads a file; one optional
    // link covers both without branching on platform.
    const empty = mkdtempSync(path.join(tmpdir(), "keryx-nofile-"));
    const isolated = createIsolatedHome({
      prefix: "keryx-test-home-",
      realHome: empty,
      credentials: [{ from: ".claude/.credentials.json", to: ".claude/.credentials.json", required: false }],
    });
    try {
      expect(existsSync(isolated.home)).toBe(true);
    } finally {
      isolated.dispose();
    }
  });
});
