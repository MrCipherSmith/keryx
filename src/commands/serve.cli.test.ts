// `keryx serve` command surface (flow 128 / roadmap R4b).
//
// Written BEFORE src/commands/serve.ts exists; the first run must fail with
// "Cannot find module ./serve".
//
// These drive the COMMAND with stdout and stderr captured, because the
// properties being asserted are properties of what the operator sees: the token
// is printed once and never again, and nothing that is not configured claims to
// be running. Testing the libraries alone would have proved neither — that is
// the mistake recorded in projects.escape.test.ts's header, one flow ago.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveCommand } from "./serve";
import { DEFAULT_SERVE_PROFILE, loadServeConfig, serveConfigPath } from "../lib/serve-config";
import { loadServeCredential, serveCredentialPath, verifyServeToken } from "../lib/serve-credential";

let xdgRoot = "";
let configDir = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalXdg: string | undefined;
let originalAppData: string | undefined;

function output(): string {
  return captured.join("\n");
}

/** Every file under `root`, as absolute paths. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full);
      }
    }
  };
  walk(root);
  return found;
}

beforeEach(() => {
  xdgRoot = mkdtempSync(path.join(tmpdir(), "keryx-serve-cli-"));
  configDir = path.join(xdgRoot, "keryx");
  originalXdg = process.env.XDG_DATA_HOME;
  originalAppData = process.env.APPDATA;
  process.env.XDG_DATA_HOME = xdgRoot;
  process.env.APPDATA = xdgRoot;

  captured = [];
  originalLog = console.log;
  originalError = console.error;
  console.log = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  console.error = (...parts: unknown[]) => captured.push(parts.map(String).join(" "));
  process.exitCode = 0;
});

afterEach(() => {
  console.log = originalLog;
  console.error = originalError;
  if (originalXdg === undefined) {
    delete process.env.XDG_DATA_HOME;
  } else {
    process.env.XDG_DATA_HOME = originalXdg;
  }
  if (originalAppData === undefined) {
    delete process.env.APPDATA;
  } else {
    process.env.APPDATA = originalAppData;
  }
  process.exitCode = 0;
  rmSync(xdgRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("off by default", () => {
  test("a fresh install has no configuration, no credential, and reports stopped", async () => {
    await serveCommand(["status"]);

    expect(output()).toContain("stopped");
    expect(process.exitCode ?? 0).toBe(0);
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
    expect(existsSync(serveCredentialPath(configDir))).toBe(false);
    // `filesUnder` returns [] for a directory that does not exist, so this line
    // does NOT establish that the helper works — that is pinned in the
    // lifecycle test below, which asserts it finds files. Here it says only:
    // nothing at all was written. The comment this replaced claimed otherwise.
    expect(filesUnder(configDir)).toEqual([]);
  });

  test("--json reports stopped with a pending-approval count of 0", async () => {
    await serveCommand(["status", "--json"]);
    const report = JSON.parse(output()) as Record<string, unknown>;
    expect(report.state).toBe("stopped");
    expect(report.pendingApprovals).toBe(0);
    expect(report.credential).toBe("absent");
  });

  test("running the server with nothing configured refuses and says what is missing", async () => {
    await serveCommand([]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("keryx serve config init");
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
  });
});

describe("configuration", () => {
  test("config init writes a loopback configuration carrying only a credential reference", async () => {
    await serveCommand(["config", "init"]);
    expect(process.exitCode ?? 0).toBe(0);

    const config = loadServeConfig(configDir);
    expect(config).not.toBeNull();
    expect(config!.enabled).toBe(true);
    expect(config!.bind.address).toBe("127.0.0.1");
    expect(config!.bind.acknowledgeNonLoopback).toBe(false);
    expect(config!.credentialRef.store).toBe("auth-json");
    // A UUID, not merely "non-empty" — a placeholder of any shape would satisfy
    // a length check while being useless as a reference.
    expect(config!.credentialRef.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("config init accepts a bind address, port, profile and the acknowledgement", async () => {
    await serveCommand([
      "config",
      "init",
      "--bind",
      "0.0.0.0",
      "--port",
      "7999",
      "--profile",
      "custom-remote",
      "--acknowledge-non-loopback",
    ]);
    const config = loadServeConfig(configDir)!;
    expect(config.bind).toEqual({ address: "0.0.0.0", port: 7999, acknowledgeNonLoopback: true });
    expect(config.profile).toBe("custom-remote");
  });

  test("config init rejects a port outside the valid range rather than writing a broken file", async () => {
    // `-1` is deliberately absent: a dash-leading value is consumed by the flag
    // parser as "this option needs a value", which is a different (and equally
    // correct) refusal, asserted separately below.
    for (const port of ["70000", "0", "abc", "1.5", "65536"]) {
      captured = [];
      process.exitCode = 0;
      await serveCommand(["config", "init", "--port", port]);
      expect({ port, exit: process.exitCode }).toEqual({ port, exit: 1 });
      // The CLI-level message, not the schema writer's generic one: an operator
      // told "could not write the serve configuration" has no idea the port was
      // the problem.
      expect(output()).toContain("--port must be an integer between 1 and 65535");
      expect(existsSync(serveConfigPath(configDir))).toBe(false);
    }
  });

  test("serve rejects an unusable --port with a message naming the flag", async () => {
    await serveCommand(["--port", "notanumber"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("--port must be an integer between 0 and 65535");
  });

  test("config show prints the configuration and no token", async () => {
    await serveCommand(["config", "init"]);
    await serveCommand(["token", "issue"]);
    const issued = output();
    const token = extractToken(issued);
    captured = [];

    await serveCommand(["config", "show"]);
    expect(output()).toContain("127.0.0.1");
    expect(output()).not.toContain(token);
  });

  test("config show with nothing configured says so and does not invent one", async () => {
    await serveCommand(["config", "show"]);
    // The wording moved to `serveConfigAdvice`, which is the one place that
    // decides what to say about an unusable configuration — this line used to
    // pin a literal that could not be right for all four states. What matters
    // here is that it reports the absence and names the command that fixes it.
    expect(output()).toContain("no serve configuration was found");
    expect(output()).toContain("keryx serve config init");
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
  });
});

/**
 * The token from a `serve token issue` transcript. Fails loudly if absent.
 *
 * Anchored to the `token: ` line rather than sniffing for a long opaque string:
 * a 64-character salt or hash would also match a generic pattern, and a helper
 * that can grab the wrong value makes every "the token does not appear" check
 * below meaningless.
 */
