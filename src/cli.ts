#!/usr/bin/env -S bun --no-env-file --config=/dev/null
// R1-01 (flow 319, review round 1, blocker): Bun's default shebang
// (`#!/usr/bin/env bun`) auto-loads `.env`/`.env.local`/`.env.<NODE_ENV>` AND
// a `bunfig.toml` `preload` script from the CURRENT WORKING DIRECTORY into
// this process — so a cloned, hostile repository controls this CLI's
// environment (including `KERYX_HOME`, `KERYX_HOOKS`, provider base
// URLs/keys, `XDG_*`) and can run arbitrary code via `preload` before a
// single line of `keryx` itself executes. `--no-env-file` stops the dotenv
// autoload; `--config=/dev/null` stops the cwd `bunfig.toml` autoload
// (verified empirically on Bun 1.4.2 — `--no-env-file` ALONE does not stop
// `preload`; `--config` does). `env -S` (POSIX-undefined but present on
// macOS's `env` and GNU coreutils `env` >= 8.30 — both platforms this
// package's standalone binaries and npm postinstall target, per `scripts/
// install-binary.sh`) splits the interpreter line into `bun --no-env-file
// --config=/dev/null`; `/dev/null` as `--config` reads as an empty TOML
// document on both, so no `preload` runs there either. `dist/cli.js` (the
// shipped `bin`, built by `bun run build`) carries this SAME shebang — see
// `package.json`'s `build` script.
//
// Platform gaps, so they are documented rather than silently unhandled:
// BusyBox `env` (Alpine, some minimal containers) does not implement `-S` —
// on that platform the shebang line is passed to `bun` as one literal
// argument and fails to start; the standalone binary (no shebang at all,
// but not currently published for any Windows/musl target either — see
// `scripts/install-binary.sh`'s platform list) is the working path there
// once one exists. Windows has no shebang mechanism at all — an npm
// install's generated `.cmd`/`.ps1` shim decides how `dist/cli.js` is
// launched there, not this line; `src/lib/safe-exec.ts`'s runtime guard
// below is what actually protects a Windows npm install, since it runs
// regardless of how the process was started.
//
// This shebang is the real fix. It does not cover every invocation shape
// (`bun dist/cli.js`, `bun src/cli.ts`, `bunx keryx` all bypass a shebang
// entirely) — `./lib/safe-exec.ts`'s startup guard below is defence in depth
// for those.
// retired-spellings-ok: file — help text still lists the retired usage lines because those invocations still work; removing them would hide a working command

import { ensureSafeBunExec } from "./lib/safe-exec";

// R1-01 / R2-01 / R2-07 (info): run as early as this module can — before
// `main()`'s own body, and before any command handler this file dispatches
// to. The real limit, stated rather than hidden: ES MODULE IMPORTS ARE
// HOISTED. Every `import` declaration in this file — including every one
// BELOW this line, textually — is evaluated before a single statement in
// this file's own top-level body runs, this `if` included. So a top-level
// side effect in an imported module (or in a module IT imports) that reads
// `process.env` before this guard has a chance to run can still observe a
// cwd-`.env`-poisoned value, and (dev/bypass forms only — R2-07) a cwd
// `bunfig.toml` `preload` script runs before ANY of this file's own code,
// guard included; Bun preloads before user code, full stop.
//
// This file deliberately imports NOTHING above this point (R2-07 follow-up:
// the two imports that used to sit here, `runModelTurn`/`setModelTurnPort`,
// were moved below with the rest — keeping them above bought nothing, since
// hoisting already runs every import in the file first regardless of source
// order; the previous placement implied a protection import order cannot
// provide). Moving command imports behind a dynamic `await import(...)`
// after the guard WOULD close the "static imports evaluated before the
// guard" gap for command modules specifically, at the cost of losing
// synchronous, statically-checkable imports for every command in this file;
// not done here — the shebang (top of this file) is the actual fix for the
// shipped binary, and is unaffected by import hoisting (a different process
// entirely never runs the unsafe autoload in the first place). See
// `./lib/safe-exec.ts` and docs/docs/onboarding.md's "Environment isolation"
// for the platforms (BusyBox `env`, Windows) where the shebang does not
// apply and this guard is what actually protects the invocation.
//
// A normal shebang-launched process (already safe) returns from
// `ensureSafeBunExec` after one synchronous `execArgv` check — no re-exec, no
// filesystem access. `await` here is a top-level `await` (valid ESM,
// supported by Bun): it only actually suspends this module's own further
// evaluation when a real re-exec happens.
if (import.meta.main) {
  await ensureSafeBunExec();
}

