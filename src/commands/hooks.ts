// `keryx hooks` (flow 306, W6, T8) — the CLI over the `keryx shell` lifecycle
// hook runtime (`src/harness/hooks/`): list the merged/resolved registration
// set, validate the two config files, run one hook standalone against a
// synthetic or captured payload, and flip a registration's `enabled` state in
// the project or user config file.
//
// This module writes nothing outside `.metaproject/hooks.json` (project
// scope, default) and `<home>/.keryx/hooks.json` (user scope, `--user`), and
// only from `hooks enable`/`hooks disable`. `list`/`validate`/`test` are
// read-only (`test` spawns the hook's own command, which may itself write —
// that is the hook's business, not this command's).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { optionValue } from "../lib/args";
import { ContainedWriteError, mkdirContained, writeContained } from "../lib/contained-write";
import { confirm as realConfirm } from "../lib/prompt";
import { resolveHooksHomeDir, resolveHooksProjectRoot } from "./agent-hooks";
import { bothStreamsAreATerminal } from "./mcp-servers";
import {
  BUILTIN_HOOK_IDS,
  BUILTIN_HOOK_REGISTRATIONS,
  GATE_DISABLE_ACKNOWLEDGEMENT,
  HOOK_EVENT_NAMES,
  LEARNING_OBSERVER_EVENT_KIND,
  NOOP_IMPACT_EVIDENCE_PROVIDER,
  NOOP_LEARNING_OBSERVATION_SINK,
  PROJECT_HOOKS_REL,
  buildHookEnv,
  buildHookStdin,
  createRealHookRunner,
  describeProjectHookForApproval,
  extractFilePathsFromToolInput,
  failureEffect,
  isDisableOverride,
  isIsolationRequired,
  isProtectedBuiltinClass,
  loadHookConfig,
  loadHooksTrustStore,
  parseHookResult,
  projectHooksDigestOfDoc,
  projectHooksTrustKey,
  projectHooksTrustState,
  recordProjectHooksTrust,
  resolveBuiltinCommandRunsIn,
  resolveKeryxArgv,
  revokeProjectHooksTrust,
  validateHookConfigDocument,
} from "../harness/hooks";
import type {
  HookAnomalyName,
  HookClass,
  HookEventName,
  HookFailureKind,
  HookProcessRunner,
  HookRegistration,
  HookScope,
  ImpactEvidenceProvider,
  LearningObservationSink,
  ProjectHooksTrustState,
} from "../harness/hooks";
import type { PolicyOutcome, PolicyProfileId } from "../harness/policy/types";
import packageJson from "../../package.json" with { type: "json" };

const CLI_VERSION = packageJson.version as string;

const VALID_PROFILES: readonly PolicyProfileId[] = ["read-only-review", "monitored-trusted-local", "unattended-untrusted"];
const DEFAULT_PROFILE: PolicyProfileId = "monitored-trusted-local";

/** Injectable seams for `hooks test`'s in-process builtin ports, and for tests. */
export interface HooksCommandDeps {
  cwd?: string;
  homeDir?: string;
  now?: () => Date;
  runner?: HookProcessRunner;
  learningSink?: LearningObservationSink;
  impactEvidence?: ImpactEvidenceProvider;
  /** R700-01: where the trust store lives. Omitted reads/writes the real per-user config dir (hermetic under `bun test` — see `test-preload.ts`). */
  configDir?: string;
  /** R700-01: whether `hooks trust` may prompt. Defaults to `bothStreamsAreATerminal(process.stdin, process.stdout)`. */
  isInteractive?: boolean;
  /** R700-01: the yes/no prompt `hooks trust` asks in a TTY. Defaults to `lib/prompt.ts`'s `confirm`. */
  confirm?: (question: string) => Promise<boolean>;
}

// Review finding 11: shared with `buildShellHookRuntime` (`./agent-hooks.ts`)
// so a real session and `keryx hooks` resolve `~/.keryx/hooks.json` to the
// SAME path — this used to be its own KERYX_HOME-aware copy while the
// runtime read `os.homedir()` unconditionally.
function resolveHomeDir(deps: HooksCommandDeps): string {
  return resolveHooksHomeDir(process.env, deps.homeDir);
}

// Review finding 11: shared with `buildShellHookRuntime`'s callers (e.g.
// `commands/shell.ts`) so `keryx hooks` invoked from a subdirectory resolves
// `.metaproject/hooks.json` against the same PROJECT ROOT a live session
// would — this used to use the raw `cwd` directly.
function resolveCwdProjectRoot(deps: HooksCommandDeps): string {
  return resolveHooksProjectRoot(deps.cwd ?? process.cwd());
}

/** `exactOptionalPropertyTypes`-safe spread: omits the key entirely when `deps.configDir` is undefined, rather than passing `configDir: undefined`. */
function optConfigDir(deps: HooksCommandDeps): { configDir?: string } {
  return deps.configDir !== undefined ? { configDir: deps.configDir } : {};
}

function userHooksPath(homeDir: string): string {
  return path.join(homeDir, ".keryx", "hooks.json");
}

function projectHooksPath(projectRoot: string): string {
  return path.join(projectRoot, ".metaproject", "hooks.json");
}

function fail(message: string): never {
  console.error(message);
  process.exitCode = 1;
  throw new HooksCommandExit();
}

/** Thrown to unwind to `hooksCommand`'s own catch after `fail()` has already set the message + exit code. */
class HooksCommandExit extends Error {}

async function runGuarded(fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof HooksCommandExit) return;
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

