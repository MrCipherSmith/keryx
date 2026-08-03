// Terminal-escape containment across every output path of `keryx serve`
// (flow 128).
//
// Same formulation as projects.escape.test.ts, and for the same reason: a guard
// that only exercises library functions catches a sanitizer removed from the
// library and misses every one removed from a command. So these drive the
// COMMAND with stdout and stderr captured, and assert the combined output
// carries no control character.
//
// `keryx serve` echoes operator-supplied argv (bind address, profile name,
// subcommand, flags) and filesystem-derived registry values, so every one of
// those is a route by which a crafted string reaches a terminal.
//
// Two shapes are tested, and they are different properties: a path that ECHOES
// the input must sanitize it (asserted with a surviving remnant, so the test
// fails if the echo disappears), and a path that does NOT echo it must be
// pinned as not echoing it (asserting "no control characters" on a fixed string
// is a tautology, which is what three of these tests used to be).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { serveCommand } from "./serve";
import { serveConfigPath } from "../lib/serve-config";
import { sanitizeForDisplay } from "../lib/project-registry";

const ESC = "";
const BEL = "";
/** An OSC title-set plus a screen clear — the shapes that rewrite a terminal. */
const HOSTILE = `${ESC}]0;PWNED${BEL}${ESC}[2J`;
/**
 * What `sanitizeForDisplay` leaves of {@link HOSTILE}.
 *
 * It strips the CONTROL BYTES (ESC 0x1b, BEL 0x07) and leaves the printable
 * remainder, which is the right behaviour — a terminal renders `]0;PWNED[2J`
 * as ordinary text and does nothing with it. The remnant assertions below use
 * this exact string so they pin that the echo still happens AND that only the
 * dangerous bytes were removed; asserting on the input, or on a contiguous
 * `subcmd`, would be asserting a sanitizer this codebase does not have.
 */
const SANITIZED = "]0;PWNED[2J";

let xdgRoot = "";
let configDir = "";
let captured: string[] = [];
let originalLog: typeof console.log;
let originalError: typeof console.error;
let originalXdg: string | undefined;
let originalAppData: string | undefined;

