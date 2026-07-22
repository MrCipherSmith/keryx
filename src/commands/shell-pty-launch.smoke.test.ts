// Open item O-6 — the real shell, launched on a REAL pseudo-terminal.
//
// Every other check that touches the TUI runs without a controlling terminal, so
// `createCliRenderer` declines and `keryx shell` takes the readline path. The
// block model, chrome, nav mode and rendering are all proven headlessly through
// the optional TUI package's `createTestRenderer` — but nothing proved that the
// SHIPPED shell launches and draws on a terminal that actually exists.
//
// That gap is not academic. Flow 065 reverted the TUI out of the default because
// of a stdin-handoff bug that leaked terminal query responses ONLY on a real
// TTY — precisely the class a headless renderer cannot see. It took flows 066
// and 067 to fix. A launch smoke would have caught it on the first run.
//
// So this suite allocates a pty with `script(1)`, runs `bun src/cli.ts shell`
// inside it, and asserts on the bytes the process emitted to that terminal: that
// it entered the alternate screen, that recognisable chrome was DRAWN into it,
// that mouse tracking was enabled, and that the screen was restored on a clean
// exit. The drawn text is what evidences a rendered frame; the escape sequences
// alone would only evidence a renderer having been constructed.
//
// GATING, and why this is not in the default `bun test` run:
//   * `script(1)`'s command syntax differs between macOS (BSD, `script -q <file>
//     <cmd>…`) and Linux (util-linux, `script -q -c "<cmd>" <file>`). Only the
//     BSD form is exercised here — see O-6 in
//     `docs/requirements/keryx-opentui-shell/specification.md`. Shipping an
//     unexercised Linux branch would repeat the vacuous-evidence mistake this
//     suite exists to correct, so the gate is `darwin` + `/usr/bin/script`.
//   * It spawns real processes, so it follows this repository's existing
//     convention for those (`KERYX_ALLOW_REAL_SUBPROCESS=1`, as in
//     `harness-exec.smoke.test.ts`). CI runs it in a dedicated macOS job.
//   * The gate is `describe.skipIf` — never an early `return`, which bun counts
//     as a pass. A skipped run is visible in the reporter's skip count.
//
// It must also live OUTSIDE `src/tui/`: `scripts/opentui-tests-no-skips.ts`
// fails that directory's CI legs if anything there skips, and this suite skips
// by design on Linux.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { uniqueTestRoot } from "../lib/test-tmp";

const REAL_SUBPROCESS_FLAG = process.env.KERYX_ALLOW_REAL_SUBPROCESS === "1";
/** BSD `script`. The util-linux spelling takes `-c "<cmd>" <file>` instead. */
const BSD_SCRIPT = "/usr/bin/script";
const PTY_AVAILABLE = process.platform === "darwin" && existsSync(BSD_SCRIPT);

const CLI = path.join(import.meta.dir, "..", "cli.ts");

/** DECSET 1049 — enter the alternate screen buffer. */
const ALT_ENTER = "\u001b[?1049h";
/** DECRST 1049 — leave it, restoring the user's scrollback. */
const ALT_EXIT = "\u001b[?1049l";
/** SGR-encoded mouse reporting (`useMouse: true` in `createShellRenderer`). */
const MOUSE_SGR_ON = "\u001b[?1006h";
/** Printed by the readline shell's header — the fallback path's own readiness. */
const READLINE_READY = "/exit to quit";
/** Chrome the TUI draws and the readline shell never does. */
const TUI_ONLY_LABELS = ["Model", "Context", "Tools", "Status", "Ready"] as const;
const BOX_DRAWING = /[─│┌┐└┘├┤┬┴┼╭╮╯╰]/;

/**
 * How long to wait for the readiness marker before quitting anyway.
 *
 * Deliberately far above the ~0.8 s a first frame actually takes: with `-F` the
 * transcript is flushed on every write, so this ceiling is only ever paid by a
 * run that is already failing. Buying a fast red at the cost of a deadline a
 * slow runner could trip would trade a loud failure for a flaky one.
 */
const READY_WAIT_MS = 45_000;
/** Wall-clock ceiling for one pty run, enforced by the spawn itself. */
const HARD_TIMEOUT_MS = 120_000;
/** Per-test ceiling, above the hard timeout so the spawn's own bound fires first. */
const TEST_TIMEOUT_MS = 180_000;
/** The inner shell prints the shell's real exit status through the pty. */
const SENTINEL = "KERYX_PTY_CHILD_EXIT";

interface PtyRun {
  /** Everything the process wrote to the terminal, escape sequences included. */
  raw: string;
  /** `raw` with escape sequences removed — what a human would have seen. */
  text: string;
  /** `keryx shell`'s own exit status, read off the pty, not `script`'s. */
  childExit: number | undefined;
  /** True when the readiness marker appeared before the deadline. */
  ready: boolean;
  /** True when the hard timeout had to SIGKILL the run. */
  killed: boolean;
  stderr: string;
}

