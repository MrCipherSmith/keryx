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
import { loadServeConfig, saveServeConfig, serveConfigPath } from "../lib/serve-config";
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

/**
 * Every `keryx serve …` span in the transcript, in the order printed.
 *
 * Backticks are NOT required. An earlier version required them, and a
 * mutation drifted the one unbackticked instruction — the non-loopback note
 * in `runServe` — to a command that exits 1 with nothing going red. Every
 * site is backticked now, and the extractor no longer depends on that.
 *
 * NOTHING is substituted. An earlier version rewrote `<addr>` into a real
 * address before executing, so for the one instruction that carried a
 * placeholder this suite proved a command it had written itself rather than
 * the one the operator is handed. Both sites now print the configured
 * address, and `no executed instruction still carries a placeholder` below
 * fails if a placeholder ever comes back into an executable instruction.
 *
 * The disposition is derived from the SPAN, not from a list of commands
 * this file happens to know about — a list is how the `token` forms stayed
 * outside the class for a whole round:
 *
 *   `usageForm`        carries `<`, `[` or `|`; documentation, not a command
 *   `startsAListener`  no subcommand, only flags; covered by its own test
 *   `runnable`         everything else; executed verbatim
 */
type Disposition = "runnable" | "usageForm" | "startsAListener";
interface Instruction {
  command: string;
  argv: string[];
  disposition: Disposition;
}