/** One row of `keryx hooks list`'s output — one per distinct id, `events` grouping every event it is registered on. */
export interface HooksListRow {
  id: string;
  events: HookEventName[];
  matcher: string;
  class: HookClass;
  scope: HookScope;
  enabled: boolean;
  appliesToChildAgents: boolean;
  timeoutMs: number;
  /**
   * The `runsIn` this hook ACTUALLY spawns with under `profileId` (flow 306,
   * W6, T15) — for a built-in command hook this can differ from its
   * registration's own `runsIn` (always `"sandbox"`), because
   * `resolveBuiltinCommandRunsIn` runs it unsandboxed off a profile that does
   * not require fail-closed isolation. A user/project hook's `runsIn` is
   * always identical to its registration's.
   */
  runsIn: "sandbox" | "unsandboxed";
  /**
   * Flow 306 fix round 2 (finding F): true when this row's `runsIn` would
   * actually be REFUSED by the runner under `profileId` — `runsIn ===
   * "unsandboxed"` while the profile's `requiredControls.isolation ===
   * "required-fail-closed"` (`isIsolationRequired`, the SAME predicate
   * `runner.ts` refuses on and `hooks test` now passes through). Before this,
   * `list` reported `runsIn: "unsandboxed"` for such a row with nothing
   * saying the hook would never actually spawn that way.
   */
  refused: boolean;
  /** `{kind:"command", argv}` for a spawned hook, `{kind:"builtin", name}` for the two in-process built-ins. */
  handler: { kind: "command"; argv: string[] } | { kind: "builtin"; name: string };
  description?: string;
  /** R700-01: present only for a project-scope row. */
  trust?: "trusted" | "untrusted" | "changed";
}

function groupById(registrations: readonly HookRegistration[], profileId: PolicyProfileId): HooksListRow[] {
  const byId = new Map<string, HooksListRow>();
  for (const reg of registrations) {
    const existing = byId.get(reg.id);
    if (existing !== undefined) {
      if (!existing.events.includes(reg.event)) existing.events.push(reg.event);
      continue;
    }
    byId.set(reg.id, {
      id: reg.id,
      events: [reg.event],
      matcher: reg.matcher,
      class: reg.class,
      scope: reg.scope,
      enabled: reg.enabled,
      appliesToChildAgents: reg.appliesToChildAgents,
      timeoutMs: reg.timeoutMs,
      runsIn: resolveBuiltinCommandRunsIn(reg, profileId),
      refused: resolveBuiltinCommandRunsIn(reg, profileId) === "unsandboxed" && isIsolationRequired(profileId),
      handler:
        reg.handler.kind === "command"
          ? { kind: "command", argv: reg.handler.argv }
          : { kind: "builtin", name: reg.handler.name },
      ...(reg.description !== undefined ? { description: reg.description } : {}),
    });
  }
  return [...byId.values()];
}

function renderListText(rows: readonly HooksListRow[], profileId: PolicyProfileId): string {
  const lines = rows.map((row) => {
    const command = row.handler.kind === "command" ? row.handler.argv.join(" ") : `builtin:${row.handler.name}`;
    const trustLine =
      row.scope === "project"
        ? [`  scope=project trust=${row.trust === "changed" ? "changed since trusted" : (row.trust ?? "untrusted")} class=${row.class}`]
        : [];
    return [
      `${row.id}`,
      `  scope=${row.scope} class=${row.class} enabled=${String(row.enabled)} appliesToChildAgents=${String(row.appliesToChildAgents)}`,
      ...trustLine,
      `  events=${row.events.join(",")} matcher=${row.matcher} timeoutMs=${row.timeoutMs}`,
      `  runsIn=${row.runsIn}${row.refused ? " REFUSED (profile requires fail-closed isolation)" : ""} (effective under profile "${profileId}"; command hooks only)`,
      `  command: ${command}`,
    ].join("\n");
  });
  return lines.join("\n\n");
}

async function runList(args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = resolveCwdProjectRoot(deps);
  const homeDir = resolveHomeDir(deps);
  const asJson = args.includes("--json");
  const profileArg = optionValue([...args], "--profile");
  const profileId: PolicyProfileId = (profileArg as PolicyProfileId | undefined) ?? DEFAULT_PROFILE;
  if (!VALID_PROFILES.includes(profileId)) {
    fail(`Unknown --profile "${String(profileArg)}". Valid: ${VALID_PROFILES.join(", ")}.`);
  }

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir, projectTrust: { ...optConfigDir(deps) } });
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics, asJson);
    process.exitCode = 1;
    return;
  }

  const rows = groupById(loaded.registrations, profileId).sort((a, b) => a.id.localeCompare(b.id));
  // R700-01: an untrusted/changed project hook is absent from `registrations`
  // (and so from `rows`) — `list` still shows it, marked, so the operator
  // can see it exists and decide whether to trust it, rather than it simply
  // vanishing from the output with no trace.
  const untrustedRows =
    loaded.projectHooks.state === "untrusted" || loaded.projectHooks.state === "changed"
      ? groupById(loaded.projectHooks.hooks, profileId).map((row) => ({
          ...row,
          trust: loaded.projectHooks.state === "changed" ? ("changed" as const) : ("untrusted" as const),
        }))
      : [];
  const trustedRows = rows.map((row) => (row.scope === "project" ? { ...row, trust: "trusted" as const } : row));
  const allRows = [...trustedRows, ...untrustedRows].sort((a, b) => a.id.localeCompare(b.id));

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          profileId,
          hooks: allRows,
          projectTrust: {
            state: loaded.projectHooks.state,
            file: loaded.projectHooks.filePath,
            ...(loaded.projectHooks.digest !== undefined ? { digest: loaded.projectHooks.digest } : {}),
          },
          warnings: loaded.warnings.map((w) => w.message),
          disabledBuiltinGates: loaded.disabledBuiltinGates,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (loaded.projectHooks.state === "untrusted" || loaded.projectHooks.state === "changed") {
    const reason = loaded.projectHooks.state === "changed" ? "changed since trusted" : "not trusted";
    console.error(
      `Project hooks in ${loaded.projectHooks.filePath} are not trusted and do not run (${reason}). Review and trust them with: keryx hooks trust`,
    );
  }
  console.log(renderListText(allRows, profileId));
  for (const w of loaded.warnings) console.error(w.message);
  for (const g of loaded.disabledBuiltinGates) {
    console.error(`keryx hooks: built-in gate ${g.id} is OFF (disabled in ${g.file}). Turn it back on with: keryx hooks enable ${g.id} --user`);
  }
}

