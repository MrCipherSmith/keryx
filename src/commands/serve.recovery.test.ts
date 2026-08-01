// `config init` does not destroy a configuration, and the rotate-failure
// recovery instruction does not tell the operator to.
//
// A security review of PR #216 followed the printed recovery path verbatim on a
// customised deployment and recorded the result: bind address, port, profile and
// the non-loopback acknowledgement were all reset to defaults, exit 0, with
// nothing saying a configuration had been replaced. The operator's remote
// transport had been reaching `10.0.0.5:8443`; after "recovery" the listener was
// on `127.0.0.1:7377` and nothing connected.
//
// Two defects, fixed together because they are one story:
//
//   1. `keryx serve token rotate` ALONE is the recovery — it re-mints and
//      re-points in one operation. The `config init` step the message named was
//      never needed, and `keryx serve status` was already printing the correct
//      instruction, so the two disagreed and the operator saw the wrong one at
//      exactly the moment it mattered.
//   2. `config init` overwrote an existing configuration unconditionally. That
//      is a destructive operation wearing the name of a first-run command.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveCommand } from "./serve";
import { loadServeConfig, serveConfigPath } from "../lib/serve-config";
import { loadServeCredential, verifyServeToken } from "../lib/serve-credential";

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

/** Run a serve subcommand with a clean transcript and exit code. */
async function run(args: string[]): Promise<{ exit: number; out: string }> {
  captured = [];
  process.exitCode = 0;
  await serveCommand(args);
  return { exit: process.exitCode ?? 0, out: output() };
}

/** The token from a `token issue`/`token rotate` transcript. Throws if absent. */
function extractToken(transcript: string): string {
  const match = /^\s*token:\s*(\S+)\s*$/m.exec(transcript);
  if (match === null) {
    throw new Error(`no token line found in transcript: ${transcript}`);
  }
  return match[1]!;
}

/** The four fields an operator configures and a clobber silently resets. */
function deployment(): { address: string; port: number; ack: boolean | undefined; profile: string } {
  const config = loadServeConfig(configDir);
  if (config === null) {
    throw new Error("expected a configuration on disk");
  }
  return {
    address: config.bind.address,
    port: config.bind.port,
    ack: config.bind.acknowledgeNonLoopback,
    profile: config.profile,
  };
}

const CUSTOM = ["--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened", "--acknowledge-non-loopback"];
const CUSTOM_DEPLOYMENT = { address: "10.0.0.5", port: 8443, ack: true, profile: "hardened" };

beforeEach(() => {
  xdgRoot = mkdtempSync(path.join(tmpdir(), "keryx-serve-recovery-"));
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
  // The failure fixture leaves serve.json read-only; rmSync needs the directory
  // writable, which it is, but restore the file mode anyway so a debugging run
  // that keeps the fixture is not confusing.
  const file = serveConfigPath(configDir);
  if (existsSync(file)) {
    chmodSync(file, 0o600);
  }
  rmSync(xdgRoot, { recursive: true, force: true });
});

