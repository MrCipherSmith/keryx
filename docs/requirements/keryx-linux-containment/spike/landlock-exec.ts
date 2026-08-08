#!/usr/bin/env bun
/**
 * SPIKE ONLY — the shape specification.md §4.2 proposes for the real
 * `sandbox/landlock-exec.ts`, reduced to the minimum that answers the spike
 * question. Applies a Landlock ruleset to ITSELF, then runs the real command.
 *
 *   bun landlock-exec.ts [--ro PATH]... [--rw PATH]... [--dev PATH]... \
 *                        [--handle-tcp] \
 *                        [--allow-tcp-connect PORT]... [--allow-tcp-bind PORT]... \
 *                        -- <command> [args...]
 *
 * Exits with the command's exit code, or 125 if the ruleset could not be
 * applied — never runs the command unrestricted (fail-closed, spec N1).
 */

import { constants as osConstants } from "node:os";

import {
  ACCESS_NET,
  DEVICE_ACCESS,
  execIntoCommand,
  NEWEST_KNOWN_ABI,
  READ_ONLY_ACCESS,
  READ_WRITE_ACCESS,
  restrictSelfWith,
  type NetRule,
  type PathRule,
} from "./landlock-ffi.ts";

const APPLY_FAILED_EXIT_CODE = 125;

/**
 * Signal name -> number, from the runtime rather than a hand-written table: a
 * partial table silently maps every signal it forgot to exit code 128, which
 * is a plausible-looking status that names neither success nor the signal.
 * `node:os` knows all 30-odd of them.
 */
function signalNumber(signal: string | number): number | undefined {
  // Bun reports signalCode as the NUMBER for signals it cannot name — real-time
  // signals (SIGRTMIN+n, 34..64) arrive as 34, not "SIGRT...". Looking that up
  // by name misses, and returning the fail-closed code for it would report a
  // command that ran and died as one that never started.
  if (typeof signal === "number") return signal;
  const known = (osConstants.signals as Record<string, number | undefined>)[signal];
  return typeof known === "number" ? known : undefined;
}

/** Port arguments must be real ports; `Number("")` is 0 and would install a rule. */
function parsePort(raw: string, flag: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${flag}: ${raw || "(empty)"} is not a port number`);
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new Error(`${flag}: ${port} is out of range 1-65535`);
  return port;
}

interface Invocation {
  readonly paths: readonly PathRule[];
  readonly net: readonly NetRule[];
  readonly handleNet: boolean;
  readonly command: readonly string[];
  readonly verbose: boolean;
  /** `execve` replaces this process; `spawn` keeps Bun resident as the parent. */
  readonly mode: "execve" | "spawn";
}

function parse(argv: readonly string[]): Invocation {
  const paths: PathRule[] = [];
  const net: NetRule[] = [];
  let handleNet = false;
  let verbose = false;
  let mode: "execve" | "spawn" = "execve";
  let index = 0;

  const value = (flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${flag} needs a value`);
    index += 2;
    return next;
  };

  while (index < argv.length) {
    const arg = argv[index] as string;
    if (arg === "--") {
      index += 1;
      break;
    }
    switch (arg) {
      case "--ro":
        paths.push({ path: value("--ro"), allowed: READ_ONLY_ACCESS });
        break;
      case "--rw":
        paths.push({ path: value("--rw"), allowed: READ_WRITE_ACCESS });
        break;
      case "--dev":
        paths.push({ path: value("--dev"), allowed: DEVICE_ACCESS });
        break;
      // Named --handle-tcp, not --net: the axis covers TCP bind/connect ONLY.
      // UDP, DNS, raw and unix sockets are outside it, so a flag called --net
      // would invite exactly the "network is off" misreading spec §4.3 forbids.
      case "--handle-tcp":
        handleNet = true;
        index += 1;
        break;
      case "--allow-tcp-connect":
        net.push({
          port: parsePort(value("--allow-tcp-connect"), "--allow-tcp-connect"),
          allowed: ACCESS_NET.CONNECT_TCP,
        });
        handleNet = true;
        break;
      case "--allow-tcp-bind":
        net.push({
          port: parsePort(value("--allow-tcp-bind"), "--allow-tcp-bind"),
          allowed: ACCESS_NET.BIND_TCP,
        });
        handleNet = true;
        break;
      case "--verbose":
        verbose = true;
        index += 1;
        break;
      case "--spawn":
        mode = "spawn";
        index += 1;
        break;
      case "--execve":
        mode = "execve";
        index += 1;
        break;
      default:
        throw new Error(`unknown flag ${arg}`);
    }
  }

  const command = argv.slice(index);
  if (command.length === 0) throw new Error("no command after --");
  return { paths, net, handleNet, command, verbose, mode };
}