// ---------------------------------------------------------------------------
// validate
// ---------------------------------------------------------------------------

interface ArgvResolution {
  hookId: string;
  argv0: string;
  resolved: boolean;
}

/** Best-effort, no-execution check of whether `argv0` would resolve: `keryx` always does; an absolute path is stat'd; anything else is searched on `PATH`. */
function argv0Resolves(argv0: string): boolean {
  if (argv0 === "keryx") return true;
  if (path.isAbsolute(argv0)) return existsSync(argv0);
  const pathEnv = process.env.PATH ?? "";
  return pathEnv
    .split(path.delimiter)
    .filter((dir) => dir.length > 0)
    .some((dir) => existsSync(path.join(dir, argv0)));
}

function checkArgvResolutions(registrations: readonly HookRegistration[]): ArgvResolution[] {
  const seen = new Set<string>();
  const out: ArgvResolution[] = [];
  for (const reg of registrations) {
    if (reg.handler.kind !== "command") continue;
    const argv0 = reg.handler.argv[0];
    if (argv0 === undefined) continue;
    const key = `${reg.id}:${argv0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ hookId: reg.id, argv0, resolved: argv0Resolves(argv0) });
  }
  return out;
}

function printDiagnostics(diagnostics: readonly { code: string; message: string; scope: string }[], asJson: boolean): void {
  if (asJson) {
    console.log(JSON.stringify({ ok: false, diagnostics }, null, 2));
    return;
  }
  for (const d of diagnostics) {
    console.error(`[${d.scope}] ${d.code}: ${d.message}`);
  }
}

/**
 * `--ci` is accepted for pipelines that want a stable, machine-friendly
 * invocation without also requiring `--json`: it changes no exit-code or
 * validation behavior. Exit is non-zero on any diagnostic (schema-invalid,
 * invalid-json, unknown-schema-version, a built-in id collision, or a
 * duplicate full-registration id) in both modes; an unresolved `argv[0]` is
 * always a warning, never a reason to fail — best-effort, no execution, per
 * the design doc.
 */
async function runValidate(args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = resolveCwdProjectRoot(deps);
  const homeDir = resolveHomeDir(deps);
  const asJson = args.includes("--json");
  args.includes("--ci"); // accepted, documented above; no behavioral effect beyond what --json already gives.

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir, projectTrust: { ...optConfigDir(deps) } });
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics, asJson);
    process.exitCode = 1;
    return;
  }

  const argvWarnings = checkArgvResolutions(loaded.registrations).filter((r) => !r.resolved);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          hookCount: loaded.registrations.length,
          argvWarnings,
          projectTrust: { state: loaded.projectHooks.state, file: loaded.projectHooks.filePath, digest: loaded.projectHooks.digest },
          warnings: loaded.warnings.map((w) => w.message),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`OK: ${loaded.registrations.length} hook registration(s) across both files loaded and validated.`);
  console.log(`Project hooks: ${loaded.projectHooks.state}`);
  for (const warning of argvWarnings) {
    console.log(`WARNING: ${warning.hookId}: argv[0] "${warning.argv0}" did not resolve (absolute path or PATH lookup).`);
  }
  for (const w of loaded.warnings) console.log(`WARNING: ${w.message}`);
}

// ---------------------------------------------------------------------------
// test
// ---------------------------------------------------------------------------

function synthesizePayload(event: HookEventName, profileId: PolicyProfileId, cwd: string): Record<string, unknown> {
  const sessionId = "hooks-test-session";
  const runId = "hooks-test-run";
  const base = { sessionId, runId };
  switch (event) {
    case "SessionStart":
      return { ...base, projectRoot: cwd, policyProfile: profileId };
    case "UserPromptSubmit":
      return { ...base, prompt: "Synthetic prompt from `keryx hooks test`." };
    case "PreToolUse":
      return {
        ...base,
        toolCallId: "hooks-test-call-1",
        toolName: "Bash",
        toolInput: { command: "echo hooks-test" },
        risk: "low",
        policyProfile: profileId,
      };
    case "PostToolUse":
      return {
        ...base,
        toolCallId: "hooks-test-call-1",
        toolName: "Bash",
        toolInput: { command: "echo hooks-test" },
        toolOutput: { stdout: "hooks-test\n" },
        policyDecision: "allow",
      };
    case "PostToolUseFailure":
      return {
        ...base,
        toolCallId: "hooks-test-call-1",
        toolName: "Bash",
        toolInput: { command: "echo hooks-test" },
        error: { message: "synthetic failure from `keryx hooks test`", code: "TEST" },
      };
    case "PreCompact":
      return { ...base, reason: "manual", tokenCount: 1000 };
    case "Stop":
      return { ...base, stopReason: "hooks-test" };
    case "SubagentStart":
      return {
        ...base,
        subagentId: "hooks-test-subagent",
        parentSessionId: sessionId,
        spawnKind: "internal",
        inheritedHookIds: [],
      };
    case "SubagentStop":
      return { ...base, subagentId: "hooks-test-subagent", outcome: "completed" };
    case "SessionEnd":
      return { ...base, endReason: "normal" };
  }
}

const MAX_TEST_OUTPUT_CHARS = 4000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEST_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEST_OUTPUT_CHARS), truncated: true };
}

export interface HooksTestReport {
  hookId: string;
  event: HookEventName;
  class: HookClass;
  decision?: PolicyOutcome;
  exitCode?: number | null;
  stdout?: string;
  stdoutTruncated?: boolean;
  stderr?: string;
  stderrTruncated?: boolean;
  durationMs: number;
  failure?: HookFailureKind;
  /** What the composed lifecycle would do under `profileId` given this outcome — only present on a failure. */
  effect?: "deny" | "proceed" | "silent-approve";
  effectReason?: HookAnomalyName;
  additionalContext?: string;
  /** W8 warnings that never rose to a decision (fix round 4, F-004) — e.g. a rejected out-of-root path. */
  warnings?: string[];
  /**
   * The `runsIn` this invocation actually spawned with (flow 306, W6, T15) —
   * present only for a `command`-handler hook. For a built-in it reflects
   * `resolveBuiltinCommandRunsIn(reg, profileId)`, which can differ from the
   * registration's own `runsIn` under a profile that does not require
   * fail-closed isolation.
   */
  runsIn?: "sandbox" | "unsandboxed";
}

async function runOneCommandHook(
  reg: HookRegistration,
  event: HookEventName,
  payload: Record<string, unknown>,
  cwd: string,
  profileId: PolicyProfileId,
  deps: HooksCommandDeps,
): Promise<HooksTestReport> {
  const now = deps.now ?? (() => new Date());
  const runner = deps.runner ?? createRealHookRunner({ projectRoot: cwd });
  const stdinObj = buildHookStdin(event, payload, { hookId: reg.id, timestamp: now().toISOString(), projectRoot: cwd });
  const env = buildHookEnv({
    processEnv: process.env,
    ...(reg.handler.kind === "command" && reg.handler.env !== undefined ? { commandEnv: reg.handler.env } : {}),
    hookEvent: event,
    hookId: reg.id,
    sessionId: "hooks-test-session",
    runId: "hooks-test-run",
    projectRoot: cwd,
    policyProfile: profileId,
  });
  if (reg.handler.kind !== "command") throw new Error("runOneCommandHook requires a command handler");
  const argv = resolveKeryxArgv(reg.handler.argv);
  const effectiveRunsIn = resolveBuiltinCommandRunsIn(reg, profileId);
  // Flow 306 fix round 2 (finding F): `hooks test` used to omit
  // `isolationRequired` entirely, so a project/user hook explicitly
  // configured `runsIn: "unsandboxed"` would actually SPAWN under
  // `unattended-untrusted` (or any profile requiring fail-closed isolation)
  // here, while a live session's `runtime.ts` refuses that exact same call
  // (`req.isolationRequired === true`). Same `isIsolationRequired` helper,
  // same runner, same refusal (`spawnError: "refused"` -> `failure:
  // "refused"`) — `hooks test` can no longer report success on a call that
  // would never actually run.
  const isolationRequired = isIsolationRequired(profileId);
  const raw = await runner.run({
    argv,
    cwd: reg.handler.cwd ?? ".",
    env,
    stdin: JSON.stringify(stdinObj),
    timeoutMs: reg.timeoutMs,
    network: reg.network,
    runsIn: effectiveRunsIn,
    isolationRequired,
  });
  const parsed = parseHookResult(
    {
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      timedOut: raw.timedOut,
      ...(raw.spawnError !== undefined ? { spawnError: raw.spawnError } : {}),
    },
    { cls: reg.class, event },
  );
  const stdoutCapped = truncate(raw.stdout);
  const stderrCapped = truncate(raw.stderr);
  const report: HooksTestReport = {
    hookId: reg.id,
    event,
    class: reg.class,
    exitCode: raw.exitCode,
    stdout: stdoutCapped.text,
    stdoutTruncated: stdoutCapped.truncated,
    stderr: stderrCapped.text,
    stderrTruncated: stderrCapped.truncated,
    durationMs: raw.durationMs,
    runsIn: effectiveRunsIn,
  };
  if (parsed.kind === "ok") {
    return {
      ...report,
      ...(parsed.decision !== undefined ? { decision: parsed.decision } : {}),
      ...(parsed.additionalContext !== undefined ? { additionalContext: parsed.additionalContext } : {}),
    };
  }
  const effect = failureEffect({ cls: reg.class, event, failure: parsed.failure, profileId });
  return { ...report, failure: parsed.failure, effect: effect.effect, effectReason: effect.reason };
}

async function runOneBuiltinHook(
  reg: HookRegistration,
  event: HookEventName,
  payload: Record<string, unknown>,
  cwd: string,
  profileId: PolicyProfileId,
  deps: HooksCommandDeps,
): Promise<HooksTestReport> {
  if (reg.handler.kind !== "builtin") throw new Error("runOneBuiltinHook requires a builtin handler");
  const startedAt = Date.now();
  const base = { hookId: reg.id, event, class: reg.class };

  if (reg.handler.name === "learning-observer") {
    const kind = (LEARNING_OBSERVER_EVENT_KIND as Partial<Record<HookEventName, string>>)[event];
    const sink = deps.learningSink ?? NOOP_LEARNING_OBSERVATION_SINK;
    try {
      if (kind !== undefined) {
        await sink.record({
          kind: kind as never,
          sessionId: "hooks-test-session",
          runId: "hooks-test-run",
          timestamp: (deps.now ?? (() => new Date()))().toISOString(),
          payload,
        });
      }
      return { ...base, durationMs: Date.now() - startedAt };
    } catch (err) {
      const effect = failureEffect({ cls: reg.class, event, failure: "crash", profileId });
      return {
        ...base,
        durationMs: Date.now() - startedAt,
        failure: "crash",
        effect: effect.effect,
        effectReason: effect.reason,
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (reg.handler.name === "impact-evidence") {
    const provider = deps.impactEvidence ?? NOOP_IMPACT_EVIDENCE_PROVIDER;
    // Fix round 4, F-004: the same extractor a live `PreToolUse` fire uses
    // (`runtime.ts`'s `extractFilePathsFromToolInput`) — previously this read
    // only `toolInput.filePath`, so a dry run of a real `apply_patch`-shaped
    // payload (`{patch}`) or a `file_path`/`path`-shaped one tested a
    // different (empty, falling back to a synthetic name) file set than the
    // runtime would actually gate.
    const extracted = extractFilePathsFromToolInput(payload.toolInput);
    const files = extracted.length > 0 ? extracted : ["hooks-test-synthetic-file.ts"];
    try {
      const result = await provider.evidenceFor({
        sessionId: "hooks-test-session",
        files,
        toolName: typeof payload.toolName === "string" ? payload.toolName : "Write",
        projectRoot: cwd,
        firstEditInSession: true,
      });
      return {
        ...base,
        durationMs: Date.now() - startedAt,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
        ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
        ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      };
    } catch (err) {
      const effect = failureEffect({ cls: reg.class, event, failure: "crash", profileId });
      return {
        ...base,
        durationMs: Date.now() - startedAt,
        failure: "crash",
        effect: effect.effect,
        effectReason: effect.reason,
        stderr: err instanceof Error ? err.message : String(err),
      };
    }
  }

  throw new Error(`Unknown builtin hook handler "${reg.handler.name}".`);
}

async function runTest(args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = resolveCwdProjectRoot(deps);
  const homeDir = resolveHomeDir(deps);
  const id = args[0];
  if (id === undefined || id.startsWith("--")) {
    fail("Usage: keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]");
  }
  const asJson = args.includes("--json");
  const eventArg = optionValue([...args], "--event");
  const payloadFileArg = optionValue([...args], "--payload-file");
  const profileArg = optionValue([...args], "--profile");
  const profileId: PolicyProfileId = (profileArg as PolicyProfileId | undefined) ?? DEFAULT_PROFILE;
  if (!VALID_PROFILES.includes(profileId)) {
    fail(`Unknown --profile "${String(profileArg)}". Valid: ${VALID_PROFILES.join(", ")}.`);
  }
  if (eventArg !== undefined && !HOOK_EVENT_NAMES.includes(eventArg as HookEventName)) {
    fail(`Unknown --event "${eventArg}". Valid: ${HOOK_EVENT_NAMES.join(", ")}.`);
  }

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir, projectTrust: { ...optConfigDir(deps) } });
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics, asJson);
    process.exitCode = 1;
    return;
  }

  const matches = loaded.registrations.filter((r) => r.id === id);
  if (matches.length === 0) {
    // D8: an untrusted/changed project hook is agent-reachable and spawns a
    // real command — running it on "operator request" through `hooks test`
    // would be exactly the bypass D5/D6 exist to close. It is absent from
    // `registrations` (why `matches` is empty above); check `projectHooks`
    // to give a precise refusal instead of the generic "unknown id".
    const untrustedMatch = loaded.projectHooks.hooks.find((r) => r.id === id);
    if (untrustedMatch !== undefined) {
      fail(
        `Hook "${String(id)}" comes from ${loaded.projectHooks.filePath}, which is not trusted, so it does not run. Review and trust the file with: keryx hooks trust`,
      );
    }
    fail(`Unknown hook id "${String(id)}". Run \`keryx hooks list\` to see registered ids.`);
  }

  let reg: HookRegistration;
  if (eventArg !== undefined) {
    const found = matches.find((r) => r.event === eventArg);
    if (found === undefined) {
      fail(`Hook "${String(id)}" is not registered on event "${eventArg}". Registered on: ${matches.map((r) => r.event).join(", ")}.`);
    }
    reg = found as HookRegistration;
  } else if (matches.length === 1) {
    reg = matches[0] as HookRegistration;
  } else {
    fail(
      `Hook "${String(id)}" is registered on ${matches.length} events (${matches
        .map((r) => r.event)
        .join(", ")}); pass --event <name> to pick one.`,
    );
  }

  let payload: Record<string, unknown>;
  if (payloadFileArg !== undefined) {
    let raw: string;
    try {
      raw = readFileSync(payloadFileArg, "utf8");
    } catch (err) {
      fail(`Could not read --payload-file "${payloadFileArg}": ${err instanceof Error ? err.message : String(err)}`);
    }
    // Review finding 18: same double-error bug as `readDoc` — the shape
    // check's own `fail()` must not be caught by the JSON.parse `catch`
    // below, or a "must contain a JSON object" failure gets misreported as
    // "is not valid JSON" on top of it.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      fail(`--payload-file "${payloadFileArg}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(`--payload-file "${payloadFileArg}" must contain a JSON object.`);
    }
    payload = parsed as Record<string, unknown>;
  } else {
    payload = synthesizePayload(reg.event, profileId, cwd);
  }

  const report =
    reg.handler.kind === "command"
      ? await runOneCommandHook(reg, reg.event, payload, cwd, profileId, deps)
      : await runOneBuiltinHook(reg, reg.event, payload, cwd, profileId, deps);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`hook: ${report.hookId} (${report.event}, class ${report.class})`);
  console.log(`decision: ${report.decision ?? "none"}`);
  if (report.runsIn !== undefined) console.log(`runsIn: ${report.runsIn} (effective under profile "${profileId}")`);
  if (report.exitCode !== undefined) console.log(`exitCode: ${String(report.exitCode)}`);
  if (report.failure !== undefined) console.log(`failure: ${report.failure} -> effect: ${report.effect} (${report.effectReason})`);
  console.log(`durationMs: ${report.durationMs}`);
  if (report.additionalContext !== undefined) console.log(`additionalContext: ${report.additionalContext}`);
  if (report.warnings !== undefined && report.warnings.length > 0) console.log(`warnings: ${report.warnings.join("; ")}`);
  if (report.stdout !== undefined && report.stdout.length > 0) {
    console.log(`stdout:\n${report.stdout}${report.stdoutTruncated ? "\n…(truncated)" : ""}`);
  }
  if (report.stderr !== undefined && report.stderr.length > 0) {
    console.log(`stderr:\n${report.stderr}${report.stderrTruncated ? "\n…(truncated)" : ""}`);
  }
}

