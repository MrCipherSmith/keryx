// `keryx shell --debug` event log.
//
// One NDJSON file per debug run under `<keryx config dir>/debug/<run>/`. Every
// event is appended synchronously: the log exists to explain a shell that has
// stopped responding, so a buffered writer that flushes "later" would lose the
// exact records that matter. With no debug run active every call is a no-op, so
// call sites stay unconditional and cost nothing in a normal session.
//
// The log never records what the user typed. Printable input is reduced to a
// count; only control/escape sequences (which carry no secrets) keep their bytes.

import { appendOwnerOnlyLine, ensureKeryxSubdir, writeOwnerOnlyFile } from "../lib/config-dir";
import path from "node:path";

export interface DebugRun {
  /** Directory holding every file of this run. */
  readonly dir: string;
  /** The shell process's own event log. */
  readonly shellLog: string;
  /** The watcher process's log (written by the watcher, not by the shell). */
  readonly watcherLog: string;
}

let activeRun: DebugRun | undefined;
let seq = 0;

/** True while a `--debug` run is recording. */
export function isDebugEnabled(): boolean {
  return activeRun !== undefined;
}

/** The active run, if any. */
export function currentDebugRun(): DebugRun | undefined {
  return activeRun;
}

/**
 * Append one event. Never throws: a full disk or a vanished directory must not
 * take the shell down with it — the shell working matters more than its log.
 */
export function debugEvent(kind: string, data: Record<string, unknown> = {}): void {
  const run = activeRun;
  if (run === undefined) {
    return;
  }
  seq += 1;
  try {
    appendOwnerOnlyLine(run.shellLog, safeStringify({ ts: new Date().toISOString(), seq, pid: process.pid, kind, ...data }));
  } catch {
    // best-effort
  }
}

/** Like `debugEvent`, plus the caller's stack — for "who called this?" questions. */
export function debugEventWithStack(kind: string, data: Record<string, unknown> = {}): void {
  if (activeRun === undefined) {
    return;
  }
  debugEvent(kind, { ...data, stack: callerStack() });
}

/** Stack of the code that called into the instrumented function (debug frames dropped). */
export function callerStack(): string {
  const raw = new Error("stack").stack ?? "";
  return raw
    .split("\n")
    .slice(1)
    .filter((line) => !line.includes("debug-log.ts"))
    .slice(0, 14)
    .map((line) => line.trim())
    .join(" | ");
}

/**
 * Start recording. Creates `<config dir>/debug/<timestamp>-<pid>/` and points
 * `<config dir>/debug/latest.txt` at it so the newest run is findable without
 * listing directories.
 */
export function startDebugRun(opts: { configDir?: string; now?: Date } = {}): DebugRun {
  const stamp = (opts.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}-${process.pid}`;
  const dir = ensureKeryxSubdir(["debug", name], opts.configDir);
  const run: DebugRun = {
    dir,
    shellLog: path.join(dir, "shell.ndjson"),
    watcherLog: path.join(dir, "watcher.ndjson"),
  };
  try {
    writeOwnerOnlyFile(path.join(path.dirname(dir), "latest.txt"), `${dir}\n`);
  } catch {
    // best-effort pointer
  }
  activeRun = run;
  seq = 0;
  return run;
}

/** Stop recording (tests, and shell teardown). */
export function stopDebugRun(): void {
  activeRun = undefined;
}

/**
 * Describe a chunk of terminal input without recording what was typed:
 * printable characters are only counted, escape/control sequences keep their
 * bytes (hex) because those are what tell a mouse report from a paste marker
 * from a focus event.
 */
export function summarizeInputChunk(chunk: Buffer | string): Record<string, unknown> {
  const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
  const text = buf.toString("utf8");
  let printable = 0;
  let control = 0;
  const sequences: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    const code = ch.charCodeAt(0);
    if (ch === "\x1b") {
      // Take the escape sequence up to its final byte (or the chunk end).
      let j = i + 1;
      while (j < text.length && j - i < 48) {
        const c = text.charCodeAt(j);
        if (j > i + 1 && c >= 0x40 && c <= 0x7e && text[j] !== "[" && text[j] !== "<" && text[j] !== ";") {
          break;
        }
        j++;
      }
      if (sequences.length < 12) {
        sequences.push(Buffer.from(text.slice(i, j + 1)).toString("hex"));
      }
      control++;
      i = j;
    } else if (code < 0x20 || code === 0x7f) {
      control++;
      if (sequences.length < 12) {
        sequences.push(Buffer.from(ch).toString("hex"));
      }
    } else {
      printable++;
    }
  }
  return { bytes: buf.length, printable, control, sequences };
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") {
      return v.toString();
    }
    if (v instanceof Error) {
      return { name: v.name, message: v.message, stack: v.stack };
    }
    if (v !== null && typeof v === "object") {
      if (seen.has(v)) {
        return "[circular]";
      }
      seen.add(v);
    }
    return v;
  });
}