function extractToken(transcript: string): string {
  const match = /^\s*token:\s*(\S+)\s*$/m.exec(transcript);
  if (match === null) {
    throw new Error(`no token line found in transcript: ${transcript}`);
  }
  return match[1]!;
}

describe("the credential lifecycle", () => {
  test("issue prints the token exactly once and stores only a hash", async () => {
    await serveCommand(["token", "issue"]);
    const transcript = output();
    const token = extractToken(transcript);

    // Exactly once in the transcript, not merely at least once.
    const occurrences = transcript.split(token).length - 1;
    expect(occurrences).toBe(1);
    expect(transcript.toLowerCase()).toContain("shown once");

    const stored = readFileSync(serveCredentialPath(configDir), "utf8");
    expect(stored).not.toContain(token);
    expect(verifyServeToken(token, loadServeCredential(configDir)!)).toBe(true);
  });

  test("issue points the configuration at the credential it just created", async () => {
    await serveCommand(["config", "init"]);
    await serveCommand(["token", "issue"]);
    expect(loadServeConfig(configDir)!.credentialRef.id).toBe(loadServeCredential(configDir)!.id);
  });

  test("no later command prints the token again", async () => {
    await serveCommand(["config", "init"]);
    await serveCommand(["token", "issue"]);
    const token = extractToken(output());
    captured = [];

    await serveCommand(["status"]);
    await serveCommand(["status", "--json"]);
    await serveCommand(["config", "show"]);
    await serveCommand(["--help"]);
    await serveCommand(["token"]);
    await serveCommand(["nonsense"]);

    expect(output()).not.toContain(token);
    // Not vacuous: those commands did produce output.
    expect(output().length).toBeGreaterThan(200);
  });

  test("a second issue refuses rather than silently invalidating the live token", async () => {
    await serveCommand(["token", "issue"]);
    const token = extractToken(output());
    captured = [];

    await serveCommand(["token", "issue"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("rotate");
    expect(verifyServeToken(token, loadServeCredential(configDir)!)).toBe(true);
  });

  test("rotate issues a new token and invalidates the old one", async () => {
    await serveCommand(["config", "init"]);
    await serveCommand(["token", "issue"]);
    const first = extractToken(output());
    captured = [];

    await serveCommand(["token", "rotate"]);
    const second = extractToken(output());
    expect(second).not.toBe(first);

    const record = loadServeCredential(configDir)!;
    expect(verifyServeToken(second, record)).toBe(true);
    expect(verifyServeToken(first, record)).toBe(false);
    // And the configuration follows the rotation rather than going stale.
    expect(loadServeConfig(configDir)!.credentialRef.id).toBe(record.id);
  });

  test("revoke removes the credential; a second revoke is reported distinctly", async () => {
    await serveCommand(["token", "issue"]);
    captured = [];
    await serveCommand(["token", "revoke"]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(loadServeCredential(configDir)).toBeNull();

    captured = [];
    await serveCommand(["token", "revoke"]);
    expect(process.exitCode).toBe(1);
    expect(output().toLowerCase()).toContain("no serve credential");
  });

  test("an unknown token subcommand is refused", async () => {
    await serveCommand(["token", "print"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Usage");
  });
});

describe("status reporting", () => {
  test("a configured server with a credential reports configured, with bind and profile", async () => {
    await serveCommand(["config", "init", "--profile", "remote-restricted"]);
    await serveCommand(["token", "issue"]);
    captured = [];

    await serveCommand(["status", "--json"]);
    const report = JSON.parse(output()) as Record<string, unknown>;
    expect(report.state).toBe("configured");
    expect(report.profile).toBe("remote-restricted");
    expect(report.nonLoopback).toBe(false);
    expect(report.pendingApprovals).toBe(0);
    expect(report.credential).toBe("present");
    expect(String(report.credentialFingerprint)).toMatch(/^[0-9a-f]{8}$/);
  });

  test("a non-loopback bind without acknowledgement is reported as refused, with the reason", async () => {
    await serveCommand(["config", "init", "--bind", "0.0.0.0"]);
    await serveCommand(["token", "issue"]);
    captured = [];

    await serveCommand(["status", "--json"]);
    const report = JSON.parse(output()) as Record<string, unknown>;
    expect(report.state).toBe("refused");
    expect(report.reason).toBe("non-loopback-not-acknowledged");
    expect(report.nonLoopback).toBe(true);
  });

  test("a non-loopback bind WITH acknowledgement is configured and reported as non-loopback", async () => {
    await serveCommand(["config", "init", "--bind", "0.0.0.0", "--acknowledge-non-loopback"]);
    await serveCommand(["token", "issue"]);
    captured = [];

    await serveCommand(["status", "--json"]);
    const report = JSON.parse(output()) as Record<string, unknown>;
    expect(report.state).toBe("configured");
    expect(report.nonLoopback).toBe(true);
  });

  test("a configuration with no credential is refused, not configured", async () => {
    await serveCommand(["config", "init"]);
    captured = [];
    await serveCommand(["status", "--json"]);
    const report = JSON.parse(output()) as Record<string, unknown>;
    expect(report.state).toBe("refused");
    expect(report.reason).toBe("no-credential");
  });
});

describe("the configuration and the credential cannot silently disagree", () => {
  test("a rotate that cannot repoint the configuration exits non-zero and says what to run", async () => {
    // The failure this closes: rotate persisted the new credential, failed to
    // update serve.json, printed a bullet on STDOUT, and exited 0. The operator
    // was left with a dead old token, a new token the server refuses, a config
    // that will not start — and a success exit code.
    if (process.platform === "win32") {
      return;
    }
    await serveCommand(["config", "init"]);
    await serveCommand(["token", "issue"]);
    captured = [];

    // Only serve.json is made unwritable. Locking the whole directory would
    // stop the credential lock file being created at all, and the run would
    // spin out the 15s lock timeout instead of reaching the branch under test.
    chmodSync(serveConfigPath(configDir), 0o400);
    try {
      await serveCommand(["token", "rotate"]);
    } finally {
      chmodSync(serveConfigPath(configDir), 0o600);
    }

    expect(process.exitCode).toBe(1);
    // `token rotate`, NOT `config init`. This assertion originally pinned the
    // opposite, and a review followed that instruction on a customised
    // deployment and watched bind, port, profile and the acknowledgement reset
    // to defaults. `serve.recovery.test.ts` holds the full story.
    expect(output()).toContain("keryx serve token rotate");
    expect(output()).not.toContain("config init");
    // And the operator was still shown the token, because it cannot be recovered.
    expect(() => extractToken(output())).not.toThrow();
  });

  test("issue does not claim to have replaced a previous credential when there was none", async () => {
    await serveCommand(["config", "init"]);
    captured = [];
    await serveCommand(["token", "issue"]);
    expect(output()).not.toContain("previous credential");
  });
});

describe("argv discipline", () => {
  test("a repeated value flag is refused rather than silently last-wins", async () => {
    // `--bind 10.0.0.5 --bind 127.0.0.1` quietly discarding the first is the
    // argument-order dependence this parser's own contract says it prevents.
    for (const args of [
      ["config", "init", "--port", "7001", "--port", "7002"],
      ["config", "init", "--bind", "10.0.0.5", "--bind", "127.0.0.1"],
      ["config", "init", "--profile", "a", "--profile", "b"],
    ]) {
      captured = [];
      process.exitCode = 0;
      await serveCommand(args);
      expect({ args, exit: process.exitCode }).toEqual({ args, exit: 1 });
      expect(output()).toContain("given more than once");
      expect(existsSync(serveConfigPath(configDir))).toBe(false);
    }
  });

  test("a repeated boolean flag is refused too", async () => {
    await serveCommand(["config", "init", "--acknowledge-non-loopback", "--acknowledge-non-loopback"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("given more than once");
  });

  test("an empty or blank --profile is refused with a message naming the flag", async () => {
    for (const profile of ["", "   "]) {
      captured = [];
      process.exitCode = 0;
      await serveCommand(["config", "init", "--profile", profile]);
      expect({ profile, exit: process.exitCode }).toEqual({ profile, exit: 1 });
      expect(output()).toContain("--profile must not be empty");
      expect(existsSync(serveConfigPath(configDir))).toBe(false);
    }
  });

  test("a blank --bind is refused with a message naming the flag", async () => {
    await serveCommand(["config", "init", "--bind", "   "]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("--bind must not be empty");
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
  });

  const helpForms = [["--help"], ["-h"], ["help"], ["status", "--help"], ["config", "--help"], ["token", "--help"]];

  for (const form of helpForms) {
    test(`serve ${form.join(" ")} prints usage at exit 0`, async () => {
      await serveCommand(form);
      expect(output()).toContain("Usage");
      expect(process.exitCode ?? 0).toBe(0);
    });
  }

  test("an unknown option is refused rather than ignored", async () => {
    await serveCommand(["status", "--jsonn"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Unknown option");
  });

  test("an unknown subcommand is refused", async () => {
    await serveCommand(["frobnicate"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Usage");
  });

  test("a flag that needs a value and has none is refused", async () => {
    await serveCommand(["config", "init", "--bind"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Option --bind needs a value");
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
  });

  test("a dash-leading value is not silently swallowed as the value", async () => {
    await serveCommand(["config", "init", "--port", "-1"]);
    expect(process.exitCode).toBe(1);
    expect(output()).toContain("Option --port needs a value");
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
  });
});

describe("no secret reaches disk or the terminal", () => {
  test("a full lifecycle leaves the token in no file and in no stream but the one issue line", async () => {
    await serveCommand(["config", "init"]);
    // The refusal path is exercised here, while no credential exists, so this
    // test never reaches the branch that binds and waits for a signal. Binding
    // is covered end-to-end by serve.process.test.ts, in a real subprocess.
    await serveCommand([]);
    expect(output()).toContain("keryx serve token issue");
    captured = [];

    await serveCommand(["token", "issue"]);
    const token = extractToken(output());
    captured = [];

    await serveCommand(["status"]);
    await serveCommand(["status", "--json"]);
    await serveCommand(["config", "show"]);
    expect(output()).not.toContain(token);
    captured = [];

    await serveCommand(["token", "rotate"]);
    const rotated = extractToken(output());
    captured = [];

    await serveCommand(["status"]);
    await serveCommand(["config", "show"]);
    await serveCommand(["token", "revoke"]);

    // Every byte of every file the lifecycle wrote.
    const files = filesUnder(configDir);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const bytes = readFileSync(file, "utf8");
      expect({ file, hasFirst: bytes.includes(token) }).toEqual({ file, hasFirst: false });
      expect({ file, hasSecond: bytes.includes(rotated) }).toEqual({ file, hasSecond: false });
    }

    // Every stream captured after the issue/rotate lines themselves.
    expect(output()).not.toContain(token);
    expect(output()).not.toContain(rotated);
  }, 30_000);

  test("the credential store and the configuration are owner-only", async () => {
    if (process.platform === "win32") {
      return;
    }
    await serveCommand(["config", "init"]);
    await serveCommand(["token", "issue"]);
    expect(statSync(serveConfigPath(configDir)).mode & 0o777).toBe(0o600);
    expect(statSync(serveCredentialPath(configDir)).mode & 0o777).toBe(0o600);
  });
});

describe("the fixture redirect actually works", () => {
  test("commands write under the fixture directory, never the developer's real config", async () => {
    // If XDG_DATA_HOME were not honoured, every assertion in this file would be
    // testing the developer's own machine — and passing.
    mkdirSync(configDir, { recursive: true });
    await serveCommand(["config", "init"]);
    expect(existsSync(path.join(configDir, "serve.json"))).toBe(true);
  });
});