// ---------------------------------------------------------------------------
// trust / untrust
// ---------------------------------------------------------------------------

function pluralHook(n: number): string {
  return n === 1 ? "hook" : "hooks";
}

async function runTrust(args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = resolveCwdProjectRoot(deps);
  const homeDir = resolveHomeDir(deps);
  const filePath = projectHooksPath(cwd);
  const yes = args.includes("--yes");

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir, projectTrust: { ...optConfigDir(deps) } });
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics, false);
    fail(`Nothing was trusted: fix ${filePath} first (keryx hooks validate).`);
  }

  const { projectHooks } = loaded;
  if (projectHooks.digest === undefined) {
    console.log(`No command hooks in ${filePath}; nothing to trust.`);
    return;
  }
  if (projectHooks.state === "trusted") {
    console.log(`${filePath} is already trusted.`);
    return;
  }

  const enabledCount = projectHooks.hooks.filter((h) => h.enabled).length;
  const unsandboxed = projectHooks.hooks.filter((h) => h.enabled && h.runsIn === "unsandboxed");
  const lines: string[] = [
    `${filePath} in ${cwd} asks to run ${enabledCount} command ${pluralHook(enabledCount)} in every keryx session opened here:`,
    "",
  ];
  for (const reg of projectHooks.hooks) {
    lines.push(...describeProjectHookForApproval(reg), "");
  }
  if (unsandboxed.length > 0) {
    lines.push(`WARNING: ${unsandboxed.length} hook(s) run UNSANDBOXED, with your full user permissions: ${unsandboxed.map((h) => h.id).join(", ")}.`);
  }
  if (projectHooks.state === "changed") {
    lines.push("This file changed since you last trusted it.");
  }
  console.log(lines.join("\n").trimEnd());

  const isInteractive = deps.isInteractive ?? bothStreamsAreATerminal(process.stdin, process.stdout);
  let accepted: boolean;
  if (yes) {
    accepted = true;
  } else if (!isInteractive) {
    fail("Not trusted: there is no terminal to confirm in. Re-run with --yes to trust exactly the version shown above.");
  } else {
    const ask = deps.confirm ?? realConfirm;
    accepted = await ask(`Trust exactly this version of ${filePath}?`);
  }

  if (!accepted) {
    fail("Nothing was trusted.");
  }

  const result = recordProjectHooksTrust({
    trustRoot: cwd,
    digest: projectHooks.digest,
    hookIds: projectHooks.hooks.map((h) => h.id),
    ...optConfigDir(deps),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  if (!result.ok) {
    fail(result.error);
  }
  console.log(`Trusted ${filePath} (${projectHooks.digest.replace("sha256:", "").slice(0, 12)}). Any change to its hooks needs a new \`keryx hooks trust\`.`);
}

async function runUntrust(_args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = resolveCwdProjectRoot(deps);
  const filePath = projectHooksPath(cwd);
  const result = revokeProjectHooksTrust({ trustRoot: cwd, ...optConfigDir(deps) });
  if (!result.ok) {
    fail(result.error);
  }
  if (result.removed) {
    console.log(`Removed trust for ${filePath}. Its command hooks will not run until you trust it again.`);
  } else {
    console.log(`${filePath} was not trusted; nothing to remove.`);
  }
}

// ---------------------------------------------------------------------------
// enable / disable
// ---------------------------------------------------------------------------

interface ManagedBlock {
  tool: "keryx";
  version: string;
  managedHookIds?: string[];
}

interface HooksDoc {
  schemaVersion: string;
  _keryxManaged?: ManagedBlock;
  hooks: Record<string, unknown[]>;
  [key: string]: unknown;
}

function emptyDoc(): HooksDoc {
  return { schemaVersion: "1.0.0", hooks: {} };
}

function readDoc(filePath: string): HooksDoc {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyDoc();
    }
    fail(`Could not read "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  // Review finding 18: the shape check (`must contain a JSON object`) used to
  // live INSIDE this try, so its own `fail()` (which throws, never returns)
  // was caught by the very same `catch` and re-reported as "is not valid
  // JSON" — a second, WRONG error on top of the real one. Only the actual
  // `JSON.parse` failure is caught here now; the shape check runs after.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`"${filePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    fail(`"${filePath}" must contain a JSON object.`);
  }
  return parsed as HooksDoc;
}