describe("config init refuses to replace an existing configuration", () => {
  test("a second init exits non-zero and changes nothing on disk", async () => {
    await run(["config", "init", ...CUSTOM]);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
    const before = readFileSync(serveConfigPath(configDir), "utf8");

    const second = await run(["config", "init"]);

    expect(second.exit).toBe(1);
    expect(readFileSync(serveConfigPath(configDir), "utf8")).toBe(before);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("the refusal names --force, so the operator is not stuck", async () => {
    await run(["config", "init", ...CUSTOM]);

    const second = await run(["config", "init"]);

    expect(second.out).toContain("--force");
  });

  test("--force replaces it, which is the whole point of having the flag", async () => {
    await run(["config", "init", ...CUSTOM]);

    const forced = await run(["config", "init", "--force"]);

    expect(forced.exit).toBe(0);
    expect(deployment()).toEqual({ address: "127.0.0.1", port: 7377, ack: false, profile: "remote-restricted" });
  });

  test("--force on a FIRST init is accepted, not treated as an error", async () => {
    // Otherwise a scripted deployment has to know whether it is the first run.
    const first = await run(["config", "init", "--force", ...CUSTOM]);

    expect(first.exit).toBe(0);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("a DAMAGED configuration is replaceable without --force", async () => {
    // A file that does not parse, or parses and fails the schema, protects
    // nothing. Refusing there would leave the operator with a broken file they
    // cannot fix through the CLI.
    await run(["config", "init", ...CUSTOM]);
    writeFileSync(serveConfigPath(configDir), "{not json", "utf8");

    const repaired = await run(["config", "init"]);

    expect(repaired.exit).toBe(0);
    expect(deployment().address).toBe("127.0.0.1");
  });

  test("an UNREADABLE configuration is NOT replaceable without --force", async () => {
    // The first version of the guard was `loadServeConfig(...) !== null`, which
    // conflates "malformed" with "I could not read it". A review chmodded a
    // perfectly valid configuration to 0200 and watched `config init` replace
    // it at exit 0 — the deployment destroyed by the very guard meant to
    // protect it, because the process could not see what it was overwriting.
    if (process.getuid?.() === 0) {
      return;
    }
    await run(["config", "init", ...CUSTOM]);
    const before = readFileSync(serveConfigPath(configDir), "utf8");
    chmodSync(serveConfigPath(configDir), 0o200);

    const attempted = await run(["config", "init"]);
    chmodSync(serveConfigPath(configDir), 0o600);

    expect(attempted.exit).toBe(1);
    expect(readFileSync(serveConfigPath(configDir), "utf8")).toBe(before);
  });
});

describe("config set patches without replacing", () => {
  test("it changes only what was named", async () => {
    await run(["config", "init", ...CUSTOM]);

    const patched = await run(["config", "set", "--port", "9001"]);

    expect(patched.exit).toBe(0);
    expect(deployment()).toEqual({ ...CUSTOM_DEPLOYMENT, port: 9001 });
  });

  test("it can acknowledge a non-loopback bind without resetting the deployment", async () => {
    // The exact recovery the non-loopback refusal now prints.
    await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
    expect(deployment().ack).toBe(false);

    const acknowledged = await run(["config", "set", "--bind", "10.0.0.5", "--acknowledge-non-loopback"]);

    expect(acknowledged.exit).toBe(0);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("--enable and --disable flip only `enabled`", async () => {
    await run(["config", "init", ...CUSTOM]);

    expect((await run(["config", "set", "--disable"])).exit).toBe(0);
    expect(loadServeConfig(configDir)!.enabled).toBe(false);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);

    expect((await run(["config", "set", "--enable"])).exit).toBe(0);
    expect(loadServeConfig(configDir)!.enabled).toBe(true);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("--enable and --disable together are refused rather than resolved by order", async () => {
    await run(["config", "init", ...CUSTOM]);

    const both = await run(["config", "set", "--enable", "--disable"]);

    expect(both.exit).toBe(1);
    expect(loadServeConfig(configDir)!.enabled).toBe(true);
  });

  test("with no flags it refuses rather than rewriting the file for nothing", async () => {
    await run(["config", "init", ...CUSTOM]);

    const empty = await run(["config", "set"]);

    expect(empty.exit).toBe(1);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("with nothing configured it points at config init instead of inventing a config", async () => {
    const orphan = await run(["config", "set", "--port", "9001"]);

    expect(orphan.exit).toBe(1);
    expect(orphan.out).toContain("keryx serve config init");
    expect(existsSync(serveConfigPath(configDir))).toBe(false);
  });
});

describe("the rotate-failure recovery instruction", () => {
  /**
   * Reproduce the two-write window: the credential store is writable, the
   * configuration is not, so `rotate` mints a new credential and then cannot
   * repoint `serve.json` at it.
   */
  async function rotateIntoTheWindow(): Promise<{ exit: number; out: string }> {
    await run(["config", "init", ...CUSTOM]);
    await run(["token", "issue"]);
    chmodSync(serveConfigPath(configDir), 0o400);
    const failed = await run(["token", "rotate"]);
    chmodSync(serveConfigPath(configDir), 0o600);
    return failed;
  }

  test("the failure is loud: non-zero, and it says the server will refuse to start", async () => {
    if (process.getuid?.() === 0) {
      // root ignores the mode bits, so the write succeeds and there is no
      // window to reproduce. Skipping is honest; asserting would be theatre.
      return;
    }
    const failed = await rotateIntoTheWindow();

    expect(failed.exit).toBe(1);
    expect(failed.out).toContain("refuse to start");
  });

  test("it does NOT tell the operator to run `config init`, which would reset the deployment", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    const failed = await rotateIntoTheWindow();

    expect(failed.out).not.toContain("config init");
    expect(failed.out).toContain("keryx serve token rotate");
  });

  test("following the instruction recovers AND preserves bind, port, profile and the acknowledgement", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    await rotateIntoTheWindow();

    const recovered = await run(["token", "rotate"]);

    expect(recovered.exit).toBe(0);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);

    // Recovery means the printed token actually authenticates against the
    // credential the configuration now references — not merely that a file was
    // written.
    const token = extractToken(recovered.out);
    const record = loadServeCredential(configDir);
    expect(record).not.toBeNull();
    expect(verifyServeToken(token, record!)).toBe(true);
    expect(loadServeConfig(configDir)!.credentialRef.id).toBe(record!.id);
  });

  test("no instruction printed while a configuration EXISTS names `config init`", async () => {
    // The class, not the call site. The first fix corrected the one message the
    // finding named, and a review then found three more — the `disabled`
    // refusal, the non-loopback refusal, and the `serve status` note — each of
    // which is reachable ONLY when a configuration exists, and each of which
    // told the operator to run a command that now refuses.
    //
    // `--force` does not make them acceptable: it is a full replace built from
    // the defaults, so following such an instruction resets bind, port and
    // profile. The rule is therefore absolute for these states.
    const states: Array<{ label: string; setup: () => Promise<void>; invoke: string[] }> = [
      {
        label: "disabled configuration, keryx serve",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          await run(["config", "set", "--disable"]);
        },
        invoke: [],
      },
      {
        label: "disabled configuration, keryx serve status",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          await run(["config", "set", "--disable"]);
        },
        invoke: ["status"],
      },
      {
        label: "unacknowledged non-loopback bind, keryx serve",
        setup: async () => {
          await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
          await run(["token", "issue"]);
        },
        invoke: [],
      },
      {
        label: "unacknowledged non-loopback bind, keryx serve status",
        setup: async () => {
          await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
          await run(["token", "issue"]);
        },
        invoke: ["status"],
      },
    ];

    const offenders: string[] = [];
    for (const state of states) {
      rmSync(serveConfigPath(configDir), { force: true });
      await state.setup();
      const result = await run(state.invoke);
      // Not vacuous: each state must actually produce a message to inspect.
      expect({ label: state.label, empty: result.out.trim().length === 0 }).toEqual({
        label: state.label,
        empty: false,
      });
      if (result.out.includes("config init")) {
        offenders.push(state.label);
      }
    }

    expect(offenders).toEqual([]);
  }, 30_000);

  test("the disabled refusal prints an instruction that works and preserves the deployment", async () => {
    await run(["config", "init", ...CUSTOM]);
    await run(["token", "issue"]);
    await run(["config", "set", "--disable"]);

    const refused = await run([]);
    expect(refused.exit).toBe(1);
    expect(refused.out).toContain("keryx serve config set --enable");

    const followed = await run(["config", "set", "--enable"]);
    expect(followed.exit).toBe(0);
    expect(loadServeConfig(configDir)!.enabled).toBe(true);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("the non-loopback refusal prints an instruction that works and preserves the deployment", async () => {
    await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
    await run(["token", "issue"]);

    const refused = await run([]);
    expect(refused.exit).toBe(1);
    expect(refused.out).toContain("keryx serve config set --bind");

    const followed = await run(["config", "set", "--bind", "10.0.0.5", "--acknowledge-non-loopback"]);
    expect(followed.exit).toBe(0);
    expect(deployment()).toEqual(CUSTOM_DEPLOYMENT);
  });

  test("status prints the same recovery instruction the failure does", async () => {
    if (process.getuid?.() === 0) {
      return;
    }
    // The two disagreeing is how the wrong one survived review: `status` had it
    // right and the failure path did not, and only the failure path is read at
    // the moment it matters.
    await rotateIntoTheWindow();

    const status = await run(["status"]);

    expect(status.out).toContain("keryx serve token rotate");
    expect(status.out).not.toContain("config init");
  });
});
