// The `keryx shell --debug` watcher: a separate, detached process that observes
// the shell from outside.
//
// The in-process heartbeat cannot see the failure this exists for. In session
// 603f3171 the shell's own view of stdin could well have looked healthy while
// the kernel said otherwise: the tty reader fd was no longer in any epoll set
// and the terminal's input queue was full. Only another process can read that —
// `/proc/<pid>/fdinfo` for the epoll registrations, FIONREAD on the tty for the
// unread bytes — so the watcher samples both once a second, logs every change,
// and when input has visibly stopped it records a full snapshot and sends the
// shell SIGUSR2, which re-arms stdin (`stdin-guard.ts`).
//
// Linux only for the kernel-side checks; elsewhere it still reports liveness and
// heartbeat freshness.

import { spawn, spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import path from "node:path";
import { appendOwnerOnlyLine } from "../lib/config-dir";
import type { DebugRun } from "./debug-log";

const EPOLLIN = 0x1;
const FIONREAD = 0x541b;

/** One registration line of an epoll fd's fdinfo. */
export interface EpollEntry {
  tfd: number;
  events: number;
}

/** Parse the `tfd:` lines of `/proc/<pid>/fdinfo/<epoll fd>`. */
export function parseEpollFdinfo(text: string): EpollEntry[] {
  const out: EpollEntry[] = [];
  for (const line of text.split("\n")) {
    const match = /^tfd:\s*(\d+)\s+events:\s*([0-9a-fA-F]+)/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      out.push({ tfd: Number(match[1]), events: Number.parseInt(match[2], 16) });
    }
  }
  return out;
}

/**
 * Is any terminal fd of the process registered for readability? `undefined`
 * when the process has no terminal fd at all (nothing to judge).
 */
export function ttyReaderArmed(ttyFds: readonly number[], epoll: readonly EpollEntry[]): boolean | undefined {
  if (ttyFds.length === 0) {
    return undefined;
  }
  return epoll.some((entry) => ttyFds.includes(entry.tfd) && (entry.events & EPOLLIN) !== 0);
}

export interface WatchSample {
  alive: boolean;
  readerArmed?: boolean | undefined;
  pending?: number | undefined;
  heartbeatAgeMs?: number | undefined;
}

export type StallReason = "reader-not-polled" | "input-not-drained" | "event-loop-silent";

/**
 * Decide from the last few samples whether input has stopped. Needs the
 * condition to hold for `window` consecutive samples so a busy frame or one
 * burst of typing is not mistaken for a dead reader.
 */
