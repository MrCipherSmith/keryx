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
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { optionValue } from "../lib/args";
import {
  BUILTIN_HOOK_IDS,
  BUILTIN_HOOK_REGISTRATIONS,
  HOOK_EVENT_NAMES,
  LEARNING_OBSERVER_EVENT_KIND,
  NOOP_IMPACT_EVIDENCE_PROVIDER,
  NOOP_LEARNING_OBSERVATION_SINK,
  buildHookEnv,
  buildHookStdin,
  createRealHookRunner,
  failureEffect,
  loadHookConfig,
  parseHookResult,
  resolveKeryxArgv,
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
}

function resolveHomeDir(deps: HooksCommandDeps): string {
  if (deps.homeDir !== undefined) return deps.homeDir;
  const fromEnv = process.env.KERYX_HOME;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : homedir();
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
  /** `{kind:"command", argv}` for a spawned hook, `{kind:"builtin", name}` for the two in-process built-ins. */
  handler: { kind: "command"; argv: string[] } | { kind: "builtin"; name: string };
  description?: string;
}

function groupById(registrations: readonly HookRegistration[]): HooksListRow[] {
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
      handler:
        reg.handler.kind === "command"
          ? { kind: "command", argv: reg.handler.argv }
          : { kind: "builtin", name: reg.handler.name },
      ...(reg.description !== undefined ? { description: reg.description } : {}),
    });
  }
  return [...byId.values()];
}

function renderListText(rows: readonly HooksListRow[]): string {
  const lines = rows.map((row) => {
    const command = row.handler.kind === "command" ? row.handler.argv.join(" ") : `builtin:${row.handler.name}`;
    return [
      `${row.id}`,
      `  scope=${row.scope} class=${row.class} enabled=${String(row.enabled)} appliesToChildAgents=${String(row.appliesToChildAgents)}`,
      `  events=${row.events.join(",")} matcher=${row.matcher} timeoutMs=${row.timeoutMs}`,
      `  command: ${command}`,
    ].join("\n");
  });
  return lines.join("\n\n");
}