/**
 * Contained, atomic write of `doc` to the project or user hooks file (R700-04).
 * `filePath` is only for the error/refusal message — the actual target is
 * always derived from `scope` + `cwd`/`homeDir` through `writeContained`, so
 * a symlink at `.metaproject/hooks.json` (or `<home>/.keryx/hooks.json`)
 * that resolves outside its root is refused rather than followed.
 *
 * User scope: `<homeDir>/.keryx` may not exist yet (a fresh operator who has
 * never run `hooks disable --user` before) — create it with `mkdirContained`
 * ONLY when absent, so an existing `.keryx` that is itself a symlink (e.g.
 * into a dotfiles repo) is left alone rather than re-created.
 */
async function writeDocAtomic(filePath: string, doc: HooksDoc, scope: HookScope, cwd: string, homeDir: string): Promise<void> {
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  try {
    if (scope === "project") {
      await writeContained(cwd, PROJECT_HOOKS_REL, body);
    } else {
      const userConfigDir = path.join(homeDir, ".keryx");
      if (!existsSync(userConfigDir)) {
        await mkdirContained(homeDir, ".keryx");
      }
      await writeContained(userConfigDir, "hooks.json", body);
    }
  } catch (err) {
    if (err instanceof ContainedWriteError) {
      fail(`Refusing to write ${filePath}: ${err.message}. Nothing was written.`);
    }
    throw err;
  }
}