import { ShellFlagError } from "./commands/shell";
import { formatUnknownCommandMessage } from "./lib/suggest";
// A-2 (flow 356, audit remediation 3): `CLI_ROUTES`, `printCommandHelp` and
// everything else dispatch needs moved to `./cli-registry` to break a cycle
// with `commands/help.ts` — see that file's header for the full reasoning.
// Re-exported below so every existing importer of `CLI_ROUTES`/`USAGE_BODY`/
// etc. FROM THIS FILE (this module's own tests, several other test files)
// keeps working unchanged.
import {
  CLI_ROUTES,
  USAGE_BODY,
  VERSION,
  groupUsage,
  groupsWithKnownSubcommands,
  helpRequestedFor,
  knownSubcommandsFor,
  printCommandHelp,
  registerModelTurnPort,
  shouldInterceptHelp,
} from "./cli-registry";

export {
  CLI_ROUTES,
  USAGE_BODY,
  VERSION,
  groupUsage,
  groupsWithKnownSubcommands,
  helpRequestedFor,
  knownSubcommandsFor,
  printCommandHelp,
  shouldInterceptHelp,
};

function printHelp(): void {
  console.log(`keryx ${VERSION}\n\n${USAGE_BODY}`);
}

export async function main(): Promise<void> {
  // Inside `main`, not at module scope: a registration at import time changes
  // the behaviour of every process that merely imports this file, which
  // turned three tests asserting the unwired refusal green for the wrong
  // reason. See `cli-registry.ts`'s `registerModelTurnPort` doc comment.
  registerModelTurnPort();

  const args = process.argv.slice(2);
  const command = args[0];

  // `--help`, `-h` and bare `keryx` print the flat USAGE_BODY, unchanged
  // (AC5, flow 303). `help` used to be a third alias of that same branch;
  // it is now its own route (below, via CLI_ROUTES.help ->
  // `commands/help.ts`) so `keryx help` with no args can print the grouped
  // view (AC3) while these three keep printing exactly what they printed
  // before this flow.
  if (command === "--help" || command === "-h" || !command) {
    printHelp();
    return;
  }

  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }

  // Bare `keryx` is the CLI surface (help above). The interactive TUI agent
  // harness is only `keryx shell […]`. Do not route stray `--flags` into shell.

  const route = CLI_ROUTES[command];
  if (route) {
    // Ask for usage, do not DO anything. The guard sits here, in front of every
    // group, so a future subcommand cannot forget it — and it is skipped for
    // tokens after `--`, which are the child process's own.
    if (shouldInterceptHelp(command, args.slice(1))) {
      // A group in this map still gets intercepted — no mutating subcommand
      // handler ever runs on a stray `--help` — but the TEXT printed is the
      // group's own help, not a second, independently-drifting slice of
      // `USAGE_BODY` (AC5, flow 294). `groupUsage`'s slice is what silently
      // dropped `flow owner`/`flow ac`/half of `flow`'s subcommands and every
      // `trigger` subcommand but `run` — this is the fix for that class of
      // drift, applied without touching the "ask, don't do" guard above.
      await printCommandHelp(command);
      return;
    }
    // Flow 353 review round 1 (blocker L1): the SAME one-line "unknown
    // command" treatment as the top-level check below, but for a known
    // group's first SUBCOMMAND — `keryx health rn`/`keryx wiki serach` used
    // to reach the handler and print that handler's own full usage on
    // stdout, the exact defect AC3 closes at the top level. Conservative on
    // purpose: only fires for a group `knownSubcommandsFor` has verified
    // data for, only when a first argument is actually present, and never
    // for anything that looks like a flag (`--json`) or an already-checked
    // `--help`/`-h` (the guard above already returned on those). A
    // genuinely unknown group name still falls through to `route`
    // undefined below, unaffected.
    const known = knownSubcommandsFor(command);
    const sub = args[1];
    if (known !== undefined && sub !== undefined && !sub.startsWith("-") && !known.includes(sub)) {
      console.error(formatUnknownCommandMessage(sub, known, `keryx ${command} --help`));
      process.exitCode = 1;
      return;
    }
    await route(args.slice(1));
    return;
  }

  // Flow 353 AC3: one line, on stderr, never the ~9.5 KB flat usage
  // (`printHelp` above) — `docs/requirements/backlog.md` item 4 measured
  // that usage dump landing on STDOUT on an error path, which this also
  // fixes by not printing it here at all. `__sandbox-net-forward` is
  // excluded from suggestions: it is an internal-only route
  // (`CLI_ROUTES`'s own comment) no operator ever types, so it must never
  // be offered as what they meant to type.
  console.error(
    formatUnknownCommandMessage(
      command,
      Object.keys(CLI_ROUTES).filter((name) => name !== "__sandbox-net-forward"),
    ),
  );
  process.exitCode = 1;
}

/**
 * The exit code for an error that escaped `main`: 1, except a shell usage
 * error (`ShellFlagError`, e.g. `keryx shell --fork` without `-r <id>`), which
 * carries its own. Only that class is trusted: any other error that happens to
 * carry an `exitCode` (a Bun ShellError, an execa error) is a child process's
 * code, not keryx's (review F9).
 */
export function exitCodeForError(error: unknown): number {
  return error instanceof ShellFlagError ? error.exitCode : 1;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = exitCodeForError(error);
  });
}