function main(): number {
  let invocation: Invocation;
  try {
    invocation = parse(Bun.argv.slice(2));
  } catch (error) {
    process.stderr.write(`landlock-exec: ${(error as Error).message}\n`);
    return APPLY_FAILED_EXIT_CODE;
  }

  try {
    const outcome = restrictSelfWith({
      paths: invocation.paths,
      net: invocation.net,
      handleNet: invocation.handleNet,
    });
    if (invocation.verbose) {
      process.stderr.write(
        `landlock-exec: abi=${outcome.abi} handled_fs=0x${outcome.handledFs.toString(16)} ` +
          `handled_net=0x${outcome.handledNet.toString(16)} ` +
          `path_rules=${outcome.pathRules} net_rules=${outcome.netRules}` +
          `${outcome.abiClamped ? " abi_clamped=yes" : ""}\n`,
      );
    }
    if (outcome.abiClamped) {
      // Always warn, not just under --verbose: the kernel is newer than this
      // code, so access classes it added are unhandled and therefore
      // unrestricted. Reported rather than fatal because the spike's job is to
      // measure, but Step 3 should decide whether to refuse outright.
      process.stderr.write(
        `landlock-exec: warning: kernel Landlock ABI ${outcome.abi} is newer than this build ` +
          `knows (${NEWEST_KNOWN_ABI}); newer access classes are UNRESTRICTED\n`,
      );
    }
  } catch (error) {
    // Fail closed: the command does not run if the boundary was not applied.
    process.stderr.write(`landlock-exec: ${(error as Error).message}\n`);
    return APPLY_FAILED_EXIT_CODE;
  }

  if (invocation.mode === "execve") {
    try {
      // Replaces this process: the contained command inherits the ruleset the
      // way any exec'd program does, and no Bun process stays resident.
      execIntoCommand(invocation.command, process.env);
    } catch (error) {
      // A failed exec must not be reported as the command exiting 1 — the
      // caller would conclude it ran and failed when it never started.
      process.stderr.write(`landlock-exec: ${(error as Error).message}\n`);
      return APPLY_FAILED_EXIT_CODE;
    }
  }

  const [program, ...args] = invocation.command as [string, ...string[]];
  let child: Bun.SyncSubprocess;
  try {
    child = Bun.spawnSync([program, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
  } catch (error) {
    // spawnSync throws ENOENT for a missing program. Without this the launcher
    // would exit 1 with a stack trace — indistinguishable from the command
    // itself exiting 1, which is the whole reason 125 is reserved.
    process.stderr.write(`landlock-exec: ${(error as Error).message}\n`);
    return APPLY_FAILED_EXIT_CODE;
  }

  // Bun types exitCode as number, but it is null when the child died by a
  // signal — and process.exit(null) exits 0, i.e. a SIGKILLed command would be
  // reported as success. Follow the shell convention instead.
  if (child.exitCode === null) {
    const signal = (child.signalCode ?? undefined) as string | number | undefined;
    const number = signal === undefined ? undefined : signalNumber(signal);
    process.stderr.write(`landlock-exec: command terminated by ${signal ?? "unknown signal"}\n`);
    // An unmappable signal must not be rendered as a plausible exit status.
    return number === undefined ? APPLY_FAILED_EXIT_CODE : 128 + number;
  }
  return child.exitCode;
}

process.exit(main());