function addManagedId(doc: HooksDoc, id: string): void {
  const existing = doc._keryxManaged?.managedHookIds ?? [];
  const managedHookIds = existing.includes(id) ? existing : [...existing, id];
  doc._keryxManaged = { tool: "keryx", version: CLI_VERSION, managedHookIds };
}

function removeManagedId(doc: HooksDoc, id: string): void {
  if (doc._keryxManaged === undefined) return;
  const managedHookIds = (doc._keryxManaged.managedHookIds ?? []).filter((existing) => existing !== id);
  doc._keryxManaged = { tool: "keryx", version: CLI_VERSION, managedHookIds };
}

function isManagedId(doc: HooksDoc, id: string): boolean {
  return (doc._keryxManaged?.managedHookIds ?? []).includes(id);
}

/** Which of the ten event keys a built-in id is registered on (fixed, from `builtins.ts`). */
function builtinEventsFor(id: string): HookEventName[] {
  return BUILTIN_HOOK_REGISTRATIONS.filter((reg) => reg.id === id).map((reg) => reg.event);
}

function validateBeforeWrite(doc: HooksDoc, scope: HookScope, label: string): void {
  const validated = validateHookConfigDocument(doc, scope, label);
  if (!validated.valid) {
    const messages = validated.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ");
    fail(`Refusing to write "${label}" — result would be invalid: ${messages}`);
  }
}

