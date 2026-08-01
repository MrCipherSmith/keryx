// The `keryx serve` configuration (flow 128 / roadmap R4b).
//
// Written BEFORE src/lib/serve-config.ts exists. The first run must fail with
// "Cannot find module ./serve-config"; every assertion below then fails for its
// own stated reason until the behaviour is implemented.
//
// The property that matters here is structural, not cosmetic: the schema at
// docs/requirements/keryx-remote-entry/schemas/remote-entry-config.schema.json
// is `additionalProperties: false` and forbids a raw token, so the writer
// projects only the keys the schema declares. A key outside the schema cannot
// reach the file, which is a stronger statement than any name heuristic —
// `stripSecretShapedFields` from R4a would have deleted `credentialRef` itself,
// since "credential" is in its SECRET_WORDS list.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellConfigPath } from "./shell-config";
import { projectRegistryPath } from "./project-registry";
import {
  DEFAULT_SERVE_BIND_ADDRESS,
  DEFAULT_SERVE_PROFILE,
  defaultServeConfig,
  isLoopbackAddress,
  loadServeConfig,
  projectServeConfig,
  saveServeConfig,
  serveConfigAdvice,
  serveConfigPath,
  serveConfigState,
  type ServeConfig,
  type ServeConfigState,
} from "./serve-config";

let configDir = "";

