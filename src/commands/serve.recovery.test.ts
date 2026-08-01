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
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    // `loadServeConfig` returns null for a file that does not parse or does not
    // match the schema. Refusing there would leave the operator with a broken
    // file they cannot fix through the CLI — the guard exists to protect a
    // configuration, and there is none to protect.
    await run(["config", "init", ...CUSTOM]);
    Bun.write(serveConfigPath(configDir), "{not json");
    await Bun.sleep(0);

    const repaired = await run(["config", "init"]);

    expect(repaired.exit).toBe(0);
    expect(deployment().address).toBe("127.0.0.1");
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
