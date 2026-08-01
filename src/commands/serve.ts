// `keryx serve` — the loopback-bound HTTP door (flow 128 / roadmap R4b).
//
// Surface:
//
//   keryx serve [--bind <addr>] [--port <n>] [--profile <name>] [--acknowledge-non-loopback]
//   keryx serve status [--json]
//   keryx serve token issue | rotate | revoke
//   keryx serve config init [--bind <addr>] [--port <n>] [--profile <name>] [--acknowledge-non-loopback] [--force]
//   keryx serve config set [--bind <addr>] [--port <n>] [--profile <name>] [--acknowledge-non-loopback|--no-acknowledge-non-loopback] [--enable|--disable]
//   keryx serve config show [--json]
//
// `config init` / `config set` / `config show` are not in specification.md's CLI
// list, which names no command that CREATES or CHANGES the configuration.
// Something has to, and inferring a persisted config from a bare `keryx serve`
// invocation would make "off by default" depend on argument order. Flags on
// `keryx serve` itself are a per-run overlay and are never persisted.
//
// `config set` in particular is not decoration: once `config init` refuses to
// replace an existing configuration, every instruction that says "fix your
// configuration" needs a non-destructive command to name, and `--force` is not
// one — it rebuilds from defaults and drops the operator's bind, port and
// profile.
//
// Argv discipline is the one from src/commands/projects.ts, and for the reason
// recorded there: `--help` is resolved against the WHOLE argv before any
// branch, and every flag is validated — not just a leading one — because
// `projects list --jsonn` printing human output at exit 0 was a real defect on
// the documented form.
//
// Everything echoed goes through `sanitizeForDisplay`. Bind addresses, profile
// names and subcommands are all operator-supplied argv, and a warning about a
// damaged file quotes a field name that came off disk.

import { randomUUID } from "node:crypto";
import { sanitizeForDisplay } from "../lib/project-registry";
import {
  DEFAULT_SERVE_BIND_ADDRESS,
  DEFAULT_SERVE_PORT,
  DEFAULT_SERVE_PROFILE,
  defaultServeConfig,
  isLoopbackAddress,
  loadServeConfig,
  serveConfigAdvice,
  serveConfigState,
  saveServeConfig,
  serveConfigPath,
  type ServeConfig,
} from "../lib/serve-config";
import {
  credentialFingerprint,
  issueServeToken,
  readServeCredential,
  revokeServeToken,
  rotateServeToken,
  serveCredentialPath,
} from "../lib/serve-credential";
import { describeServeStatus, startServeListener } from "../lib/serve-server";
import { helpOptions, helpTitle, helpUsage, note, style, symbols } from "../lib/ui";

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

interface ParsedArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

type ParseOutcome = { ok: true; parsed: ParsedArgs } | { ok: false; message: string };

/**
 * Parse a closed set of flags. Anything else is an error, not a shrug.
 *
 * Positional arguments are rejected too: none of these subcommands takes one,
 * and silently ignoring a stray word is how `serve token issue extra` looks
 * like it did something with `extra`.
 */
function parseArgs(args: string[], valueFlags: readonly string[], booleanFlags: readonly string[]): ParseOutcome {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      return { ok: false, message: `Unexpected argument: ${sanitizeForDisplay(arg)}` };
    }
    if (booleanFlags.includes(arg)) {
      // Repeats are refused, not folded. "Anything else is an error, not a
      // shrug" has to include this: `--bind 10.0.0.5 --bind 127.0.0.1` silently
      // keeping the last is exactly the argument-order dependence this module
      // says it avoids, and it is the shape that binds the wrong interface.
      if (flags.has(arg)) {
        return { ok: false, message: `Option ${sanitizeForDisplay(arg)} was given more than once` };
      }
      flags.add(arg);
      continue;
    }
    if (valueFlags.includes(arg)) {
      if (values.has(arg)) {
        return { ok: false, message: `Option ${sanitizeForDisplay(arg)} was given more than once` };
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        // `arg` is necessarily one of the declared flag literals on this line,
        // so no hostile input can reach this sanitizer and no test can drive
        // it. It stays as defence for a future edit that widens where `arg`
        // comes from — stated plainly rather than counted as a tested control.
        return { ok: false, message: `Option ${sanitizeForDisplay(arg)} needs a value` };
      }
      values.set(arg, value);
      index += 1;
      continue;
    }
    return { ok: false, message: `Unknown option: ${sanitizeForDisplay(arg)}` };
  }
  return { ok: true, parsed: { values, flags } };
}