beforeEach(() => {
  configDir = mkdtempSync(path.join(tmpdir(), "keryx-serve-config-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("location", () => {
  test("serve.json sits in the same user-global directory as auth.json and projects.json", () => {
    // A third resolver is how the three eventually disagree about where the
    // user-global configuration lives. They must all resolve to one directory.
    expect(path.dirname(serveConfigPath(configDir))).toBe(path.dirname(shellConfigPath(configDir)));
    expect(path.dirname(serveConfigPath(configDir))).toBe(path.dirname(projectRegistryPath(configDir)));
    expect(path.basename(serveConfigPath(configDir))).toBe("serve.json");
  });
});

describe("loopback classification", () => {
  // Fail-closed: anything this function cannot positively identify as loopback
  // is reported as NON-loopback, which routes it into the acknowledgement
  // requirement. Refusing a genuine loopback address is an inconvenience;
  // accepting a genuine public address as loopback is the whole risk.
  const loopback = [
    "127.0.0.1",
    "127.1.2.3",
    "127.255.255.254",
    "localhost",
    "LOCALHOST",
    "::1",
    "[::1]",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
  ];

  const notLoopback = [
    "0.0.0.0",
    "::",
    "[::]",
    "192.168.1.10",
    "10.0.0.1",
    "172.17.0.1",
    "8.8.8.8",
    "example.com",
    "",
    "127.0.0.1.evil.com",
    "127.0.0.256",
    "0177.0.0.1",
    "2130706433",
    "::ffff:8.8.8.8",
  ];

  for (const address of loopback) {
    test(`${address || "<empty>"} is loopback`, () => {
      expect(isLoopbackAddress(address)).toBe(true);
    });
  }

  for (const address of notLoopback) {
    test(`${address || "<empty>"} is not loopback`, () => {
      expect(isLoopbackAddress(address)).toBe(false);
    });
  }
});

describe("defaults", () => {
  test("a default configuration binds loopback and carries only a credential reference", () => {
    const config = defaultServeConfig("cred-1");
    expect(config.bind.address).toBe(DEFAULT_SERVE_BIND_ADDRESS);
    expect(isLoopbackAddress(config.bind.address)).toBe(true);
    expect(config.bind.acknowledgeNonLoopback).toBe(false);
    expect(config.credentialRef).toEqual({ store: "auth-json", id: "cred-1" });
    expect(config.schemaVersion).toBe("1.0.0");
    expect(config.approval.expirySeconds).toBeGreaterThanOrEqual(30);
    expect(config.approval.maxPendingPerSession).toBeGreaterThanOrEqual(1);
    // The exact default, not merely "non-empty": a blank-but-truthy profile
    // would satisfy a length check and mean nothing.
    expect(config.profile).toBe(DEFAULT_SERVE_PROFILE);
  });
});

describe("the whitelist projection", () => {
  test("accepts a valid configuration unchanged", () => {
    const config = defaultServeConfig("cred-1");
    const dropped: string[] = [];
    const projected = projectServeConfig(config, (key) => dropped.push(key));
    expect(projected).toEqual(config);
    expect(dropped).toEqual([]);
  });

  test("drops every key the schema does not declare, and names each one", () => {
    const dropped: string[] = [];
    const polluted = {
      ...defaultServeConfig("cred-1"),
      token: "raw-bearer-token-value",
      bearerToken: "another-raw-value",
      notes: "harmless but undeclared",
    };
    const projected = projectServeConfig(polluted, (key) => dropped.push(key));
    expect(projected).not.toBeNull();
    expect(Object.keys(projected!).sort()).toEqual([
      "approval",
      "bind",
      "credentialRef",
      "enabled",
      "profile",
      "schemaVersion",
    ]);
    expect(dropped.sort()).toEqual(["bearerToken", "notes", "token"]);
  });

  test("drops undeclared keys nested inside bind and credentialRef", () => {
    // A projection that only cleaned the top level would let a secret ride
    // along inside the very object that exists to avoid carrying one.
    const dropped: string[] = [];
    const base = defaultServeConfig("cred-1");
    const polluted = {
      ...base,
      bind: { ...base.bind, secret: "s3cret" },
      credentialRef: { ...base.credentialRef, value: "raw-bearer-token-value" },
    };
    const projected = projectServeConfig(polluted, (key) => dropped.push(key));
    expect(projected?.credentialRef).toEqual({ store: "auth-json", id: "cred-1" });
    expect(projected?.bind.address).toBe(base.bind.address);
    expect(dropped.sort()).toEqual(["bind.secret", "credentialRef.value"]);
  });

  test("keeps credentialRef, which a name-based secret filter would delete", () => {
    // The concrete reason this module does not reuse stripSecretShapedFields:
    // "credential" is in its SECRET_WORDS set, so the R4a filter deletes the
    // one field the schema requires.
    const projected = projectServeConfig(defaultServeConfig("cred-42"));
    expect(projected?.credentialRef.id).toBe("cred-42");
  });

  test("rejects a configuration missing a required field", () => {
    const base = defaultServeConfig("cred-1") as unknown as Record<string, unknown>;
    for (const required of ["schemaVersion", "enabled", "bind", "profile", "credentialRef", "approval"]) {
      const incomplete = { ...base };
      delete incomplete[required];
      expect(projectServeConfig(incomplete)).toBeNull();
    }
  });

  test("rejects a port outside the schema's range, including 0", () => {
    // 0 means "ephemeral" to the OS. It is legitimate for an in-memory test
    // configuration and illegitimate on disk, where it would silently move the
    // listener every restart.
    const base = defaultServeConfig("cred-1");
    for (const port of [0, -1, 65536, 1.5, Number.NaN]) {
      expect(projectServeConfig({ ...base, bind: { ...base.bind, port } })).toBeNull();
    }
    expect(projectServeConfig({ ...base, bind: { ...base.bind, port: 1 } })).not.toBeNull();
    expect(projectServeConfig({ ...base, bind: { ...base.bind, port: 65535 } })).not.toBeNull();
  });

  test("rejects a credentialRef naming an unknown store", () => {
    const base = defaultServeConfig("cred-1");
    expect(
      projectServeConfig({ ...base, credentialRef: { store: "somewhere-else", id: "x" } }),
    ).toBeNull();
    expect(projectServeConfig({ ...base, credentialRef: { store: "auth-json", id: "" } })).toBeNull();
  });

  test("rejects a non-object", () => {
    for (const value of [null, undefined, 7, "config", []]) {
      expect(projectServeConfig(value)).toBeNull();
    }
  });
});

describe("persistence", () => {
  test("a saved configuration round-trips", () => {
    const config = defaultServeConfig("cred-1");
    expect(saveServeConfig(config, configDir)).toBe(true);
    expect(loadServeConfig(configDir)).toEqual(config);
  });

  test("the file is owner-only", () => {
    if (process.platform === "win32") {
      return; // POSIX mode bits are not meaningful on Windows
    }
    saveServeConfig(defaultServeConfig("cred-1"), configDir);
    expect(statSync(serveConfigPath(configDir)).mode & 0o777).toBe(0o600);
  });

  test("an undeclared key never reaches the file, so a raw token cannot be persisted", () => {
    const secret = "RAW-BEARER-TOKEN-THAT-MUST-NEVER-BE-WRITTEN";
    const polluted = { ...defaultServeConfig("cred-1"), token: secret } as unknown as ServeConfig;
    saveServeConfig(polluted, configDir);
    const bytes = readFileSync(serveConfigPath(configDir), "utf8");
    expect(bytes).not.toContain(secret);
    expect(bytes).toContain("cred-1"); // the opaque reference survives
  });

  test("loading returns null when nothing is configured", () => {
    expect(loadServeConfig(configDir)).toBeNull();
  });

  test("loading a malformed file returns null and says so", () => {
    mkdirSync(path.dirname(serveConfigPath(configDir)), { recursive: true });
    writeFileSync(serveConfigPath(configDir), "{not json", "utf8");
    const warnings: string[] = [];
    expect(loadServeConfig(configDir, (message) => warnings.push(message))).toBeNull();
    expect(warnings.join(" ")).toContain("serve.json");
  });

  test("loading a structurally invalid file returns null rather than a half-config", () => {
    mkdirSync(path.dirname(serveConfigPath(configDir)), { recursive: true });
    writeFileSync(serveConfigPath(configDir), JSON.stringify({ enabled: true }), "utf8");
    expect(loadServeConfig(configDir)).toBeNull();
  });

  test("a hand-added token in the file is dropped on load, not surfaced", () => {
    // Defence in depth: the writer cannot create one, but a hand-edit can.
    const secret = "HAND-EDITED-RAW-TOKEN";
    mkdirSync(path.dirname(serveConfigPath(configDir)), { recursive: true });
    writeFileSync(
      serveConfigPath(configDir),
      JSON.stringify({ ...defaultServeConfig("cred-1"), token: secret }),
      "utf8",
    );
    const loaded = loadServeConfig(configDir);
    expect(loaded).not.toBeNull();
    expect(JSON.stringify(loaded)).not.toContain(secret);
  });
});

describe("serveConfigState, which decides whether a file may be overwritten", () => {
  // It had no direct test: every state was reached only through `config init`.
  // The distinction it draws is load-bearing — `malformed` is freely
  // replaceable and `unreadable` is not — and one of those two branches was
  // wrong when it was written.
  function plant(body: string): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(serveConfigPath(configDir), body, "utf8");
  }

  test("no file at all is absent", () => {
    expect(serveConfigState(configDir)).toBe("absent");
  });

  test("a schema-conforming file is valid", () => {
    expect(saveServeConfig(defaultServeConfig("cred-1"), configDir)).toBe(true);
    expect(serveConfigState(configDir)).toBe("valid");
  });

  test.each([
    ["empty", ""],
    ["truncated json", "{not json"],
    ["a bare string", '"just a string"'],
    ["an array", "[1,2,3]"],
    ["null", "null"],
    ["an object that is not a configuration", '{"nonsense":true}'],
    ["a configuration missing a required field", '{"schemaVersion":"1.0.0","enabled":true}'],
  ])("%s is malformed, so it may be replaced without --force", (_label, body) => {
    plant(body);
    expect(serveConfigState(configDir)).toBe("malformed");
  });

  test("a file that cannot be read is unreadable, NOT malformed", () => {
    // The distinction the first version collapsed: it treated "I could not read
    // it" as "there is nothing worth protecting" and replaced a valid
    // configuration the process simply could not see.
    if (process.getuid?.() === 0) {
      return;
    }
    expect(saveServeConfig(defaultServeConfig("cred-1"), configDir)).toBe(true);
    chmodSync(serveConfigPath(configDir), 0o200);
    try {
      expect(serveConfigState(configDir)).toBe("unreadable");
    } finally {
      chmodSync(serveConfigPath(configDir), 0o600);
    }
  });

  test("a file too large to be a configuration is unreadable, not a process abort", () => {
    // Measured, not imagined: a review pointed serve.json at a 2 GiB sparse
    // file and every `keryx serve …` path died with SIGABRT and no output at
    // all, against a module header promising that nothing here throws.
    mkdirSync(configDir, { recursive: true });
    const file = serveConfigPath(configDir);
    const handle = openSync(file, "w");
    try {
      // Sparse: no real disk is consumed, and the size is what is being tested.
      ftruncateSync(handle, 3 * 1024 * 1024 * 1024);
    } finally {
      closeSync(handle);
    }

    expect(serveConfigState(configDir)).toBe("unreadable");
    const warnings: string[] = [];
    expect(loadServeConfig(configDir, (m) => warnings.push(m))).toBeNull();
    expect(warnings.join(" ")).toContain("too large");
  });

  test("a directory where serve.json should be is unreadable, not a crash", () => {
    mkdirSync(serveConfigPath(configDir), { recursive: true });
    expect(serveConfigState(configDir)).toBe("unreadable");
  });
});

describe("serveConfigAdvice, the one source of what to tell the operator", () => {
  const states: ServeConfigState[] = ["absent", "valid", "malformed", "unreadable"];

  test("every state has advice, and it names a command", () => {
    for (const state of states) {
      const advice = serveConfigAdvice(state);
      expect({ state, namesACommand: advice.includes("`keryx serve ") }).toEqual({
        state,
        namesACommand: true,
      });
    }
  });

  test("only `unreadable` requires --force, because only there is the file worth protecting AND unseen", () => {
    expect(serveConfigAdvice("unreadable")).toContain("--force");
    expect(serveConfigAdvice("malformed")).not.toContain("--force");
    expect(serveConfigAdvice("absent")).not.toContain("--force");
  });

  test("a VALID configuration is never told to run `config init`, which refuses", () => {
    // The whole reason this function exists. Executing every one of these is
    // `serve.recovery.test.ts`'s job; this pins the property at the source.
    expect(serveConfigAdvice("valid")).not.toContain("config init");
    expect(serveConfigAdvice("valid")).toContain("config set");
  });

  test("the four messages are distinct — a shared string would hide a wrong branch", () => {
    const messages = states.map(serveConfigAdvice);
    expect(new Set(messages).size).toBe(states.length);
  });
});
