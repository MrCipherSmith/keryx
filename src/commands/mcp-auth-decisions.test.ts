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
import {
  bothStreamsAreATerminal,
  openAuthorisationUrl,
  resolveInteractive,
  runMcpConsumerCommand,
} from "./mcp-servers";

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

describe("an explicit answer wins over the streams", () => {
  const TTY = { isTTY: true };
  const PIPE = { isTTY: false };

  test("`false` refuses even when both streams ARE terminals", () => {
    // THE case that distinguishes `??` from `||`, and the reason
    // `resolveInteractive` takes its streams as arguments. Under
    // `bun test` neither real stream is a TTY, so the first version of
    // this test — driving the whole command — passed under both
    // spellings and proved nothing about either.
    //
    // Under `||`, an explicit `false` is falsy and falls through to
    // the probe: a caller refusing on purpose gets permission.
    expect(resolveInteractive(false, TTY, TTY)).toBe(false);
  });

  test("`true` allows even when NEITHER stream is", () => {
    expect(resolveInteractive(true, PIPE, PIPE)).toBe(true);
  });

  test("BOUNDARY — with no explicit answer, the streams decide", () => {
    expect(resolveInteractive(undefined, TTY, TTY)).toBe(true);
    expect(resolveInteractive(undefined, TTY, PIPE)).toBe(false);
  });

  test("and the command honours it end to end", async () => {
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

describe("when there is no graphical session, the URL is printed instead", () => {
  // `browserOpenPlan` returns undefined when it cannot open anything,
  // and its contract is that the caller shows the URL. The first
  // version of this code had no way to honour that contract because
  // it had no way to express "I could not open it" — so over SSH the
  // operator got silence and, five minutes later, was told their
  // browser tab was never completed.
  const URL_ = new URL("https://auth.test/authorize?client_id=x");

  test("the operator is given the URL to open themselves", () => {
    const lines: string[] = [];
    openAuthorisationUrl(URL_, (line) => lines.push(line), "linux", {});
    expect(lines.join("\n")).toContain("https://auth.test/authorize?client_id=x");
  });

  test("and told why nothing opened", () => {
    const lines: string[] = [];
    openAuthorisationUrl(URL_, (line) => lines.push(line), "linux", {});
    expect(lines.join("\n")).toContain("No graphical session");
  });

  test("BOUNDARY — with DISPLAY set, it does NOT print the fallback", () => {
    // Without this, "always print" would pass the two tests above and
    // the browser would never open for anybody.
    const lines: string[] = [];
    // darwin needs no DISPLAY and always has an opener, so it is the
    // cleanest way to exercise the other branch without spawning.
    openAuthorisationUrl(URL_, (line) => lines.push(line), "darwin", {});
    expect(lines.join("\n")).not.toContain("No graphical session");
  });

  test("and a Wayland session counts as graphical too", () => {
    const lines: string[] = [];
    openAuthorisationUrl(URL_, (line) => lines.push(line), "linux", { WAYLAND_DISPLAY: "wayland-0" });
    expect(lines.join("\n")).not.toContain("No graphical session");
  });
});
