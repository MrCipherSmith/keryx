#!/usr/bin/env bun
/**
 * SPIKE ONLY — the shape specification.md §4.2 proposes for the real
 * `sandbox/landlock-exec.ts`, reduced to the minimum that answers the spike
 * question. Applies a Landlock ruleset to ITSELF, then runs the real command.
 *
 *   bun landlock-exec.ts [--ro PATH]... [--rw PATH]... [--net] \
 *                        [--allow-tcp-connect PORT]... [--allow-tcp-bind PORT]... \
 *                        -- <command> [args...]
 *
 * Exits with the command's exit code, or 125 if the ruleset could not be
 * applied — never runs the command unrestricted (fail-closed, spec N1).
 */

import {
  ACCESS_NET,
  execIntoCommand,
  READ_ONLY_ACCESS,
  READ_WRITE_ACCESS,
  restrictSelfWith,
  type NetRule,
  type PathRule,
} from "./landlock-ffi.ts";

const APPLY_FAILED_EXIT_CODE = 125;

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
      case "--net":
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
    // Replaces this process: the contained command inherits the ruleset the
    // way any exec'd program does, and no Bun process stays resident.
    execIntoCommand(invocation.command, process.env);
  }

  const [program, ...args] = invocation.command as [string, ...string[]];
  const child = Bun.spawnSync([program, ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exitCode;
}

process.exit(main());
