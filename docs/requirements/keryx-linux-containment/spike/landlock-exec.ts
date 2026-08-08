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

import {
  ACCESS_NET,
  DEVICE_ACCESS,
  execIntoCommand,
  READ_ONLY_ACCESS,
  READ_WRITE_ACCESS,
  restrictSelfWith,
  type NetRule,
  type PathRule,
} from "./landlock-ffi.ts";

const APPLY_FAILED_EXIT_CODE = 125;

/** Signal name -> number, for the shell's 128+N exit convention. */
const SIGNAL_NUMBERS: Readonly<Record<string, number>> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGABRT: 6,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGSEGV: 11,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
  SIGSYS: 31,
};

function signalNumber(name: string): number {
  return SIGNAL_NUMBERS[name] ?? 0;
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
        net.push({ port: Number(value("--allow-tcp-connect")), allowed: ACCESS_NET.CONNECT_TCP });
        handleNet = true;
        break;
      case "--allow-tcp-bind":
        net.push({ port: Number(value("--allow-tcp-bind")), allowed: ACCESS_NET.BIND_TCP });
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
          `path_rules=${outcome.pathRules} net_rules=${outcome.netRules}\n`,
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
  const child = Bun.spawnSync([program, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  // Bun types exitCode as number, but it is null when the child died by a
  // signal — and process.exit(null) exits 0, i.e. a SIGKILLed command would be
  // reported as success. Follow the shell convention instead.
  if (child.exitCode === null) {
    const signal = child.signalCode;
    process.stderr.write(`landlock-exec: command terminated by ${signal ?? "unknown signal"}\n`);
    return signal === null || signal === undefined ? APPLY_FAILED_EXIT_CODE : 128 + signalNumber(signal);
  }
  return child.exitCode;
}

process.exit(main());