function controlCharacters(text: string): string[] {
  return [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

/** Everything written to stdout+stderr, minus the newlines writers legitimately emit. */
function offendingCharacters(): string[] {
  return controlCharacters(captured.join("\n").replace(/\n/g, ""));
}

beforeEach(() => {
  xdgRoot = mkdtempSync(path.join(tmpdir(), "keryx-serve-escape-"));
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

describe("no command output carries terminal control characters", () => {
  test("an unknown subcommand echoing hostile argv", async () => {
    await serveCommand([`sub${HOSTILE}cmd`]);
    // The remnant pins that the echo still HAPPENS. Without it the test passes
    // if the message stops quoting argv at all, proving nothing about the
    // sanitizer it exists for.
    expect(captured.join("")).toContain(`sub${SANITIZED}cmd`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("an unknown option echoing hostile argv", async () => {
    await serveCommand(["status", `--opt${HOSTILE}x`]);
    expect(captured.join("")).toContain(`--opt${SANITIZED}x`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("an unknown token subcommand echoing hostile argv", async () => {
    await serveCommand(["token", `pr${HOSTILE}int`]);
    expect(captured.join("")).toContain(`pr${SANITIZED}int`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("an unknown config subcommand echoing hostile argv", async () => {
    await serveCommand(["config", `sh${HOSTILE}ow`]);
    expect(captured.join("")).toContain(`sh${SANITIZED}ow`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("config init rejecting a hostile port value echoes NOTHING of it", async () => {
    // Renamed and re-scoped after a review found it tautological: `readPort`
    // fails the digits check and `fail()` prints a fixed message, so the hostile
    // value never reaches the output at all. Asserting "no control characters"
    // on a fixed literal proves nothing; asserting the value is ABSENT is the
    // real property, and it fails if a future edit starts echoing the input.
    await serveCommand(["config", "init", "--port", `12${HOSTILE}34`]);
    expect(captured.join("")).toContain("--port must be an integer");
    expect(captured.join("")).not.toContain("12");
    expect(offendingCharacters()).toEqual([]);
  });

  test("config init accepting a hostile profile name, then showing it", async () => {
    await serveCommand(["config", "init", "--profile", `prof${HOSTILE}ile`]);
    captured = [];
    await serveCommand(["config", "show"]);
    // The stripped profile VALUE, not the word "profile:" from the label — the
    // label alone would be there whatever happened to the value.
    expect(captured.join("")).toContain(`profile:    prof${SANITIZED}ile`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("status rendering a hostile bind address", async () => {
    await serveCommand(["config", "init", "--bind", `10.0.0.1${HOSTILE}`]);
    captured = [];
    await serveCommand(["status"]);
    expect(captured.join("")).toContain(`10.0.0.1${SANITIZED}`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("the startup refusal echoes NOTHING of a hostile bind address", async () => {
    // Also renamed after review: the non-loopback and no-credential refusals are
    // fixed strings that never quote the address. That is the property worth
    // pinning — the message that DOES quote it is the bind-failure one below,
    // and it is tested separately with a remnant assertion.
    await serveCommand(["config", "init", "--bind", `evil${HOSTILE}host`]);
    captured = [];
    await serveCommand([]);
    expect(captured.join("")).toContain("keryx serve token issue");
    expect(captured.join("")).not.toContain("evil");
    expect(offendingCharacters()).toEqual([]);
  });

  test("the damaged-serve.json warning quotes no byte of the file", async () => {
    // The message is fixed and the file's bytes never enter it. Pinning the
    // absence is the honest assertion; the previous version asserted that a
    // constant string contains no control characters.
    mkdirSync(path.dirname(serveConfigPath(configDir)), { recursive: true });
    writeFileSync(serveConfigPath(configDir), `{not json ${HOSTILE} MARKER-FROM-THE-FILE`, "utf8");
    await serveCommand(["status"]);
    expect(captured.join("")).toContain("not configured");
    expect(captured.join("")).not.toContain("MARKER-FROM-THE-FILE");
    expect(offendingCharacters()).toEqual([]);
  });

  test("an unexpected positional argument echoing hostile argv", async () => {
    await serveCommand(["status", `posi${HOSTILE}tional`]);
    expect(captured.join("")).toContain(`Unexpected argument: posi${SANITIZED}tional`);
    expect(offendingCharacters()).toEqual([]);
  });

  test("the bind-failure message, which embeds the hostile hostname", async () => {
    // Reached only with BOTH acknowledgement halves: the address is not
    // loopback, so without them the run refuses earlier and never gets as far
    // as a bind whose error message quotes the host.
    // `--port 0` on the RUN, so that even if a future Bun tolerated this
    // hostname the fixture could not open a listener on the fixed default port
    // 7377 and then block on the signal promise.
    await serveCommand(["config", "init", "--bind", `evil${HOSTILE}host`, "--acknowledge-non-loopback"]);
    await serveCommand(["token", "issue"]);
    captured = [];

    await serveCommand(["--acknowledge-non-loopback", "--port", "0"]);
    expect(captured.join("")).toContain("could not bind");
    expect(offendingCharacters()).toEqual([]);
  });

  test("the warning for an undeclared field with a hostile name", async () => {
    await serveCommand(["config", "init"]);
    const raw = JSON.parse(
      await Bun.file(serveConfigPath(configDir)).text(),
    ) as Record<string, unknown>;
    raw[`field${HOSTILE}x`] = "value";
    writeFileSync(serveConfigPath(configDir), JSON.stringify(raw), "utf8");
    captured = [];

    await serveCommand(["status"]);
    expect(captured.join("")).toContain("undeclared");
    expect(offendingCharacters()).toEqual([]);
  });
});

describe("newline injection", () => {
  test("a newline in argv cannot forge a second output line", () => {
    // `offendingCharacters` strips every \n before inspecting, because writers
    // legitimately emit them — which makes this file blind to the log-spoofing
    // vector unless it is asserted separately. `sanitizeForDisplay` strips \n
    // (it is 0x0A, inside the C0 range), so the two halves must fuse.
    expect(sanitizeForDisplay("sub\nFAKE")).toBe("subFAKE");
    expect(sanitizeForDisplay("a\r\nb")).toBe("ab");
  });

  test("an unknown subcommand carrying a newline produces no extra line", async () => {
    await serveCommand(["sub\n  ✓ FORGED SUCCESS LINE"]);
    const lines = captured.join("\n").split("\n");
    expect(lines.some((line) => line.trim() === "✓ FORGED SUCCESS LINE")).toBe(false);
    expect(captured.join("")).toContain("FORGED SUCCESS LINE");
  });
});

describe("the JSON projection stays machine-readable", () => {
  test("a hostile field name is escaped, not emitted raw and not silently stripped", async () => {
    // Same rule as the R4a projection: JSON escapes control characters rather
    // than stripping them, so a machine consumer gets valid JSON and the value
    // intact. Only the human path strips, because a terminal does not escape.
    await serveCommand(["config", "init"]);
    const raw = JSON.parse(await Bun.file(serveConfigPath(configDir)).text()) as Record<string, unknown>;
    raw[`field${HOSTILE}x`] = "value";
    writeFileSync(serveConfigPath(configDir), JSON.stringify(raw), "utf8");
    captured = [];

    await serveCommand(["status", "--json"]);
    const payload = captured.join("\n");
    expect(() => JSON.parse(payload)).not.toThrow();
    const report = JSON.parse(payload) as { warnings: string[] };
    expect(report.warnings.join(" ")).toContain("undeclared");
    expect(payload).not.toContain(ESC);
  });
});

describe("the guard itself can fail", () => {
  test("controlCharacters detects what it claims to", () => {
    expect(controlCharacters(`a${ESC}b`)).toEqual([ESC]);
    expect(controlCharacters(`a${BEL}b`)).toEqual([BEL]);
    expect(controlCharacters("Profile-42_ABC")).toEqual([]);
  });

  test("captured command output is actually inspected", () => {
    console.log(`x${ESC}y`);
    expect(offendingCharacters()).toEqual([ESC]);
  });
});