/** Single-quote for `sh -c`. */
function shq(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Strip the escape sequences so what remains is the text that was drawn.
 *
 * Order matters: OSC and DCS strings go first, because their payloads can carry
 * bytes that the CSI pattern would otherwise chew into.
 */
function visibleText(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b[P^_X][^\u001b]*\u001b\\/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[()][A-B0-2]/g, "")
    .replace(/\u001b[=>78MD]/g, "")
    .replace(/\u0000/g, "");
}

/**
 * Run `keryx shell` inside a pty and return what it painted.
 *
 * WHY A SHELL PIPELINE rather than `Bun.spawn(..., { stdin: "pipe" })`: BSD
 * `script` calls `tcgetattr` on its own stdin and aborts unless the error is
 * `ENOTTY`. Bun's `"pipe"` is a socketpair, which fails with `ENOTSUP` instead —
 * `script: tcgetattr/ioctl: Operation not supported on socket`, no pty at all.
 * Passing a FIFO's file descriptor does not help; Bun routes it through a socket
 * too. A pipe created by `sh` itself is an ordinary pipe, so `script` proceeds.
 *
 * Which means the quit key cannot be written from here on demand — so the inner
 * pipeline waits for this process to create a `go` file, then sends Ctrl+C
 * (the renderer is built with `exitOnCtrlC`) and holds stdin open briefly before
 * closing it, because EOF is what ends the readline shell if the TUI never
 * started. Both quit paths are covered without knowing which one ran.
 *
 * Bounding, in layers, because a smoke that hangs is worse than no smoke:
 *   1. the readiness poll gives up after {@link READY_WAIT_MS} and proceeds to
 *      quit anyway, so a shell that never draws still terminates;
 *   2. the inner driver loop is itself bounded (it stops waiting for `go`);
 *   3. a watchdog inside the outer shell SIGKILLs `script` and its children;
 *   4. `Bun.spawn`'s `timeout` SIGKILLs the outer shell at
 *      {@link HARD_TIMEOUT_MS}, and `killed` carries that out so the caller
 *      fails loudly instead of silently asserting on an empty capture.
 */