export function detectStall(history: readonly WatchSample[], window = 3): StallReason | undefined {
  if (history.length < window) {
    return undefined;
  }
  const recent = history.slice(-window);
  if (recent.every((s) => s.alive && s.readerArmed === false)) {
    return "reader-not-polled";
  }
  if (
    recent.every((s) => s.alive && (s.pending ?? 0) > 0) &&
    recent.every((s, i) => i === 0 || (s.pending ?? 0) >= (recent[i - 1]?.pending ?? 0))
  ) {
    return "input-not-drained";
  }
  if (recent.every((s) => s.alive && (s.heartbeatAgeMs ?? 0) > 5000)) {
    return "event-loop-silent";
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

interface FdInfo {
  fd: number;
  link: string;
  flags?: string | undefined;
}

function listFds(pid: number): FdInfo[] {
  const out: FdInfo[] = [];
  let entries: string[];
  try {
    entries = readdirSync(`/proc/${pid}/fd`);
  } catch {
    return out;
  }
  for (const name of entries) {
    const fd = Number(name);
    let link: string;
    try {
      link = readlinkSync(`/proc/${pid}/fd/${name}`);
    } catch {
      continue;
    }
    const flags = /flags:\s*(\S+)/.exec(readText(`/proc/${pid}/fdinfo/${name}`) ?? "")?.[1];
    out.push({ fd, link, flags });
  }
  return out;
}

const isTtyLink = (link: string): boolean => link.startsWith("/dev/pts/") || /^\/dev\/tty/.test(link);

function epollEntries(pid: number, fds: readonly FdInfo[]): { epfd: number; entries: EpollEntry[] }[] {
  return fds
    .filter((f) => f.link === "anon_inode:[eventpoll]")
    .map((f) => ({ epfd: f.fd, entries: parseEpollFdinfo(readText(`/proc/${pid}/fdinfo/${f.fd}`) ?? "") }));
}

function threads(pid: number): { tid: string; comm: string; wchan: string; state: string }[] {
  let tids: string[];
  try {
    tids = readdirSync(`/proc/${pid}/task`);
  } catch {
    return [];
  }
  return tids.map((tid) => {
    const base = `/proc/${pid}/task/${tid}`;
    const stat = readText(`${base}/stat`) ?? "";
    const state = /\)\s+(\S)/.exec(stat)?.[1] ?? "?";
    return { tid, comm: (readText(`${base}/comm`) ?? "").trim(), wchan: (readText(`${base}/wchan`) ?? "").trim(), state };
  });
}

type PendingReader = (fd: number) => number | undefined;

/** FIONREAD through libc (bun:ffi). `undefined` wherever that is unavailable. */
async function makePendingReader(): Promise<PendingReader> {
  if (process.platform !== "linux") {
    return () => undefined;
  }
  try {
    const ffi = await import("bun:ffi");
    const libc = ffi.dlopen("libc.so.6", {
      ioctl: { args: [ffi.FFIType.i32, ffi.FFIType.u64, ffi.FFIType.ptr], returns: ffi.FFIType.i32 },
    });
    return (fd) => {
      const out = new Int32Array(1);
      const rc = libc.symbols.ioctl(fd, FIONREAD, ffi.ptr(out));
      return rc === 0 ? (out[0] ?? 0) : undefined;
    };
  } catch {
    return () => undefined;
  }
}

/**
 * Launch the watcher for this shell as a detached process that outlives nothing:
 * it exits on its own once the shell's pid is gone.
 */
export function spawnDebugWatcher(run: DebugRun): number | undefined {
  const entry = process.argv[1];
  const args = [
    ...(entry !== undefined ? [entry] : []),
    "shell",
    "--debug-watcher",
    "--pid",
    String(process.pid),
    "--dir",
    run.dir,
  ];
  try {
    const child = spawn(process.execPath, args, { detached: true, stdio: "ignore", env: process.env });
    child.unref();
    return child.pid;
  } catch {
    return undefined;
  }
}

/** Entry point for `keryx shell --debug-watcher --pid <pid> --dir <run dir>`. */
export async function runDebugWatcher(argv: readonly string[]): Promise<void> {
  const pidArg = argv[argv.indexOf("--pid") + 1];
  const dirArg = argv[argv.indexOf("--dir") + 1];
  const pid = Number(pidArg);
  if (!Number.isInteger(pid) || pid <= 0 || dirArg === undefined || !argv.includes("--dir")) {
    process.stderr.write("usage: keryx shell --debug-watcher --pid <pid> --dir <debug run dir>\n");
    process.exitCode = 2;
    return;
  }
  const logFile = path.join(dirArg, "watcher.ndjson");
  const shellLog = path.join(dirArg, "shell.ndjson");
  const log = (kind: string, data: Record<string, unknown> = {}): void => {
    try {
      appendOwnerOnlyLine(logFile, JSON.stringify({ ts: new Date().toISOString(), watcher: process.pid, target: pid, kind, ...data }));
    } catch {
      // best-effort
    }
  };
  const linux = process.platform === "linux" && isAlive(pid) && readText(`/proc/${pid}/stat`) !== undefined;
  const pendingOf = await makePendingReader();

  let ttyPath: string | undefined;
  let ttyFd: number | undefined;
  if (linux) {
    try {
      ttyPath = readlinkSync(`/proc/${pid}/fd/0`);
      if (isTtyLink(ttyPath)) {
        ttyFd = openSync(ttyPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY);
      }
    } catch (error) {
      log("tty.open-failed", { error: String(error) });
    }
  }
  log("watcher.start", { linux, ttyPath, fionread: ttyFd !== undefined && pendingOf(ttyFd) !== undefined });

  const history: WatchSample[] = [];
  let lastLogged = "";
  let lastPeriodic = 0;
  let lastSignal = 0;

  const fullSnapshot = (): Record<string, unknown> => {
    const fds = listFds(pid);
    let stty: string | undefined;
    if (ttyPath !== undefined) {
      const res = spawnSync("stty", ["-a", "-F", ttyPath], { encoding: "utf8", timeout: 2000 });
      stty = (res.stdout ?? "").trim() || (res.stderr ?? "").trim();
    }
    return {
      stat: (readText(`/proc/${pid}/stat`) ?? "").trim(),
      status: (readText(`/proc/${pid}/status`) ?? "")
        .split("\n")
        .filter((l) => /^(State|Threads|SigBlk|SigIgn|SigCgt|VmRSS):/.test(l)),
      fds,
      epoll: epollEntries(pid, fds),
      threads: threads(pid),
      stty,
    };
  };

  const tick = (): boolean => {
    const alive = isAlive(pid);
    const sample: WatchSample = { alive };
    if (alive && linux) {
      const fds = listFds(pid);
      const ttyFds = fds.filter((f) => isTtyLink(f.link)).map((f) => f.fd);
      const entries = epollEntries(pid, fds).flatMap((e) => e.entries);
      sample.readerArmed = ttyReaderArmed(ttyFds, entries);
    }
    if (alive && ttyFd !== undefined) {
      sample.pending = pendingOf(ttyFd);
    }
    try {
      sample.heartbeatAgeMs = Date.now() - statSync(shellLog).mtimeMs;
    } catch {
      sample.heartbeatAgeMs = undefined;
    }
    history.push(sample);
    if (history.length > 30) history.shift();

    if (!alive) {
      log("target.exit");
      return false;
    }
    const key = JSON.stringify({ a: sample.readerArmed, p: (sample.pending ?? 0) > 0 });
    const now = Date.now();
    if (key !== lastLogged || now - lastPeriodic > 10_000) {
      log("sample", { ...sample });
      lastLogged = key;
      lastPeriodic = now;
    }
    const stall = detectStall(history);
    if (stall !== undefined && now - lastSignal > 15_000) {
      lastSignal = now;
      log("stall.detected", { reason: stall, recent: history.slice(-5), snapshot: linux ? fullSnapshot() : {} });
      if (stall !== "event-loop-silent" && process.platform !== "win32") {
        try {
          process.kill(pid, "SIGUSR2");
          log("recover.signal-sent", { signal: "SIGUSR2" });
        } catch (error) {
          log("recover.signal-failed", { error: String(error) });
        }
        setTimeout(() => {
          log("recover.after", { snapshot: linux ? fullSnapshot() : {}, pending: ttyFd !== undefined ? pendingOf(ttyFd) : undefined });
        }, 2000);
      }
    }
    return true;
  };

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!tick()) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
  if (ttyFd !== undefined) {
    try {
      closeSync(ttyFd);
    } catch {
      // exiting anyway
    }
  }
  log("watcher.stop");
}