/**
 * Report a failure and set a non-zero exit code.
 *
 * Sanitizes HERE rather than at each call site. Every current caller passes a
 * literal or an already-sanitized value, so nothing is exposed today — but
 * sanitizing per-caller is the shape that left the next caller open one flow
 * ago, and the next caller is always the one nobody reviewed.
 */
function fail(message: string): void {
  console.error(`  ${style.red(symbols.cross)} ${sanitizeForDisplay(message)}`);
  process.exitCode = 1;
}

function warn(message: string): void {
  console.log(`  ${style.yellow(symbols.bullet)} ${sanitizeForDisplay(message)}`);
}

const BIND_FLAGS = ["--bind", "--port", "--profile"] as const;
const ACK_FLAG = "--acknowledge-non-loopback";
/** Replace an existing `serve.json`. Required, because `config init` is destructive. */
const FORCE_FLAG = "--force";
/** `config set` only: withdraw a non-loopback acknowledgement without a full rewrite. */
const NO_ACK_FLAG = "--no-acknowledge-non-loopback";
const ENABLE_FLAG = "--enable";
const DISABLE_FLAG = "--disable";

// ---------------------------------------------------------------------------

export async function serveCommand(args: string[] = []): Promise<void> {
  // Help is resolved against the WHOLE argv, before any branch.
  if (args.includes("--help") || args.includes("-h") || args[0] === "help") {
    printHelp();
    return;
  }

  const sub = args[0];
  if (sub === undefined || sub.startsWith("-")) {
    await runServe(args);
    return;
  }
  if (sub === "status") {
    runStatus(args.slice(1));
    return;
  }
  if (sub === "token") {
    runToken(args.slice(1));
    return;
  }
  if (sub === "config") {
    runConfig(args.slice(1));
    return;
  }

  console.error(`Unknown serve command: ${sanitizeForDisplay(sub)}`);
  printHelp();
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// keryx serve
// ---------------------------------------------------------------------------

async function runServe(args: string[]): Promise<void> {
  const parsed = parseArgs(args, BIND_FLAGS, [ACK_FLAG]);
  if (!parsed.ok) {
    console.error(parsed.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const port = readPort(parsed.parsed.values.get("--port"), { allowEphemeral: true });
  if (port === "invalid") {
    fail(`--port must be an integer between 0 and 65535 (0 selects an ephemeral port)`);
    return;
  }
  if (!requireNonBlank("--bind", parsed.parsed.values.get("--bind"))) {
    return;
  }
  if (!requireNonBlank("--profile", parsed.parsed.values.get("--profile"))) {
    return;
  }

  const stored = loadServeConfig(undefined, warn);
  const runtimeAck = parsed.parsed.flags.has(ACK_FLAG);
  const config = stored === null ? null : overlay(stored, parsed.parsed, port, runtimeAck);

  const outcome = await startServeListener({
    config,
    credential: readServeCredential(),
    // Without this the `no-configuration` refusal cannot tell "nothing is
    // configured" from "the file is there and I could not read it", and the
    // instruction it prints is wrong for two of the three.
    configState: serveConfigState(),
  });
  if (!outcome.ok) {
    fail(sanitizeForDisplay(outcome.message));
    if (outcome.reason === "non-loopback-not-acknowledged" && stored !== null) {
      // Security policy requires BOTH halves; say which one is missing rather
      // than leaving the operator to guess.
      if (stored.bind.acknowledgeNonLoopback !== true) {
        // `config set`, not `config init`. A configuration demonstrably
        // exists on this branch (`stored !== null`), so `config init` refuses
        // — and adding `--force` would make the instruction succeed by
        // resetting bind, port and profile to defaults, which is the damage
        // this whole area was fixed for. `config set` changes the named field
        // and preserves the rest.
        // Backticked, like every other instruction. Not cosmetic: the class
        // guard extracts backticked commands and executes them, so an
        // unbackticked one is invisible to it — a mutation drifted this line to
        // a command that exits 1 and nothing went red.
        note(`The configuration does not acknowledge a non-loopback bind. Re-run: \`keryx serve config set --bind <addr> ${ACK_FLAG}\``);
      }
      if (!runtimeAck) {
        note(`This invocation did not acknowledge a non-loopback bind. Re-run: \`keryx serve ${ACK_FLAG}\``);
      }
    }
    return;
  }

  const { listener } = outcome;
  // Machine-parseable, and the only way a caller that passed `--port 0` learns
  // which port the OS chose.
  //
  // The address is sanitized as defence only: this line is reached only after
  // the kernel accepted the address, and an address containing a control
  // character does not resolve, so no test can drive hostile bytes here.
  console.log(`  ${style.green(symbols.ok)} listening on http://${authorityOf(listener.address)}:${listener.port}`);
  console.log(`    ${style.dim(`profile ${sanitizeForDisplay(config!.profile)} · routes GET /v1/status, GET /v1/projects · Ctrl-C to drain`)}`);
  if (!isLoopbackAddress(listener.address)) {
    console.log(`  ${style.yellow(symbols.bullet)} this bind is reachable beyond loopback and there is no TLS in this release`);
  }

  await new Promise<void>((resolve) => {
    let draining = false;
    const finish = (): void => {
      if (draining) {
        return;
      }
      draining = true;
      console.log(`  ${style.dim("draining…")}`);
      void listener.drain().then(() => {
        console.log(`  ${style.green(symbols.ok)} stopped`);
        resolve();
      });
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

/** A per-run view of the stored configuration. Nothing here is persisted. */
function overlay(stored: ServeConfig, parsed: ParsedArgs, port: number | undefined, runtimeAck: boolean): ServeConfig {
  return {
    ...stored,
    bind: {
      address: parsed.values.get("--bind") ?? stored.bind.address,
      port: port ?? stored.bind.port,
      // BOTH halves are required — security-policy.md §Network exposure:
      // "Requires an explicit flag AND a configuration acknowledgement. Either
      // alone is a startup refused." Folding them into one value keeps that on
      // a single code path in resolveServeStartup rather than duplicating the
      // rule here.
      acknowledgeNonLoopback: stored.bind.acknowledgeNonLoopback === true && runtimeAck,
    },
    profile: parsed.values.get("--profile") ?? stored.profile,
  };
}

/**
 * The address as it must appear in a URL authority.
 *
 * An IPv6 literal has to be bracketed or the port colon is ambiguous:
 * `http://::1:43013` is not a parseable URL, and the process-level harness that
 * reads the port back off this line could not match it either.
 */
function authorityOf(address: string): string {
  const clean = sanitizeForDisplay(address);
  if (clean.includes(":") && !clean.startsWith("[")) {
    return `[${clean}]`;
  }
  return clean;
}

/**
 * Validate a flag whose value must be non-blank.
 *
 * At the CLI level deliberately: without it the schema writer refuses the
 * config and the operator is told "could not write the serve configuration",
 * which names neither the flag nor the problem.
 */
function requireNonBlank(flag: string, value: string | undefined): boolean {
  if (value !== undefined && value.trim().length === 0) {
    fail(`${flag} must not be empty`);
    return false;
  }
  return true;
}

/** `undefined` when absent, `"invalid"` when unusable, else the number. */
function readPort(raw: string | undefined, options: { allowEphemeral: boolean }): number | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    return "invalid";
  }
  const port = Number(raw);
  const minimum = options.allowEphemeral ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65535) {
    return "invalid";
  }
  return port;
}

// ---------------------------------------------------------------------------
// keryx serve status
// ---------------------------------------------------------------------------

function runStatus(args: string[]): void {
  const parsed = parseArgs(args, [], ["--json"]);
  if (!parsed.ok) {
    console.error(parsed.message);
    printHelp();
    process.exitCode = 1;
    return;
  }
  const asJson = parsed.parsed.flags.has("--json");

  const warnings: string[] = [];
  const config = loadServeConfig(undefined, (message) => warnings.push(message));
  const credential = readServeCredential();
  const report = describeServeStatus({ config, credential, configState: serveConfigState() });

  const credentialState = credential.status === "ok" ? "present" : credential.status;
  const fingerprint = credential.status === "ok" ? credentialFingerprint(credential.record) : undefined;

  if (asJson) {
    // No token, no credential id, no salt, no hash: a fingerprint is the most a
    // status surface is entitled to (security-policy.md §Exposure in status).
    console.log(
      JSON.stringify(
        {
          ...report,
          credential: credentialState,
          ...(fingerprint === undefined ? {} : { credentialFingerprint: fingerprint }),
          // NOT stripped, deliberately, and for the reason recorded on the R4a
          // JSON projection: JSON escapes a control character rather than
          // emitting it, so the consumer receives valid JSON and decides for
          // itself. Stripping here would silently alter a value a machine
          // consumer is entitled to see intact. The human path below strips,
          // because a terminal does not escape anything.
          warnings: [...warnings].sort(),
        },
        null,
        2,
      ),
    );
    return;
  }

  for (const message of warnings) {
    warn(message);
  }
  console.log(`  state:      ${sanitizeForDisplay(report.state)}`);
  if (report.bind !== undefined) {
    const reach = report.nonLoopback ? "non-loopback" : "loopback";
    console.log(`  bind:       ${sanitizeForDisplay(report.bind.address)}:${report.bind.port} (${reach})`);
  }
  if (report.profile !== undefined) {
    console.log(`  profile:    ${sanitizeForDisplay(report.profile)}`);
  }
  console.log(`  credential: ${credentialState}${fingerprint === undefined ? "" : ` (fingerprint ${fingerprint})`}`);
  console.log(`  pending approvals: ${report.pendingApprovals}`);
  if (report.message !== undefined) {
    console.log("");
    console.log(`  ${style.yellow(symbols.bullet)} ${sanitizeForDisplay(report.message)}`);
  }
  if (report.state === "stopped") {
    // `stopped` covers FOUR different situations, not two. `describeServeStatus`
    // reports `stopped` when the config is null (absent, malformed, or
    // unreadable) AND when it is valid-but-disabled. An earlier version
    // special-cased `absent` and told the other three "present but disabled" —
    // a false diagnosis for two of them, with an instruction that exited 1 when
    // followed. `serveConfigAdvice` is the one place that decides.
    const state = serveConfigState();
    note(
      state === "absent"
        ? "Nothing is listening. `keryx serve config init` then `keryx serve token issue` to set one up."
        : `Nothing is listening: ${serveConfigAdvice(state)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// keryx serve token
// ---------------------------------------------------------------------------

function runToken(args: string[]): void {
  const sub = args[0];
  const rest = parseArgs(args.slice(1), [], []);
  if (!rest.ok) {
    console.error(rest.message);
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (sub === "issue") {
    const result = issueServeToken(undefined, undefined, warn);
    if (!result.ok) {
      fail(sanitizeForDisplay(result.message));
      return;
    }
    printTokenOnce(result.token);
    pointConfigurationAt(result.record.id);
    return;
  }

  if (sub === "rotate") {
    const result = rotateServeToken(undefined, undefined, warn);
    if (!result.ok) {
      fail(sanitizeForDisplay(result.message));
      return;
    }
    if (result.replacedId !== null) {
      console.log(`  ${style.green(symbols.ok)} the previous credential is no longer valid`);
    }
    printTokenOnce(result.token);
    pointConfigurationAt(result.record.id);
    return;
  }

  if (sub === "revoke") {
    const outcome = revokeServeToken(undefined, warn);
    if (outcome === "not-found") {
      fail("no serve credential exists to revoke");
      return;
    }
    if (outcome === "write-failed") {
      fail(`the credential is still valid: ${sanitizeForDisplay(serveCredentialPath())} could not be written`);
      return;
    }
    console.log(`  ${style.green(symbols.ok)} credential revoked`);
    return;
  }

  console.error(sub === undefined ? "Missing token subcommand" : `Unknown token command: ${sanitizeForDisplay(sub)}`);
  printHelp();
  process.exitCode = 1;
}

/**
 * The only place in this codebase that prints a serve token.
 *
 * There is no second one, and there cannot be: nothing stores the token, so no
 * other code path has one to print.
 */
function printTokenOnce(token: string): void {
  console.log(`  token: ${token}`);
  console.log(`  ${style.yellow(symbols.bullet)} This is shown once. It is stored only as a salted hash and cannot be recovered.`);
}

/**
 * Keep `serve.json` pointing at the credential that actually exists.
 *
 * Without this, `token rotate` would leave the configuration referencing a
 * credential id that no longer exists, and startup would refuse — turning a
 * routine rotation into an outage the operator has to debug.
 */
function pointConfigurationAt(credentialId: string): void {
  const config = loadServeConfig(undefined, warn);
  if (config === null || config.credentialRef.id === credentialId) {
    return;
  }
  const updated: ServeConfig = { ...config, credentialRef: { ...config.credentialRef, id: credentialId } };
  if (!saveServeConfig(updated, undefined, warn)) {
    // NOT a warning, and not exit 0. The credential has already been replaced,
    // so the install is now in a state where no token works and the server will
    // refuse to start. A success exit code here sent the operator away believing
    // a routine rotation had succeeded.
    //
    // The recovery is `token rotate` ALONE. An earlier version of this message
    // told the operator to run `keryx serve config init` first; a security
    // review followed that instruction on a customised deployment and recorded
    // bind, port, profile and the non-loopback acknowledgement all resetting to
    // defaults. `rotate` re-mints and re-points in one operation and preserves
    // every one of them — pinned by `serve.recovery.test.ts`.
    fail(
      `the credential was replaced but ${sanitizeForDisplay(serveConfigPath())} could not be updated, so the server will refuse to start. ` +
        `Fix the file's permissions and re-run \`keryx serve token rotate\`.`,
    );
    return;
  }
  console.log(`  ${style.dim("the serve configuration now references this credential")}`);
}

// ---------------------------------------------------------------------------
// keryx serve config
// ---------------------------------------------------------------------------

function runConfig(args: string[]): void {
  const sub = args[0];

  if (sub === "init") {
    const parsed = parseArgs(args.slice(1), BIND_FLAGS, [ACK_FLAG, FORCE_FLAG]);
    if (!parsed.ok) {
      console.error(parsed.message);
      printHelp();
      process.exitCode = 1;
      return;
    }

    // `init` names a first-run operation and behaved like an unconditional
    // overwrite. A security review ran it on a customised deployment and
    // recorded bind, port, profile and the acknowledgement resetting to
    // defaults at exit 0, with nothing saying a configuration had been replaced.
    //
    // The state is read through `serveConfigState`, not through
    // `loadServeConfig(...) !== null`. That first version conflated "malformed"
    // with "unreadable", so a valid configuration the process could not read was
    // replaced without `--force` — destroyed by the guard meant to protect it.
    // `malformed` is the only existing state that may be overwritten freely,
    // because refusing there leaves the operator with a broken file the CLI
    // cannot repair.
    const state = serveConfigState();
    if (state !== "absent" && state !== "malformed" && !parsed.parsed.flags.has(FORCE_FLAG)) {
      fail(
        `${sanitizeForDisplay(serveConfigPath())} already exists${state === "unreadable" ? " and could not be read" : ""}. ` +
          // `<setting>` deliberately: a bare `keryx serve config set` exits 1
          // with "nothing to set", so this is a usage form and must read as one.
          // The class guard skips spans carrying a placeholder for exactly that
          // reason, and counts what it skipped rather than dropping it silently.
          `\`keryx serve config set <setting>\` changes one setting without touching the rest; ` +
          `${FORCE_FLAG} replaces the whole file with defaults.`,
      );
      return;
    }
    const port = readPort(parsed.parsed.values.get("--port"), { allowEphemeral: false });
    if (port === "invalid") {
      fail("--port must be an integer between 1 and 65535");
      return;
    }
    if (!requireNonBlank("--bind", parsed.parsed.values.get("--bind"))) {
      return;
    }
    if (!requireNonBlank("--profile", parsed.parsed.values.get("--profile"))) {
      return;
    }

    const credential = readServeCredential();
    // A configuration can legitimately precede the credential. The reference is
    // a placeholder until `token issue` repoints it, and startup refuses in the
    // meantime rather than authenticating against something else.
    const credentialId = credential.status === "ok" ? credential.record.id : randomUUID();

    const config = defaultServeConfig(credentialId, {
      address: parsed.parsed.values.get("--bind") ?? DEFAULT_SERVE_BIND_ADDRESS,
      port: port ?? DEFAULT_SERVE_PORT,
      profile: parsed.parsed.values.get("--profile") ?? DEFAULT_SERVE_PROFILE,
      acknowledgeNonLoopback: parsed.parsed.flags.has(ACK_FLAG),
    });
    if (!saveServeConfig(config, undefined, warn)) {
      fail("could not write the serve configuration");
      return;
    }

    console.log(`  ${style.green(symbols.ok)} wrote ${sanitizeForDisplay(serveConfigPath())}`);
    printConfig(config);
    if (!isLoopbackAddress(config.bind.address)) {
      console.log(
        `  ${style.yellow(symbols.bullet)} this bind is reachable beyond loopback; ${config.bind.acknowledgeNonLoopback === true ? `\`keryx serve\` still needs ${ACK_FLAG}` : "it is not acknowledged and will refuse to start"}`,
      );
    }
    if (credential.status !== "ok") {
      note("No credential yet. Run `keryx serve token issue` — the token is printed once and never again.");
    }
    return;
  }

  if (sub === "set") {
    runConfigSet(args.slice(1));
    return;
  }

  if (sub === "show") {
    const parsed = parseArgs(args.slice(1), [], ["--json"]);
    if (!parsed.ok) {
      console.error(parsed.message);
      printHelp();
      process.exitCode = 1;
      return;
    }
    const config = loadServeConfig(undefined, warn);
    if (config === null) {
      // Not a bare `config init`: on an unreadable file that command refuses,
      // so the instruction has to come from the state. Same source as every
      // other site.
      note(serveConfigAdvice(serveConfigState()));
      return;
    }
    if (parsed.parsed.flags.has("--json")) {
      // Safe by construction: the projection cannot carry an undeclared key, so
      // there is nothing here a raw token could be hiding in.
      console.log(JSON.stringify(config, null, 2));
      return;
    }
    printConfig(config);
    return;
  }

  console.error(sub === undefined ? "Missing config subcommand" : `Unknown config command: ${sanitizeForDisplay(sub)}`);
  printHelp();
  process.exitCode = 1;
}

/**
 * `keryx serve config set` — change named settings and preserve the rest.
 *
 * This exists because every refusal `keryx serve` can print is reachable ONLY
 * when a configuration already exists, and the instructions all pointed at
 * `config init`. Once `init` refused to clobber, those instructions failed when
 * followed; adding `--force` to them made them succeed by destroying the
 * deployment they were meant to repair. A review reproduced both. An operator
 * needs a way to change one setting, so here it is, and every instruction now
 * names it.
 */
function runConfigSet(args: string[]): void {
  const parsed = parseArgs(args, BIND_FLAGS, [ACK_FLAG, NO_ACK_FLAG, ENABLE_FLAG, DISABLE_FLAG]);
  if (!parsed.ok) {
    console.error(parsed.message);
    printHelp();
    process.exitCode = 1;
    return;
  }
  const { values, flags } = parsed.parsed;

  // Contradictory flags are refused rather than resolved by order — the same
  // rule the argv parser applies to a repeated flag, and for the same reason.
  if (flags.has(ACK_FLAG) && flags.has(NO_ACK_FLAG)) {
    fail(`${ACK_FLAG} and ${NO_ACK_FLAG} cannot both be given`);
    return;
  }
  if (flags.has(ENABLE_FLAG) && flags.has(DISABLE_FLAG)) {
    fail(`${ENABLE_FLAG} and ${DISABLE_FLAG} cannot both be given`);
    return;
  }
  if (values.size === 0 && flags.size === 0) {
    fail("nothing to set. Name at least one of --bind, --port, --profile, --acknowledge-non-loopback, --enable, --disable");
    return;
  }

  const state = serveConfigState();
  if (state === "absent") {
    fail("there is no serve configuration to change. Run `keryx serve config init` to create one.");
    return;
  }
  const existing = loadServeConfig(undefined, warn);
  if (existing === null) {
    // `malformed` or `unreadable`: patching what cannot be read would silently
    // invent the fields it could not see.
    fail(serveConfigAdvice(state));
    return;
  }

  const port = readPort(values.get("--port"), { allowEphemeral: false });
  if (port === "invalid") {
    fail("--port must be an integer between 1 and 65535");
    return;
  }
  if (!requireNonBlank("--bind", values.get("--bind"))) {
    return;
  }
  if (!requireNonBlank("--profile", values.get("--profile"))) {
    return;
  }

  // An acknowledgement is about ONE address. Carrying it across a `--bind` that
  // names a different one silently authorises a bind the operator never
  // acknowledged: a review moved a configuration from an acknowledged
  // 10.0.0.5 to 203.0.113.9 and watched `acknowledgeNonLoopback: true` follow it
  // with no warning, while `config init --bind 203.0.113.9` correctly wrote
  // false. security-policy.md requires the acknowledgement to be explicit, and
  // an inherited one is not.
  const rebinding = values.has("--bind") && values.get("--bind") !== existing.bind.address;
  const acknowledge = flags.has(ACK_FLAG)
    ? true
    : flags.has(NO_ACK_FLAG)
      ? false
      : rebinding
        ? false
        : existing.bind.acknowledgeNonLoopback;
  const updated: ServeConfig = {
    ...existing,
    enabled: flags.has(ENABLE_FLAG) ? true : flags.has(DISABLE_FLAG) ? false : existing.enabled,
    bind: {
      address: values.get("--bind") ?? existing.bind.address,
      port: port ?? existing.bind.port,
      ...(acknowledge === undefined ? {} : { acknowledgeNonLoopback: acknowledge }),
    },
    profile: values.get("--profile") ?? existing.profile,
  };

  if (!saveServeConfig(updated, undefined, warn)) {
    fail(`could not write ${sanitizeForDisplay(serveConfigPath())}; nothing was changed`);
    return;
  }
  console.log(`  ${style.green(symbols.ok)} updated ${sanitizeForDisplay(serveConfigPath())}`);
  printConfig(updated);
  if (rebinding && existing.bind.acknowledgeNonLoopback === true && !flags.has(ACK_FLAG) && !flags.has(NO_ACK_FLAG)) {
    // Dropping it silently would be the same failure in the other direction:
    // the operator's next `keryx serve` would refuse and they would not know why.
    console.log(
      `  ${style.yellow(symbols.bullet)} the non-loopback acknowledgement did not carry over to a new address; re-run with ${ACK_FLAG} if this one is intended`,
    );
  }
  if (!isLoopbackAddress(updated.bind.address) && updated.bind.acknowledgeNonLoopback !== true) {
    console.log(
      `  ${style.yellow(symbols.bullet)} this bind is reachable beyond loopback and is not acknowledged; it will refuse to start`,
    );
  }
}

function printConfig(config: ServeConfig): void {
  console.log(`  enabled:    ${config.enabled}`);
  console.log(`  bind:       ${sanitizeForDisplay(config.bind.address)}:${config.bind.port}`);
  console.log(`  profile:    ${sanitizeForDisplay(config.profile)}`);
  console.log(`  credential: ${sanitizeForDisplay(config.credentialRef.store)} ref ${sanitizeForDisplay(config.credentialRef.id)}`);
  console.log(`  approvals:  expire after ${config.approval.expirySeconds}s, max ${config.approval.maxPendingPerSession} pending per session`);
  console.log(`  non-loopback acknowledged: ${config.bind.acknowledgeNonLoopback === true}`);
}

// ---------------------------------------------------------------------------

function printHelp(): void {
  helpTitle("keryx serve", "loopback-bound HTTP entry over this install (off by default)");
  helpUsage([
    `keryx serve [--bind <addr>] [--port <n>] [--profile <name>] [${ACK_FLAG}]`,
    "keryx serve status [--json]",
    "keryx serve token issue | rotate | revoke",
    `keryx serve config init [--bind <addr>] [--port <n>] [--profile <name>] [${ACK_FLAG}] [${FORCE_FLAG}]`,
    `keryx serve config set [--bind <addr>] [--port <n>] [--profile <name>] [${ACK_FLAG}|${NO_ACK_FLAG}] [${ENABLE_FLAG}|${DISABLE_FLAG}]`,
    "keryx serve config show [--json]",
  ]);
  helpOptions([
    { flag: "--bind <addr>", desc: "Bind address. Loopback unless acknowledged; default 127.0.0.1." },
    { flag: "--port <n>", desc: "Port. 0 selects an ephemeral port when starting the server." },
    { flag: "--profile <name>", desc: "Name of the remote policy profile to report." },
    { flag: ACK_FLAG, desc: "Acknowledge a bind reachable beyond loopback. Needed on BOTH config and run." },
    { flag: NO_ACK_FLAG, desc: "Withdraw the acknowledgement (`config set` only). Changing --bind withdraws it too." },
    { flag: ENABLE_FLAG, desc: "Enable the configuration (`config set` only)." },
    { flag: DISABLE_FLAG, desc: "Disable it without deleting it (`config set` only)." },
    { flag: "status", desc: "State, bind, profile, non-loopback flag and pending-approval count." },
    { flag: "token issue", desc: "Mint a credential. The token is printed once and never again." },
    { flag: "token rotate", desc: "Mint a new credential and invalidate the previous one." },
    { flag: "token revoke", desc: "Invalidate the credential." },
    { flag: "config init", desc: "Write the user-global serve configuration. Refuses to replace one without --force." },
    { flag: "config set", desc: "Change named settings and preserve the rest. The non-destructive way to fix a configuration." },
    { flag: FORCE_FLAG, desc: "Replace an existing configuration on `config init`. It is not merged." },
    { flag: "config show", desc: "Print the configuration. It holds a credential reference, never a token." },
  ]);
  note("Routes in this release: GET /v1/status and GET /v1/projects, both authenticated. Nothing else is reachable, and no turn can be submitted.");
}