async function runList(args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = resolveHomeDir(deps);
  const asJson = args.includes("--json");

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir });
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics, asJson);
    process.exitCode = 1;
    return;
  }

  const rows = groupById(loaded.registrations).sort((a, b) => a.id.localeCompare(b.id));
  if (asJson) {
    console.log(JSON.stringify({ hooks: rows }, null, 2));
  } else {
    console.log(renderListText(rows));
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
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = resolveHomeDir(deps);
  const asJson = args.includes("--json");
  args.includes("--ci"); // accepted, documented above; no behavioral effect beyond what --json already gives.

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir });
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
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log(`OK: ${loaded.registrations.length} hook registration(s) across both files loaded and validated.`);
  for (const warning of argvWarnings) {
    console.log(`WARNING: ${warning.hookId}: argv[0] "${warning.argv0}" did not resolve (absolute path or PATH lookup).`);
  }
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
  const raw = await runner.run({
    argv,
    cwd: reg.handler.cwd ?? ".",
    env,
    stdin: JSON.stringify(stdinObj),
    timeoutMs: reg.timeoutMs,
    network: reg.network,
    runsIn: reg.runsIn,
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
    const filePath = typeof (payload.toolInput as Record<string, unknown> | undefined)?.filePath === "string"
      ? ((payload.toolInput as Record<string, unknown>).filePath as string)
      : "hooks-test-synthetic-file.ts";
    try {
      const result = await provider.evidenceFor({
        sessionId: "hooks-test-session",
        filePath,
        toolName: typeof payload.toolName === "string" ? payload.toolName : "Write",
        projectRoot: cwd,
        firstEditInSession: true,
      });
      return {
        ...base,
        durationMs: Date.now() - startedAt,
        ...(result.decision !== undefined ? { decision: result.decision } : {}),
        ...(result.additionalContext !== undefined ? { additionalContext: result.additionalContext } : {}),
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
  const cwd = deps.cwd ?? process.cwd();
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

  const loaded = loadHookConfig({ projectRoot: cwd, homeDir });
  if (!loaded.ok) {
    printDiagnostics(loaded.diagnostics, asJson);
    process.exitCode = 1;
    return;
  }

  const matches = loaded.registrations.filter((r) => r.id === id);
  if (matches.length === 0) {
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
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        fail(`--payload-file "${payloadFileArg}" must contain a JSON object.`);
      }
      payload = parsed as Record<string, unknown>;
    } catch (err) {
      fail(`--payload-file "${payloadFileArg}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
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
  if (report.exitCode !== undefined) console.log(`exitCode: ${String(report.exitCode)}`);
  if (report.failure !== undefined) console.log(`failure: ${report.failure} -> effect: ${report.effect} (${report.effectReason})`);
  console.log(`durationMs: ${report.durationMs}`);
  if (report.additionalContext !== undefined) console.log(`additionalContext: ${report.additionalContext}`);
  if (report.stdout !== undefined && report.stdout.length > 0) {
    console.log(`stdout:\n${report.stdout}${report.stdoutTruncated ? "\n…(truncated)" : ""}`);
  }
  if (report.stderr !== undefined && report.stderr.length > 0) {
    console.log(`stderr:\n${report.stderr}${report.stderrTruncated ? "\n…(truncated)" : ""}`);
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
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(`"${filePath}" must contain a JSON object.`);
    }
    return parsed as HooksDoc;
  } catch (err) {
    fail(`"${filePath}" is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Atomic temp+rename write, creating the parent directory when absent. */
function writeDocAtomic(filePath: string, doc: HooksDoc): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const body = `${JSON.stringify(doc, null, 2)}\n`;
  const temp = `${filePath}.${process.pid}.tmp`;
  writeFileSync(temp, body, "utf8");
  renameSync(temp, filePath);
}

function isDisableOverride(raw: unknown): raw is { id: string; enabled: false } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return keys.length === 2 && keys[0] === "enabled" && keys[1] === "id" && record.enabled === false && typeof record.id === "string";
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

function disableBuiltin(doc: HooksDoc, id: string, filePath: string, scope: HookScope): void {
  const events = builtinEventsFor(id);
  for (const event of events) {
    const list = doc.hooks[event] ?? [];
    const alreadyOverridden = list.some((raw) => isDisableOverride(raw) && (raw as { id: string }).id === id);
    doc.hooks[event] = alreadyOverridden ? list : [...list, { id, enabled: false }];
  }
  addManagedId(doc, id);
  validateBeforeWrite(doc, scope, filePath);
  writeDocAtomic(filePath, doc);
  console.log(`Disabled built-in hook "${id}" in ${filePath}.`);
}

function enableBuiltin(doc: HooksDoc, id: string, filePath: string, scope: HookScope): void {
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
  writeDocAtomic(filePath, doc);
  console.log(`Enabled built-in hook "${id}" in ${filePath} (removed the Keryx-managed disable override).`);
}

/** Locate a full (non-override) registration entry for `id` anywhere in `doc.hooks`, mutably. */
function findFullRegistration(doc: HooksDoc, id: string): { event: string; index: number; entry: Record<string, unknown> } | undefined {
  for (const [event, list] of Object.entries(doc.hooks)) {
    for (let index = 0; index < list.length; index += 1) {
      const raw = list[index];
      if (isDisableOverride(raw)) continue;
      if (typeof raw === "object" && raw !== null && (raw as Record<string, unknown>).id === id) {
        return { event, index, entry: raw as Record<string, unknown> };
      }
    }
  }
  return undefined;
}

function setProjectOrUserHookEnabled(
  doc: HooksDoc,
  id: string,
  enabled: boolean,
  filePath: string,
  scope: HookScope,
): void {
  const found = findFullRegistration(doc, id);
  if (found === undefined) {
    fail(`Unknown hook id "${id}": not a built-in and not defined in ${filePath}.`);
  }
  const list = doc.hooks[found.event] as unknown[];
  const updatedEntry = { ...found.entry, enabled };
  list[found.index] = updatedEntry;
  addManagedId(doc, id);
  validateBeforeWrite(doc, scope, filePath);
  writeDocAtomic(filePath, doc);
  console.log(`${enabled ? "Enabled" : "Disabled"} hook "${id}" in ${filePath}.`);
}

async function runEnableDisable(action: "enable" | "disable", args: readonly string[], deps: HooksCommandDeps): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const homeDir = resolveHomeDir(deps);
  const useUser = args.includes("--user");
  const id = args.find((a) => !a.startsWith("--"));
  if (id === undefined) {
    fail(`Usage: keryx hooks ${action} <id> [--user]`);
  }
  const scope: HookScope = useUser ? "user" : "project";
  const filePath = useUser ? userHooksPath(homeDir) : projectHooksPath(cwd);
  const doc = readDoc(filePath);
  if (doc.schemaVersion === undefined) doc.schemaVersion = "1.0.0";
  if (doc.hooks === undefined) doc.hooks = {};

  const isBuiltin = BUILTIN_HOOK_IDS.includes(id);
  if (isBuiltin) {
    if (action === "disable") disableBuiltin(doc, id, filePath, scope);
    else enableBuiltin(doc, id, filePath, scope);
    return;
  }
  setProjectOrUserHookEnabled(doc, id, action === "enable", filePath, scope);
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
    console.error(`Unknown hooks subcommand: ${command}`);
    printHooksHelp();
    process.exitCode = 1;
  });
}

export function printHooksHelp(): void {
  console.log(`keryx hooks — the \`keryx shell\` lifecycle hook runtime: list, validate, test, enable, disable

Usage:
  keryx hooks list [--json]
  keryx hooks validate [--json] [--ci]
  keryx hooks test <id> [--event <name>] [--payload-file <path>] [--json] [--profile <id>]
  keryx hooks enable <id> [--user]
  keryx hooks disable <id> [--user]

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
`);
}
