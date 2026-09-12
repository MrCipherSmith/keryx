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
import type { openVerificationUrl } from "../lib/oauth/open-url";
import {
  bothStreamsAreATerminal,
  openAuthorisationUrl,
  resolveInteractive,
  runMcpConsumerCommand,
} from "./mcp-servers";

type OpenCall = {
  readonly url: string;
  readonly platform: NodeJS.Platform | undefined;
  readonly env: NodeJS.ProcessEnv | undefined;
};

/**
 * An opener that records instead of spawning.
 *
 * Every test below passes one. A test that leaves the opener out gets
 * the real `openVerificationUrl`, which spawns a real browser on the
 * machine running the tests — which is exactly what this file used to
 * do twice per run.
 */
function recordingOpener(): { readonly calls: OpenCall[]; readonly open: typeof openVerificationUrl } {
  const calls: OpenCall[] = [];
  return {
    calls,
    open: (url, deps = {}) => {
      calls.push({ url, platform: deps.platform, env: deps.env });
    },
  };
}

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
    const opener = recordingOpener();
    openAuthorisationUrl(URL_, (line) => lines.push(line), "linux", {}, opener.open);
    expect(lines.join("\n")).toContain("https://auth.test/authorize?client_id=x");
  });

  test("and told why nothing opened", () => {
    const lines: string[] = [];
    const opener = recordingOpener();
    openAuthorisationUrl(URL_, (line) => lines.push(line), "linux", {}, opener.open);
    expect(lines.join("\n")).toContain("No graphical session");
  });

  test("BOUNDARY — with DISPLAY set, it does NOT print the fallback", () => {
    // Without this, "always print" would pass the two tests above and
    // the browser would never open for anybody.
    const lines: string[] = [];
    const opener = recordingOpener();
    // darwin needs no DISPLAY and always has an opener, so it is the
    // cleanest way to exercise the other branch without spawning.
    openAuthorisationUrl(URL_, (line) => lines.push(line), "darwin", {}, opener.open);
    expect(lines.join("\n")).not.toContain("No graphical session");
  });

  test("and a Wayland session counts as graphical too", () => {
    const lines: string[] = [];
    const opener = recordingOpener();
    openAuthorisationUrl(
      URL_,
      (line) => lines.push(line),
      "linux",
      { WAYLAND_DISPLAY: "wayland-0" },
      opener.open,
    );
    expect(lines.join("\n")).not.toContain("No graphical session");
  });
});

describe("REGRESSION — the opener is injected, and is given the substituted platform and env", () => {
  // The first version of this function was injected halfway: the
  // DECISION used the substituted platform/env, and the OPEN used the
  // real `process.platform`, `process.env` and `spawn`. So the two
  // tests above that name a graphical session spawned a real browser on
  // the machine running them — `open https://auth.test/…` twice per run
  // on macOS, `xdg-open` on a Linux desktop — against a host that RFC
  // 6761 guarantees will never resolve. Two tabs, every run, forever.
  //
  // Asserting only "the opener was called" would not have caught it:
  // the broken code called an opener too, just not the injected one and
  // not with these values. What pins it is the deps the opener RECEIVES.
  const URL_ = new URL("https://auth.test/authorize?client_id=x");

  type Row = {
    readonly label: string;
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly opens: boolean;
  };

  const ROWS: Row[] = [
    { label: "macOS always has an opener", platform: "darwin", env: {}, opens: true },
    { label: "Windows always has an opener", platform: "win32", env: {}, opens: true },
    { label: "Linux with X11", platform: "linux", env: { DISPLAY: ":0" }, opens: true },
    { label: "Linux with Wayland", platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, opens: true },
    { label: "Linux headless", platform: "linux", env: {}, opens: false },
    { label: "Linux with an empty DISPLAY", platform: "linux", env: { DISPLAY: "" }, opens: false },
  ];

  for (const row of ROWS) {
    test(`${row.label} — ${row.opens ? "opens through the injected opener" : "never touches the opener"}`, () => {
      const opener = recordingOpener();
      openAuthorisationUrl(URL_, () => {}, row.platform, row.env, opener.open);
      if (!row.opens) {
        // The plan === undefined branch prints the URL. If it ever
        // reached an opener at all, the real one would be next.
        expect(opener.calls).toEqual([]);
        return;
      }
      expect(opener.calls).toEqual([
        { url: "https://auth.test/authorize?client_id=x", platform: row.platform, env: row.env },
      ]);
    });
  }

  test("the env reaching the opener is the SAME object that decided the plan", () => {
    // `platform`/`env` arriving as `undefined` is the signature of the
    // old bug: the opener then falls back to the real process values
    // and decides for itself, on the developer's machine.
    const env: NodeJS.ProcessEnv = { DISPLAY: ":0" };
    const opener = recordingOpener();
    openAuthorisationUrl(URL_, () => {}, "linux", env, opener.open);
    expect(opener.calls).toHaveLength(1);
    expect(opener.calls[0]?.env).toBe(env);
    expect(opener.calls[0]?.platform).toBe("linux");
  });
});