async function runPtyShell(opts: { args: string[]; readyMarker: string }): Promise<PtyRun> {
  const root = uniqueTestRoot(tmpdir(), "keryx-pty-launch");
  const home = path.join(root, "home");
  const cwd = path.join(root, "cwd");
  const capture = path.join(root, "pty.raw");
  const go = path.join(root, "go");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  try {
    // BSD form: `script -q -F <transcript> <command> [args…]`. `script` allocates
    // the pty, makes it the child's controlling terminal, and mirrors every byte
    // the child writes into <transcript>. The inner `sh` reports the shell's own
    // exit status through the pty, since `script`'s exit status is its own.
    //
    // `-F` (flush after every write) is not cosmetic: BSD `script` flushes the
    // transcript to disk every 30 SECONDS by default, so the readiness poll
    // below would sit blind for half a minute on any output small enough to fit
    // in the buffer. Without it the readline control took 34s instead of 5s, and
    // any shorter readiness deadline would have failed on flush latency rather
    // than on anything about the shell.
    const inner =
      `${shq(process.execPath)} ${shq(CLI)} ${opts.args.map(shq).join(" ")}; ` +
      `printf '\\n${SENTINEL}=%s\\n' "$?"`;
    const driver = [
      "i=0",
      `while [ ! -f ${shq(go)} ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i+1)); done`,
      `printf '\\003'`, // Ctrl+C
      "sleep 3", // hold stdin open so the key is delivered, then EOF on exit
    ].join("; ");
    const outer = [
      `{ ${driver}; } | ${shq(BSD_SCRIPT)} -q -F ${shq(capture)} /bin/sh -c ${shq(inner)} &`,
      "SPID=$!",
      "i=0",
      "while kill -0 $SPID 2>/dev/null && [ $i -lt 1000 ]; do sleep 0.1; i=$((i+1)); done",
      "if kill -0 $SPID 2>/dev/null; then pkill -9 -P $SPID 2>/dev/null; kill -9 $SPID 2>/dev/null; fi",
      "wait $SPID",
    ].join("\n");

    const proc = Bun.spawn(["/bin/sh", "-c", outer], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: HARD_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        // `shell-config.ts` prefers XDG_DATA_HOME over $HOME; pin both so a
        // launch can never read or write the developer's real `auth.json`.
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        TERM: "xterm-256color",
      },
    });
    // Drain stderr concurrently: an undrained pipe can block the child.
    const stderrPromise = new Response(proc.stderr).text();

    const readCapture = (): string => {
      try {
        // utf8, not latin1: the chrome's borders are multi-byte box-drawing
        // characters and the drawn-frame assertion looks for them.
        return readFileSync(capture, "utf8");
      } catch {
        return "";
      }
    };

    let ready = false;
    const deadline = Date.now() + READY_WAIT_MS;
    while (Date.now() < deadline) {
      if (readCapture().includes(opts.readyMarker)) {
        ready = true;
        break;
      }
      if (proc.exitCode !== null || proc.signalCode !== null) {
        break; // it already left; stop waiting for output that is not coming
      }
      await Bun.sleep(100);
    }
    // Let the first paint finish before asking it to leave, so the transcript
    // holds a whole frame rather than half of one.
    await Bun.sleep(750);
    writeFileSync(go, "");

    await proc.exited;
    const stderr = await stderrPromise;
    const raw = readCapture();
    const text = visibleText(raw);
    const sentinel = new RegExp(`${SENTINEL}=(\\d+)`).exec(text)?.[1];
    return {
      raw,
      text,
      childExit: sentinel === undefined ? undefined : Number.parseInt(sentinel, 10),
      ready,
      killed: proc.signalCode === "SIGKILL",
      stderr,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Always runs, on every platform, and is never skipped.
 *
 * The escape sequences this suite asserts on are only meaningful while the
 * shipped renderer still asks for the alternate screen and mouse tracking. If
 * `createShellRenderer`'s options change, the pty assertions would go quietly
 * vacuous rather than fail — so pin the coupling here, where no gate can skip
 * it, and point the next reader at the constants that would need updating.
 */
test("the pty assertions stay coupled to the renderer's real options", () => {
  const chrome = readFileSync(path.join(import.meta.dir, "..", "tui", "shell-chrome.ts"), "utf8");
  expect(chrome).toContain(`screenMode: "alternate-screen"`);
  expect(chrome).toContain("useMouse: true");
});

describe.skipIf(!REAL_SUBPROCESS_FLAG || !PTY_AVAILABLE)(
  "keryx shell on an allocated pty (macOS; KERYX_ALLOW_REAL_SUBPROCESS=1)",
  () => {
    test(
      "the real shell launches, draws a frame into the alternate screen, and exits cleanly",
      async () => {
        const run = await runPtyShell({
          args: ["shell", "--provider", "fake", "--model", "fake-echo"],
          readyMarker: ALT_ENTER,
        });

        // A pty was actually allocated. This is the exact way the harness broke
        // while it was being written, and "no pty" otherwise reads as an empty
        // capture with a confusing downstream failure.
        expect(run.stderr).not.toContain("tcgetattr");
        // It terminated on its own, inside the bound. SIGKILL means the hard
        // timeout fired, which must fail here rather than further down.
        expect({ killed: run.killed, ready: run.ready }).toEqual({ killed: false, ready: true });

        // 1. The renderer really started: it took the alternate screen…
        expect(run.raw).toContain(ALT_ENTER);
        // 2. …with the options the shipped code asks for (mouse tracking on).
        expect(run.raw).toContain(MOUSE_SGR_ON);
        // 3. A frame was DRAWN. This is what the escape sequences alone do not
        //    prove, and what O-6 is actually about: the sidebar's labels are
        //    each written as one text run, so they survive whatever window size
        //    the pty ended up with.
        for (const label of TUI_ONLY_LABELS) {
          expect(run.text).toContain(label);
        }
        expect(run.text).toContain("keryx");
        // 4. Borders: the chrome laid out, not merely a bare renderer.
        expect(BOX_DRAWING.test(run.text)).toBe(true);
        // 5. It gave the terminal back, and the shell itself exited 0.
        expect(run.raw).toContain(ALT_EXIT);
        expect(run.childExit).toBe(0);
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the same harness on the same kind of pty sees no TUI at all when it is off",
      async () => {
        // The discriminator. Without it, everything above could be passing on
        // something other than the TUI — bytes emitted by `script`, by the
        // harness, or inherited from the outer terminal. `--no-tui` runs the
        // readline shell through the identical pipeline: if the alternate
        // screen and the chrome still showed up, the test above would be
        // proving nothing at all.
        const run = await runPtyShell({
          args: ["shell", "--no-tui", "--provider", "fake", "--model", "fake-echo"],
          readyMarker: READLINE_READY,
        });

        expect({ killed: run.killed, ready: run.ready }).toEqual({ killed: false, ready: true });
        expect(run.raw).not.toContain(ALT_ENTER);
        expect(run.raw).not.toContain(MOUSE_SGR_ON);
        expect(BOX_DRAWING.test(run.text)).toBe(false);
        for (const label of TUI_ONLY_LABELS) {
          expect(run.text).not.toContain(label);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