function builtinClassFor(id: string): HookClass | undefined {
  return BUILTIN_HOOK_REGISTRATIONS.find((reg) => reg.id === id)?.class;
}

async function disableBuiltin(
  doc: HooksDoc,
  id: string,
  filePath: string,
  scope: HookScope,
  acknowledgeGateRisk: boolean,
  userFilePath: string,
  cwd: string,
  homeDir: string,
): Promise<void> {
  // D12: a project file can never disable a built-in GATE, and a user file
  // needs the explicit `--acknowledge-gate-risk` flag — mirrors the runtime's
  // own tighten-only rule (`resolveHookRegistrations`) so the CLI refuses the
  // exact same thing the runtime would silently ignore with a warning.
  const cls = builtinClassFor(id);
  if (cls !== undefined && isProtectedBuiltinClass(cls)) {
    if (scope === "project") {
      fail(
        `Refusing to disable built-in gate "${id}" in ${filePath}: a project file cannot turn off a built-in gate. To turn it off for yourself only, run: keryx hooks disable ${id} --user --acknowledge-gate-risk`,
      );
    }
    if (!acknowledgeGateRisk) {
      fail(
        `Refusing to disable built-in gate "${id}" without --acknowledge-gate-risk: it stops this check in every project you open. Re-run with --user --acknowledge-gate-risk if you mean it.`,
      );
    }
  }
  const override: Record<string, unknown> =
    cls !== undefined && isProtectedBuiltinClass(cls) ? { id, enabled: false, acknowledge: GATE_DISABLE_ACKNOWLEDGEMENT } : { id, enabled: false };
  const events = builtinEventsFor(id);
  for (const event of events) {
    const list = doc.hooks[event] ?? [];
    const alreadyOverridden = list.some((raw) => isDisableOverride(raw) && (raw as { id: string }).id === id);
    doc.hooks[event] = alreadyOverridden ? list : [...list, override];
  }
  addManagedId(doc, id);
  validateBeforeWrite(doc, scope, filePath);
  await writeDocAtomic(filePath, doc, scope, cwd, homeDir);
  if (cls !== undefined && isProtectedBuiltinClass(cls)) {
    console.log(`Disabled built-in gate "${id}" for every project you open (in ${userFilePath}). keryx shell says so at the start of each session. Turn it back on with: keryx hooks enable ${id} --user`);
  } else {
    console.log(`Disabled built-in hook "${id}" in ${filePath}.`);
  }
}

async function enableBuiltin(doc: HooksDoc, id: string, filePath: string, scope: HookScope, cwd: string, homeDir: string): Promise<void> {
  const events = builtinEventsFor(id);
  const hasOverrideSomewhere = events.some((event) =>
    (doc.hooks[event] ?? []).some((raw) => isDisableOverride(raw) && (raw as { id: string }).id === id),
  );
  if (!hasOverrideSomewhere) {
    console.log(`Hook "${id}" is already enabled (no disable override present in ${filePath}); nothing to do.`);
    return;
  }
  if (!isManagedId(doc, id)) {
    fail(
      `Refusing to enable "${id}": its disable override in ${filePath} is not Keryx-managed (not in _keryxManaged.managedHookIds), so it looks hand-authored. Remove it by hand if that is what you want.`,
    );
  }
  for (const event of events) {
    const list = doc.hooks[event];
    if (list === undefined) continue;
    doc.hooks[event] = list.filter((raw) => !(isDisableOverride(raw) && (raw as { id: string }).id === id));
    if (doc.hooks[event]?.length === 0) delete doc.hooks[event];
  }
  removeManagedId(doc, id);
  validateBeforeWrite(doc, scope, filePath);
  await writeDocAtomic(filePath, doc, scope, cwd, homeDir);
  console.log(`Enabled built-in hook "${id}" in ${filePath} (removed the Keryx-managed disable override).`);
}

/**
 * Locate EVERY full (non-override) registration entry for `id` anywhere in
 * `doc.hooks`, mutably — a hand-authored hook can be registered on several
 * events under the same `id` (review finding 12 / AC12: enable/disable must
 * change the `enabled` field "on every event it is registered on"), so this
 * returns one entry per event it appears on, not just the first.
 */
function findFullRegistrations(doc: HooksDoc, id: string): Array<{ event: string; index: number; entry: Record<string, unknown> }> {
  const found: Array<{ event: string; index: number; entry: Record<string, unknown> }> = [];
  for (const [event, list] of Object.entries(doc.hooks)) {
    for (let index = 0; index < list.length; index += 1) {
      const raw = list[index];
      if (isDisableOverride(raw)) continue;
      if (typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).id === id) {
        found.push({ event, index, entry: raw as Record<string, unknown> });
      }
    }
  }
  return found;
}

/**
 * Review finding 12 (AC12, updated wording): toggle ONLY the `enabled` field
 * of the named hand-authored hook, on EVERY event it is registered on — not
 * just the first one found (the bug: an id registered on several events used
 * to have only its first-encountered entry edited, silently leaving the
 * others at their old `enabled` value). Every other field of every matched
 * entry is preserved by spreading `entry` first; no entry is removed,
 * reordered, or otherwise edited; entries under OTHER ids are untouched.
 */
