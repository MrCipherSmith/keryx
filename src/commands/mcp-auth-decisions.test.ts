// The two decisions in `keryx mcp auth` that no test could reach.
//
// Both were inline expressions, and a mutation sweep is what showed
// they were unconstrained: three mutations of the TTY check and two of
// the browser command survived a full run. The TTY check because every
// test supplies `interactive` explicitly, so its fallback executed
// zero times; the browser command because a platform ternary runs one
// of its three branches on the machine doing the testing, and the
// other two ship having never executed.
//
// Extracting them is not tidying. It is the difference between a line
// that is asserted and a line that is hoped for.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { bothStreamsAreATerminal, browserCommand, runMcpConsumerCommand } from "./mcp-servers";

type TtyRow = {
  readonly label: string;
  readonly stdin: boolean | undefined;
  readonly stdout: boolean | undefined;
  readonly outcome: "ask the human" | "refuse";
};

const TTY_TABLE: TtyRow[] = [
  {
    label: "both ends a terminal — there is somebody to ask",
    stdin: true,
    stdout: true,
    outcome: "ask the human",
  },
  {
    label: "output redirected to a file is a SCRIPT, whatever the input says",
    // `keryx mcp auth linear > log.txt` from a terminal. A script must
    // not be sent to a browser: nobody is watching the tab.
    stdin: true,
    stdout: false,
    outcome: "refuse",
  },
  {
    label: "input from a pipe is not a human either",
    stdin: false,
    stdout: true,
    outcome: "refuse",
  },
  {
    label: "neither — CI, cron, a container",
    stdin: false,
    stdout: false,
    outcome: "refuse",
  },
  {
    label: "BOUNDARY — undefined is not true; an unknown stream is not a terminal",
    // Node leaves `isTTY` undefined rather than false for a stream that
    // is not a TTY, and `undefined === true` is the only test that gets
    // that right by accident.
    stdin: undefined,
    stdout: undefined,
    outcome: "refuse",
  },
];

describe("is there a human at both ends", () => {
  for (const row of TTY_TABLE) {
    test(row.label, () => {
      const answer = bothStreamsAreATerminal({ isTTY: row.stdin }, { isTTY: row.stdout });
      expect({ label: row.label, outcome: answer ? "ask the human" : "refuse" }).toEqual({
        label: row.label,
        outcome: row.outcome,
      });
    });
  }
});

describe("the platform's browser command", () => {
  test("macOS uses open", () => {
    expect(browserCommand("darwin", "https://a.test/x")).toEqual(["open", "https://a.test/x"]);
  });

  test("Linux uses xdg-open", () => {
    expect(browserCommand("linux", "https://a.test/x")).toEqual(["xdg-open", "https://a.test/x"]);
  });

  test("Windows uses start, WITH the empty title argument", () => {
    // The empty string is not padding. `start "https://…"` treats a
    // quoted first argument as the window title and opens nothing.
    expect(browserCommand("win32", "https://a.test/x")).toEqual([
      "cmd",
      "/c",
      "start",
      "",
      "https://a.test/x",
    ]);
  });

  test("BOUNDARY — an unrecognised platform falls back to xdg-open", () => {
    // The default is a default, not a third named case: every other
    // Unix has xdg-open or nothing, and nothing is what a crash gives.
    expect(browserCommand("freebsd", "https://a.test/x")).toEqual(["xdg-open", "https://a.test/x"]);
  });

  test("the url is passed whole, not re-parsed or truncated", () => {
    const url = "https://auth.test/authorize?client_id=x&state=y&code_challenge=z";
    expect(browserCommand("linux", url)).toEqual(["xdg-open", url]);
  });
});

describe("an explicit `interactive: false` is not overridden by a real terminal", () => {
  test("it refuses even when both streams ARE terminals", async () => {
    // The `??` here must not become `||`. With `||`, an explicit
    // `false` is falsy and falls through to the TTY probe — an
    // explicit refusal silently becoming permission, which is the
    // whole gate inverted for any caller that passes false on purpose.
    const base = mkdtempSync(path.join(tmpdir(), "keryx-explicit-"));
    const configDir = path.join(base, "config");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "mcp-servers.json"),
      JSON.stringify({ schemaVersion: 1, servers: { linear: { url: "https://mcp.linear.app/mcp" } } }),
    );
    const opened: URL[] = [];
    const err: string[] = [];
    const code = await runMcpConsumerCommand("auth", ["linear"], {
      cwd: base,
      configDir,
      projectRoot: base,
      home: path.join(base, "home"),
      interactive: false,
      openBrowser: (url) => { opened.push(url); },
      log: () => {},
      err: (line) => err.push(line),
    });
    expect(code).toBe(1);
    expect(opened).toEqual([]);
    expect(err.join("\n")).toContain("no terminal");
  });
});