function instructions(transcript: string): Instruction[] {
  const out: Instruction[] = [];
  // Two alternatives, and the order matters. A BACKTICKED span runs to its
  // closing backtick and may contain anything, including the dots of an
  // IPv4 address; an UNBACKTICKED one has to stop at sentence punctuation,
  // because nothing else marks where it ends.
  //
  // One terminator set for both truncated `--bind 10.0.0.5` to `--bind 10`
  // and executed that instead — silently, because "10" is an address the
  // setter accepts. The guard whose whole purpose is verbatim execution was
  // rewriting the one instruction that carries an address.
  const pattern = /`(keryx serve[^`\n]*)`|(keryx serve(?:\s+[^`\n.;]*)?)/g;
  for (const match of transcript.matchAll(pattern)) {
    const command = (match[1] ?? match[2]!).trim();
    // Drop the leading `keryx serve` — `run()` supplies both.
    const argv = command.split(/\s+/).slice(2);
    const disposition: Disposition = /[<[|]/.test(command)
      ? "usageForm"
      : argv.length === 0 || argv[0]!.startsWith("-")
        ? "startsAListener"
        : "runnable";
    out.push({ command, argv, disposition });
  }
  return out;
}

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

  test("a non-loopback acknowledgement does not carry over to a DIFFERENT address", async () => {
    // A review moved an acknowledged 10.0.0.5 to 203.0.113.9 and watched
    // `acknowledgeNonLoopback: true` follow it with no warning — silently
    // authorising a bind the operator never acknowledged. `config init --bind
    // 203.0.113.9` correctly wrote false, so `config set` was strictly weaker
    // than the command it exists to replace.
    await run(["config", "init", ...CUSTOM]);
    expect(deployment().ack).toBe(true);

    const moved = await run(["config", "set", "--bind", "203.0.113.9"]);

    expect(moved.exit).toBe(0);
    expect(deployment()).toEqual({ address: "203.0.113.9", port: 8443, ack: false, profile: "hardened" });
    // And it says so, because dropping it silently is the same failure in the
    // other direction: the next `keryx serve` refuses and the operator does not
    // know why.
    expect(moved.out).toContain("did not carry over");
  });

  test("re-stating the SAME address keeps the acknowledgement", async () => {
    // Otherwise the fix above would make `config set --bind <same> --port N`
    // silently withdraw an acknowledgement the operator never touched.
    await run(["config", "init", ...CUSTOM]);

    const same = await run(["config", "set", "--bind", "10.0.0.5", "--port", "9443"]);

    expect(same.exit).toBe(0);
    expect(deployment()).toEqual({ ...CUSTOM_DEPLOYMENT, port: 9443 });
  });

  test("--no-acknowledge-non-loopback withdraws it, and is not reported as an accident", async () => {
    // The flag appeared in exactly one file and in no test. An explicit
    // withdrawal being reported as "did not carry over … re-run with
    // --acknowledge-non-loopback" tells the operator to undo what they just
    // asked for.
    await run(["config", "init", ...CUSTOM]);

    const withdrawn = await run(["config", "set", "--bind", "203.0.113.9", "--no-acknowledge-non-loopback"]);

    expect(withdrawn.exit).toBe(0);
    expect(deployment()).toEqual({ address: "203.0.113.9", port: 8443, ack: false, profile: "hardened" });
    expect(withdrawn.out).not.toContain("did not carry over");
  });

  test("--no-acknowledge-non-loopback withdraws it without a rebind too", async () => {
    await run(["config", "init", ...CUSTOM]);

    const withdrawn = await run(["config", "set", "--no-acknowledge-non-loopback"]);

    expect(withdrawn.exit).toBe(0);
    expect(deployment()).toEqual({ ...CUSTOM_DEPLOYMENT, ack: false });
  });

  test("an explicit acknowledgement moves with the address", async () => {
    await run(["config", "init", ...CUSTOM]);

    const moved = await run(["config", "set", "--bind", "203.0.113.9", "--acknowledge-non-loopback"]);

    expect(moved.exit).toBe(0);
    expect(deployment()).toEqual({ address: "203.0.113.9", port: 8443, ack: true, profile: "hardened" });
  });

  test("it preserves every field it does not name, not only the four we render", async () => {
    // `deployment()` reads four fields. `credentialRef`, `approval`, `bounds`,
    // `retentionDays` and `schemaVersion` are preserved too, and nothing pinned
    // it — a reviewer had to verify that by hand.
    await run(["config", "init", ...CUSTOM]);
    await run(["token", "issue"]);
    const enriched = {
      ...loadServeConfig(configDir)!,
      bounds: { maxBodyBytes: 4096, maxPromptChars: 99, maxConcurrentTurnsPerSession: 2, eventBacklogSeconds: 7 },
      retentionDays: 11,
    };
    expect(saveServeConfig(enriched, configDir)).toBe(true);

    const patched = await run(["config", "set", "--port", "9001"]);
    expect(patched.exit).toBe(0);

    const after = loadServeConfig(configDir)!;
    expect(after.bind.port).toBe(9001);
    // Everything else, compared as whole objects so a dropped key fails.
    expect(after.schemaVersion).toBe(enriched.schemaVersion);
    expect(after.credentialRef).toEqual(enriched.credentialRef);
    expect(after.approval).toEqual(enriched.approval);
    expect(after.bounds).toEqual(enriched.bounds);
    expect(after.retentionDays).toBe(11);
    expect(after.profile).toBe("hardened");
    expect(after.enabled).toBe(true);
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

  test("every configuration instruction the CLI prints EXITS 0 when executed", async () => {
    // The guard that replaces a substring check.
    //
    // Its first version asserted only that the printed text did not contain
    // "config init", and enumerated four states that all had a VALID
    // configuration on disk. A review then found three instructions it could
    // not see: two more states (`malformed`, `unreadable`) that the same commit
    // had newly made distinguishable, and two messages that named `config init`
    // in a state where `config init` now refuses. All three passed the old
    // guard — one because it printed `config set`, two because their state was
    // never enumerated.
    //
    // So: enumerate every state the configuration can be in, run both `keryx
    // serve` and `keryx serve status`, extract every `keryx serve …` command
    // from the output, and RUN IT. Exit 0 or the guard fails.
    //
    // The scope was narrower than the criterion for one round. AC8 claims every
    // operator instruction printed by `keryx serve` is executed verbatim, and
    // the extractor matched `keryx serve config …` alone — so of the fifteen
    // printed instructions, the `token issue` / `token rotate` and bare
    // `keryx serve --acknowledge-non-loopback` forms were asserted by substring
    // and never run. A criterion covering a subset of its own class is the
    // site-not-class pattern this flow was opened to close, reproduced inside
    // the flow's own evidence.
    //
    // Now every printed span is extracted and carries a DISPOSITION, and the
    // dispositions are asserted by value. Nothing is silently outside the
    // class: an instruction is executed, or it is documentation, or it starts a
    // listener and is covered by the refusal test below — and which one it is
    // is a fact this file asserts rather than a scope note in a comment.
    const states: Array<{ label: string; setup: () => Promise<void> }> = [
      {
        label: "absent",
        setup: async () => {
          rmSync(serveConfigPath(configDir), { force: true });
        },
      },
      {
        label: "valid but disabled",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          await run(["config", "set", "--disable"]);
        },
      },
      {
        label: "valid, non-loopback, unacknowledged",
        setup: async () => {
          await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
          await run(["token", "issue"]);
        },
      },
      {
        label: "malformed",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          writeFileSync(serveConfigPath(configDir), "{not json", "utf8");
        },
      },
      {
        label: "parses but fails the schema",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          writeFileSync(serveConfigPath(configDir), JSON.stringify({ nonsense: true }), "utf8");
        },
      },
      {
        label: "unreadable",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          chmodSync(serveConfigPath(configDir), 0o200);
        },
      },
    ];

    const failures: string[] = [];
    const statesThatPrintedAnInstruction = new Set<string>();
    const skippedUsageForms: string[] = [];
    const listenerStarts: string[] = [];
    const executed: string[] = [];
    for (const state of states) {
      // `config show` is here because a mutation proved it unguarded: reverting
      // its instruction to a bare `config init` — which refuses on an
      // unreadable file — left every test in this file green. A guard that
      // enumerates states but not the commands that print to them is only half
      // a guard.
      for (const invoke of [[], ["status"], ["config", "show"], ["config", "init"], ["config", "set", "--enable"]]) {
        rmSync(serveConfigPath(configDir), { force: true });
        rmSync(serveCredentialPath(configDir), { force: true });
        await state.setup();

        const shown = await run(invoke);
        const printed = instructions(shown.out);
        skippedUsageForms.push(...printed.filter((i) => i.disposition === "usageForm").map((i) => i.command));
        listenerStarts.push(...printed.filter((i) => i.disposition === "startsAListener").map((i) => i.command));

        // G1: a command that SHOULD advise must advise. Without this, `config
        // show` could go mute in three of the six states and the per-state set
        // below would still be satisfied by `serve` and `serve status`.
        //
        // Scoped to the commands that REPORT on the configuration. `config init`
        // and `config set` are here to have their own instructions executed;
        // when they succeed they repair the configuration instead of advising,
        // and demanding an instruction from them would be demanding a failure.
        const reports = invoke.length === 0 || invoke[0] === "status" || invoke[1] === "show";
        if (reports && state.label !== "valid but disabled" && state.label !== "valid, non-loopback, unacknowledged") {
          if (printed.length === 0) {
            failures.push(`[${state.label}] \`keryx serve ${invoke.join(" ")}\` printed no instruction at all`);
          }
        }

        // Instructions printed TOGETHER are one recovery path, not a menu. The
        // `absent` state prints "`keryx serve config init` then `keryx serve
        // token issue`", and `token issue` alone leaves a server with no
        // configuration stopped — which is correct, and which is why executing
        // each instruction independently could not include the `token` forms at
        // all. Followed in order, the same pair is exactly the repair the
        // operator is being handed.
        //
        // Identical spans collapse: a transcript that names one step twice is
        // still one step, and `config init` run twice refuses the second time
        // by design.
        const sequence = printed.filter((i) => i.disposition === "runnable");
        const seen = new Set<string>();
        let followedAny = false;
        for (const instruction of sequence) {
          if (seen.has(instruction.command)) {
            continue;
          }
          seen.add(instruction.command);
          statesThatPrintedAnInstruction.add(state.label);
          executed.push(instruction.command);
          const followed = await run(instruction.argv);
          followedAny = true;
          if (followed.exit !== 0) {
            failures.push(
              `[${state.label}] \`keryx serve ${invoke.join(" ")}\` printed \`${instruction.command}\`, which exited ${followed.exit}: ${followed.out.trim()}`,
            );
          }
        }
        if (followedAny) {
          // G2: exit 0 is not enough. An instruction that succeeds and repairs
          // nothing is precisely the "wrong instruction" this guard exists for,
          // and the exit-code-only version passed when the malformed advice was
          // drifted to `config show`. After following the whole printed path,
          // the configuration must be usable — which for every state here means
          // `serve status` no longer reports `stopped`.
          const after = await run(["status"]);
          if (after.out.includes("state:      stopped")) {
            failures.push(
              `[${state.label}] following \`${[...seen].join("` then `")}\` left the server stopped: ${after.out.trim()}`,
            );
          }
        }
        // Restore the mode so the fixture can be torn down and reused.
        if (existsSync(serveConfigPath(configDir))) {
          chmodSync(serveConfigPath(configDir), 0o600);
        }
      }
    }

    // Not vacuous: if the extraction ever stopped matching, `failures` would be
    // empty for the wrong reason. Every state must produce at least one
    // actionable instruction from at least one of the three commands. (`config
    // show` on a healthy configuration prints the configuration and no
    // instruction, which is correct, so this counts states rather than rows.)
    expect(statesThatPrintedAnInstruction.size).toBe(states.length);
    // Exactly which spans were treated as documentation rather than commands.
    // Asserted by value: a silent `continue` is how an instruction disappears.
    expect([...new Set(skippedUsageForms)].sort()).toEqual([
      "keryx serve config set <setting>",
    ]);
    // And exactly which were treated as listener starts. This is the set the
    // criterion used to cover by substring; it is asserted by value here and
    // executed for real by `the listener-start instruction refuses …` below, so
    // "not executed in this loop" no longer means "not covered".
    expect([...new Set(listenerStarts)].sort()).toEqual([
      "keryx serve --acknowledge-non-loopback",
    ]);
    // What was actually RUN, by value. The count assertion below cannot tell a
    // widened extractor from the `config`-only one it replaced; this can, and
    // it fails the moment a subcommand family drops back out of the class.
    expect([...new Set(executed)].sort()).toEqual([
      "keryx serve config init",
      "keryx serve config init --force",
      "keryx serve config set --bind 10.0.0.5 --acknowledge-non-loopback",
      "keryx serve config set --enable",
      // Not reachable before this round: the extractor matched `config` only,
      // and executing instructions independently left `token issue` failing G2
      // in the one state that prints it.
      "keryx serve token issue",
    ]);
    // The count first: a multi-line failure message makes the array diff hard
    // to read, and an undercount is exactly how three of these were missed.
    expect({ count: failures.length, failures }).toEqual({ count: 0, failures: [] });
  }, 60_000);

  test("every CREDENTIAL instruction the CLI prints is executed verbatim too", async () => {
    // The other half of the class. The guard above enumerates configuration
    // states, so the `token rotate` family — printed by the credential checks
    // in `serve-server.ts`, by `token issue`'s refusal, and by the rotate
    // window in `serve.ts` — was never reachable from it and was asserted by
    // `toContain` alone.
    //
    // Same extractor, same sequence execution, different states: an instruction
    // is covered because it was RUN, not because a substring matched.
    if (process.getuid?.() === 0) {
      // The rotate window needs the mode bits to hold; root ignores them.
      return;
    }
    const states: Array<{ label: string; setup: () => Promise<void>; invoke: string[] }> = [
      {
        label: "configured, no credential yet",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
        },
        invoke: ["status"],
      },
      {
        // `config init` itself advises here; `config show` deliberately does
        // not, because it reports the configuration and the credential is not
        // part of it. Enumerating the command that DOES advise, rather than
        // demanding advice from one that should not, is the same distinction
        // the `reports` scope makes in the guard above.
        label: "first-run config init with no credential",
        setup: async () => {},
        invoke: ["config", "init", ...CUSTOM],
      },
      {
        label: "a credential exists and token issue refuses",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
        },
        invoke: ["token", "issue"],
      },
      {
        label: "the two-write rotate window",
        setup: async () => {
          await run(["config", "init", ...CUSTOM]);
          await run(["token", "issue"]);
          chmodSync(serveConfigPath(configDir), 0o400);
          await run(["token", "rotate"]);
          chmodSync(serveConfigPath(configDir), 0o600);
        },
        invoke: [],
      },
    ];

    const failures: string[] = [];
    const executed: string[] = [];
    for (const state of states) {
      rmSync(serveConfigPath(configDir), { force: true });
      rmSync(serveCredentialPath(configDir), { force: true });
      await state.setup();

      const shown = await run(state.invoke);
      const sequence = instructions(shown.out).filter((i) => i.disposition === "runnable");
      if (sequence.length === 0) {
        failures.push(`[${state.label}] \`keryx serve ${state.invoke.join(" ")}\` printed no instruction at all`);
        continue;
      }
      const seen = new Set<string>();
      for (const instruction of sequence) {
        if (seen.has(instruction.command)) {
          continue;
        }
        seen.add(instruction.command);
        executed.push(instruction.command);
        const followed = await run(instruction.argv);
        if (followed.exit !== 0) {
          failures.push(
            `[${state.label}] \`keryx serve ${state.invoke.join(" ")}\` printed \`${instruction.command}\`, which exited ${followed.exit}: ${followed.out.trim()}`,
          );
        }
      }
      // The credential equivalent of G2: following the path must leave a
      // credential the configuration actually points at. Exit 0 from a rotate
      // that re-minted and failed to re-point is the exact defect this whole
      // file was opened for.
      const record = loadServeCredential(configDir);
      const stored = loadServeConfig(configDir);
      if (record === null || stored === null || stored.credentialRef.id !== record.id) {
        failures.push(
          `[${state.label}] following \`${[...seen].join("` then `")}\` left the configuration pointing at ${stored?.credentialRef.id ?? "nothing"} while the store holds ${record?.id ?? "nothing"}`,
        );
      }
    }

    // The `token` family, executed. Asserted by value so this cannot quietly
    // narrow back to whatever happens to be printed.
    expect([...new Set(executed)].sort()).toEqual([
      "keryx serve token issue",
      "keryx serve token rotate",
    ]);
    expect({ count: failures.length, failures }).toEqual({ count: 0, failures: [] });
  }, 60_000);

  test("the listener-start instruction refuses for the reason it prints, rather than being skipped", async () => {
    // The one disposition that is not executed by the loops above, covered here
    // instead of excused in a comment. `keryx serve --acknowledge-non-loopback`
    // is printed only on the refusal path, and it legitimately still refuses
    // when the STORED acknowledgement is the missing half — the flag alone is
    // not enough, by security policy. That refusal is the behaviour, so it is
    // what gets asserted.
    //
    // It cannot start a listener from here even if the check were removed: the
    // bind address is 10.0.0.5, which does not resolve to an interface on the
    // machine running this.
    rmSync(serveConfigPath(configDir), { force: true });
    rmSync(serveCredentialPath(configDir), { force: true });
    await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
    await run(["token", "issue"]);

    const advised = await run([]);
    const printed = instructions(advised.out).filter((i) => i.disposition === "startsAListener");
    expect(printed.map((i) => i.command)).toEqual(["keryx serve --acknowledge-non-loopback"]);

    // Followed verbatim, exactly as extracted.
    const followed = await run(printed[0]!.argv);

    expect(followed.exit).toBe(1);
    expect(followed.out).toContain("reachable beyond loopback");
    // And it says which half is still missing, rather than repeating itself.
    expect(followed.out).toContain("The configuration does not acknowledge a non-loopback bind");
    expect(followed.out).not.toContain("This invocation did not acknowledge a non-loopback bind");
  }, 30_000);

  test("the non-loopback instruction names the CONFIGURED address, not a `<addr>` placeholder", async () => {
    // F-005 of round 4. Both sites printed `--bind <addr>`, and the guard above
    // substituted a real address before executing — so the one instruction in
    // the whole surface that was not copy-pasteable was also the one the guard
    // could not actually prove. Pinned directly here as well as through the
    // `skippedUsageForms` assertion, because that one fails with a diff about
    // an array and this one fails saying what is wrong.
    rmSync(serveConfigPath(configDir), { force: true });
    rmSync(serveCredentialPath(configDir), { force: true });
    await run(["config", "init", "--bind", "10.0.0.5", "--port", "8443", "--profile", "hardened"]);
    await run(["token", "issue"]);

    // Both sites: `runServe`'s refusal and `serve status`'s note.
    for (const invoke of [[], ["status"]]) {
      const shown = await run(invoke);
      expect({ invoke, out: shown.out.includes("<addr>") }).toEqual({ invoke, out: false });
      expect(shown.out).toContain("--bind 10.0.0.5");
    }
  }, 30_000);

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
    // Anchored to the REFUSAL line, not merely to the transcript. A review
    // reverted `serve-server.ts`'s message to the old `config init` form and
    // this test stayed green, because a separate `note()` further down happened
    // to contain the same substring — so it was pinning the wrong line.
    const refusalLine = refused.out
      .split("\n")
      .find((line) => line.includes("reachable beyond loopback") && line.includes("Run "));
    expect(refusalLine).toBeDefined();
    expect(refusalLine!).toContain("keryx serve config set --bind 10.0.0.5 --acknowledge-non-loopback");

    // Followed VERBATIM, extracted from the line rather than retyped. The
    // retyped version could not tell the difference between an instruction that
    // works and one the test happened to write correctly — which is exactly
    // what the `<addr>` placeholder was hiding.
    const printed = /`keryx serve ([^`]+)`/.exec(refusalLine!);
    expect(printed).not.toBeNull();
    const followed = await run(printed![1]!.trim().split(/\s+/));
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