async function setProjectOrUserHookEnabled(
  doc: HooksDoc,
  id: string,
  enabled: boolean,
  filePath: string,
  scope: HookScope,
  cwd: string,
  homeDir: string,
  deps: HooksCommandDeps,
): Promise<void> {
  const found = findFullRegistrations(doc, id);
  if (found.length === 0) {
    fail(`Unknown hook id "${id}": not a built-in and not defined in ${filePath}.`);
  }

  // D13: was the file trusted (under its digest BEFORE this edit) right
  // before this write? Only meaningful for the project scope — trust is
  // never tracked for the user file.
  const wasTrustedBefore =
    scope === "project" ? projectHooksDigestOfDoc(doc) !== undefined && projectFileTrustState(doc, cwd, deps) === "trusted" : false;

  for (const { event, index, entry } of found) {
    const list = doc.hooks[event] as unknown[];
    list[index] = { ...entry, enabled };
  }
  addManagedId(doc, id);
  validateBeforeWrite(doc, scope, filePath);
  await writeDocAtomic(filePath, doc, scope, cwd, homeDir);
  console.log(
    `${enabled ? "Enabled" : "Disabled"} hook "${id}" in ${filePath} (${found.length} event${found.length === 1 ? "" : "s"}).`,
  );

  if (scope !== "project") return;
  const newDigest = projectHooksDigestOfDoc(doc);
  if (wasTrustedBefore && newDigest !== undefined) {
    const hookIds = projectFullRegistrationIds(doc);
    const result = recordProjectHooksTrust({ trustRoot: cwd, digest: newDigest, hookIds, ...optConfigDir(deps) });
    if (result.ok) {
      console.log(`Trust for ${filePath} carried over to the new version because it was trusted before this change.`);
    }
  } else {
    console.log(`Note: the command hooks in ${filePath} are not trusted and do not run. Review and trust them with: keryx hooks trust`);
  }
}

/** The current trust state of the PROJECT file, given its in-memory doc (before or after an edit). */
function projectFileTrustState(doc: HooksDoc, cwd: string, deps: HooksCommandDeps): ProjectHooksTrustState {
  const digest = projectHooksDigestOfDoc(doc);
  if (digest === undefined) return "none";
  const store = loadHooksTrustStore(deps.configDir);
  return projectHooksTrustState(projectHooksTrustKey(cwd), digest, store);
}

function projectFullRegistrationIds(doc: HooksDoc): string[] {
  const ids: string[] = [];
  for (const list of Object.values(doc.hooks)) {
    for (const raw of list) {
      if (isDisableOverride(raw)) continue;
      if (typeof raw === "object" && raw !== null && typeof (raw as Record<string, unknown>).id === "string") {
        ids.push((raw as Record<string, unknown>).id as string);
      }
    }
  }
  return ids;
}

async function runEnableDisable(action: "enable" | "disable", args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = resolveCwdProjectRoot(deps);
  const homeDir = resolveHomeDir(deps);
  const useUser = args.includes("--user");
  const id = args.find((a) => !a.startsWith("--"));
  if (id === undefined) {
    fail(`Usage: keryx hooks ${action} <id> [--user] [--acknowledge-gate-risk]`);
  }
  const scope: HookScope = useUser ? "user" : "project";
  const filePath = useUser ? userHooksPath(homeDir) : projectHooksPath(cwd);
  const doc = readDoc(filePath);
  if (doc.schemaVersion === undefined) doc.schemaVersion = "1.0.0";
  if (doc.hooks === undefined) doc.hooks = {};

  const isBuiltin = BUILTIN_HOOK_IDS.includes(id);
  if (isBuiltin) {
    if (action === "disable") {
      await disableBuiltin(doc, id, filePath, scope, args.includes("--acknowledge-gate-risk"), userHooksPath(homeDir), cwd, homeDir);
    } else {
      await enableBuiltin(doc, id, filePath, scope, cwd, homeDir);
    }
    return;
  }
  await setProjectOrUserHookEnabled(doc, id, action === "enable", filePath, scope, cwd, homeDir, deps);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export async function hooksCommand(args: string[] = [], deps: HooksCommandDeps = {}): Promise<void> {
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHooksHelp();
    return;
  }
  const rest = args.slice(1);
  await runGuarded(async () => {
    if (command === "list") {
      await runList(rest, deps);
      return;
    }
    if (command === "validate") {
      await runValidate(rest, deps);
      return;
    }
    if (command === "test") {
      await runTest(rest, deps);
      return;
    }
    if (command === "enable") {
      await runEnableDisable("enable", rest, deps);
      return;
    }
    if (command === "disable") {
      await runEnableDisable("disable", rest, deps);
      return;
    }
    if (command === "trust") {
      await runTrust(rest, deps);
      return;
    }
    if (command === "untrust") {
      await runUntrust(rest, deps);
      return;
    }
    console.error(`Unknown hooks subcommand: ${command}`);
    printHooksHelp();
    process.exitCode = 1;
  });
}

export function printHooksHelp(): void {
  console.log(`keryx hooks — the \`keryx shell\` lifecycle hook runtime: list, validate, test, trust, enable, disable

Usage:
  keryx hooks list [--json]
  keryx hooks validate [--json] [--ci]
  keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]
  keryx hooks trust [--yes]                     Show every command in .metaproject/hooks.json and trust exactly that version
  keryx hooks untrust                           Withdraw trust; project command hooks stop running
  keryx hooks enable <id> [--user]
  keryx hooks disable <id> [--user] [--acknowledge-gate-risk]

Config files (project overrides user overrides built-in):
  .metaproject/hooks.json   project scope, version-controlled
  ~/.keryx/hooks.json       user scope, across projects (--user targets this)

\`list\` prints the merged, resolved registration set — with no config files
present, exactly the five built-ins (keryx.ctx-guard, keryx.security-check-input,
keryx.security-check-output, keryx.learning-observer, keryx.impact-evidence), all
enabled. \`validate\` checks both files against the schema, rejects an id
colliding with a built-in, and best-effort checks (no execution) that each
command's argv[0] resolves. \`test\` runs one hook once through the real runner
against a synthetic or --payload-file payload and reports its decision, exit
code, stdout/stderr, duration and failure class. \`enable\`/\`disable\` flip a
registration's enabled state in the target file, tracked in that file's
_keryxManaged.managedHookIds so a hand-authored entry is never touched.

Project command hooks in .metaproject/hooks.json run only after \`keryx hooks
trust\`; any change to the file revokes trust and it must be trusted again. A
project file can never disable a built-in gate (keryx.ctx-guard,
keryx.security-check-input, keryx.security-check-output, keryx.impact-evidence);
only \`keryx hooks disable <id> --user --acknowledge-gate-risk\` can, for
yourself, in every project you open.
`);
}
