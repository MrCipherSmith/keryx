// `keryx review jev-edit-guard` — flow 343: the Jev EDIT GUARD. A Claude
// Code `PostToolUse` hook that diffs the file an `Edit`/`Write`/`MultiEdit`
// just touched against `HEAD`, checks the changed region against every
// applicable project rule clause with Jev (reusing `computeJevRulesResult`,
// `./review-jev-rules.ts` — the exact same discovery/tagging/pair-selection/
// batching/threshold machinery `keryx review jev-rules` and `/jevrules`
// already run), and feeds violations straight back to the coding agent
// through the hook's own `additionalContext` channel.
//
// FAIL OPEN, ALWAYS: this hook never blocks a tool call and never exits
// non-zero. Disabled, no credential, malformed stdin, an unsupported tool, a
// broken diff, a Jev error, or the hard wall-clock timeout — every one of
// these prints nothing (or, for the credential/opt-in gates, could log a
// line but stays silent to the agent) and exits `0`. Only a real finding
// above threshold ever produces hook output.
//
// Registration in `src/commands/review.ts` is one `if` branch plus one
// import, mirroring `jev-rules`'s own registration.

import path from "node:path";
import { readFile } from "node:fs/promises";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";
import { isPathInside } from "../lib/fs";
import { redactSensitiveText } from "../security/service";
import { JevTimeoutError, resolveJevApiKey } from "../harness/decision/jev-client";
import { hunkRegionsFromDiff } from "../review/conform-state";
import { DEFAULT_CONTEXT_LINES } from "../review/scope";
import {
  DEFAULT_EDIT_GUARD_TIMEOUT_MS,
  filePathFromToolInput,
  isEditGuardToolName,
  renderEditGuardFeedback,
  type EditGuardHookPayload,
} from "../review/jev-edit-guard";
import { readJevEditGuardConfig, readJevEditGuardEnabled, type EditGuardConfigSnapshot } from "../review/jev-edit-guard-config";
import {
  appendEditGuardLog,
  editGuardTodayStats,
  readEditGuardLogRecords,
  recentEditGuardFlags,
  type EditGuardLogFlag,
  type EditGuardLogRecord,
} from "../review/jev-edit-guard-log";
import { computeJevRulesResult, type JevRulesComputedResult } from "./review-jev-rules";
import {
  EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH,
  EDIT_GUARD_HOOK_MATCHER,
  JEV_EDIT_GUARD_SURFACE,
  createSettingsFileOwner,
  editGuardHookCommand,
  installSurfaces,
  uninstallSurfaces,
} from "../integrations/service";

export { EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH, EDIT_GUARD_HOOK_MATCHER, editGuardHookCommand };

const EDIT_GUARD_SETTINGS_OWNER = createSettingsFileOwner(EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH, [JEV_EDIT_GUARD_SURFACE]);

/**
 * `PostToolUse` stdin, read once. Same shape `src/commands/security-
 * impact-evidence.ts`'s own `readStdin` uses (tests inject an async
 * iterable instead of a real piped process).
 */
async function readStdin(source: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One `git diff` attempt; never throws — a non-zero/erroring `git` reads as "no diff" (the caller then treats it as nothing to check, the fail-open reading). */
async function runGit(args: readonly string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { stdout, exitCode };
  } catch {
    return { stdout: "", exitCode: 1 };
  }
}

/**
 * The file's changed region against `HEAD`. Two shapes: a TRACKED file diffs
 * normally; a brand-new file `Write` just created has no `HEAD` blob to diff
 * against at all (`git diff HEAD -- <file>` reads as "nothing changed" for
 * an untracked path, not as an error), so an empty tracked-diff result falls
 * back to `git diff --no-index /dev/null <file>` — the whole new file read
 * as one big addition. `--no-index` exits `1` when it found differences
 * (normal, not a failure) and `0` when it found none; anything else is
 * treated as "no diff" rather than guessed at.
 */
export async function defaultEditGuardFileDiff(root: string, relFile: string, contextLines: number = DEFAULT_CONTEXT_LINES): Promise<string> {
  const tracked = await runGit(["diff", "--no-color", `-U${contextLines}`, "HEAD", "--", relFile], root);
  if (tracked.exitCode === 0 && tracked.stdout.trim().length > 0) return tracked.stdout;
  const untracked = await runGit(["diff", "--no-color", `-U${contextLines}`, "--no-index", "--", "/dev/null", relFile], root);
  if (untracked.exitCode === 0 || untracked.exitCode === 1) return untracked.stdout;
  return "";
}

/**
 * `--fixtures <dir>/jev-responses.json`: a JSON ARRAY, one canned
 * `/systemone` response body per Jev call this invocation makes, consumed in
 * call order — same shape `review-jev-rules.ts`'s own `fixtureJevFetch` uses
 * ("tagging calls first, then violation calls", per its own docs). No
 * network, no real `OPENROUTER_API_KEY` read by this function — but the
 * credential GATE still runs first (a fixture run still needs SOME value in
 * `OPENROUTER_API_KEY`, real or a placeholder, so the demo exercises the
 * same gate the live path does).
 */
export async function fixtureEditGuardFetch(dir: string): Promise<typeof fetch> {
  const raw = await readFile(path.join(dir, "jev-responses.json"), "utf8");
  const responses = JSON.parse(raw) as unknown[];
  let index = 0;
  const fn = async (): Promise<Response> => {
    if (index >= responses.length) {
      throw new Error(`fixture jev-responses.json has only ${responses.length} response(s); a call beyond that was made.`);
    }
    const body = JSON.stringify(responses[index]);
    index += 1;
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };
  return fn as unknown as typeof fetch;
}

export interface EditGuardCliDeps {
  readonly stdin?: AsyncIterable<Buffer | string>;
  readonly fetchFn?: typeof fetch;
  readonly diffFn?: (root: string, relFile: string, contextLines: number) => Promise<string>;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Directory of keryx's own saved config (`auth.json`) for the saved OpenRouter key fallback; defaults to the usual keryx data dir. Tests point it at an empty temp dir so the machine's saved key never leaks in. */
  readonly configDir?: string;
  /** Overrides {@link DEFAULT_EDIT_GUARD_TIMEOUT_MS} — a test's own escape hatch to exercise the fail-open timeout path in milliseconds, not seconds. */
  readonly timeoutMs?: number;
}

type PendingLog = Omit<EditGuardLogRecord, "at" | "latencyMs">;

/**
 * The whole hook, start to finish. Every early return goes through
 * `finish`, which appends the best-effort log line (never lets a log-write
 * failure escape) and always leaves `process.exitCode` at `0`. Nothing here
 * ever throws past this function — the one `try/catch` around the entire
 * body is the fail-open floor beneath every specific gate above it.
 */
export async function runJevEditGuardHook(cwd: string, deps: EditGuardCliDeps = {}): Promise<void> {
  const started = Date.now();
  const env = deps.env ?? process.env;
  const now = (): Date => deps.now?.() ?? new Date();
  // Same steer-proof root anchor `security-impact-evidence.ts`'s hook uses:
  // `CLAUDE_PROJECT_DIR` (set by the harness, not by the tool-call payload)
  // when present, else this process's own cwd.
  const root = env.CLAUDE_PROJECT_DIR ? path.resolve(env.CLAUDE_PROJECT_DIR) : resolveProjectRoot(cwd);

  const finish = async (log: PendingLog): Promise<void> => {
    try {
      await appendEditGuardLog(root, { ...log, at: now().toISOString(), latencyMs: Date.now() - started });
    } catch {
      // Best-effort: a log write failure must never turn a silent, fail-open
      // hook into a noisy or non-zero one.
    }
    process.exitCode = 0;
  };

  let cfg: EditGuardConfigSnapshot | undefined;
  try {
    cfg = await readJevEditGuardConfig(root);
    if (!cfg.enabled) {
      await finish({ file: "(none)", tool: "(none)", status: "skipped", reason: "review.jev.edit_guard is not enabled", jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }
    const apiKey = resolveJevApiKey(env, deps.configDir);
    if (apiKey === undefined || apiKey.length === 0) {
      await finish({ file: "(none)", tool: "(none)", status: "skipped", reason: "no Jev/OpenRouter credential", jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }

    const raw = await readStdin(deps.stdin ?? process.stdin);
    let payload: EditGuardHookPayload;
    try {
      payload = JSON.parse(raw) as EditGuardHookPayload;
    } catch {
      await finish({ file: "(none)", tool: "(none)", status: "error", reason: "stdin was not valid JSON", jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }

    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (!isEditGuardToolName(toolName)) {
      await finish({ file: "(none)", tool: toolName.length > 0 ? toolName : "(unknown)", status: "skipped", reason: `unsupported tool "${toolName}"`, jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }
    const filePathRaw = filePathFromToolInput(payload.tool_input);
    if (filePathRaw === undefined) {
      await finish({ file: "(none)", tool: toolName, status: "skipped", reason: "no file_path in tool_input", jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }

    // Same relative-path-base resolution `security-impact-evidence.ts` uses:
    // an agent-controlled `payload.cwd` is only trusted when it verifiably
    // resolves inside the anchored root; otherwise the root itself is the
    // base for a relative `file_path`.
    let fileBaseDir = root;
    const payloadCwd = typeof payload.cwd === "string" ? payload.cwd : undefined;
    if (payloadCwd !== undefined) {
      const resolvedPayloadCwd = path.resolve(payloadCwd);
      if (resolvedPayloadCwd === root || isPathInside(root, resolvedPayloadCwd)) fileBaseDir = resolvedPayloadCwd;
    }
    const absFile = path.isAbsolute(filePathRaw) ? filePathRaw : path.resolve(fileBaseDir, filePathRaw);
    if (absFile !== root && !isPathInside(root, absFile)) {
      await finish({ file: filePathRaw, tool: toolName, status: "skipped", reason: "file_path resolves outside the project root", jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }
    const relFile = path.relative(root, absFile) || path.basename(absFile);

    const diffFn = deps.diffFn ?? defaultEditGuardFileDiff;
    const diffText = await diffFn(root, relFile, DEFAULT_CONTEXT_LINES);
    const regions = hunkRegionsFromDiff(diffText);
    if (regions.length === 0) {
      await finish({ file: relFile, tool: toolName, status: "clean", reason: "no changed region against HEAD", jevCalls: 0, threshold: cfg.threshold, flags: [] });
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_EDIT_GUARD_TIMEOUT_MS);
    let result: JevRulesComputedResult;
    try {
      result = await computeJevRulesResult({
        cwd: root,
        regions,
        targetLabel: relFile,
        maxCalls: cfg.maxCalls,
        threshold: cfg.threshold,
        fetchFn: deps.fetchFn ?? globalThis.fetch,
        signal: controller.signal,
        // The credential gate above already resolved a key from THIS same
        // `env` (real `process.env`, or a test's injected fixture) — every
        // Jev call `computeJevRulesResult` makes must resolve its credential
        // the same way, never silently fall back to the real `process.env`.
        // The key may have come from keryx's saved config rather than the
        // env, so hand the resolved key down explicitly.
        env: { ...env, OPENROUTER_API_KEY: apiKey },
      });
    } finally {
      clearTimeout(timer);
    }

    const flags: EditGuardLogFlag[] = result.findings.map((finding) => {
      const [ruleId, clauseId] = finding.dedupe_key.split("::");
      // The raw probability is not a separate field on `RuleFinding` — it is
      // embedded in `evidence`'s deterministic
      // "Jev violation probability (max across hunks): 0.NN" line
      // (`synthesizeFindingsFromViolations`, `src/review/jev-rules.ts`).
      // Parsed rather than re-derived: this module never re-scores anything.
      const probabilityMatch = /probability \(max across hunks\): (\d+(?:\.\d+)?)/.exec(finding.evidence);
      const probability = probabilityMatch?.[1] !== undefined ? Number(probabilityMatch[1]) : 0;
      return { ruleId: ruleId ?? finding.dedupe_key, clauseId: clauseId ?? "", file: finding.file, line: finding.line, probability };
    });

    const feedback = renderEditGuardFeedback(result.findings);
    if (feedback !== undefined) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: feedback } }));
    }
    await finish({
      file: relFile,
      tool: toolName,
      status: feedback !== undefined ? "flagged" : "clean",
      jevCalls: result.tokens.jevCalls,
      ...(result.tokens.costUsd !== undefined ? { costUsd: result.tokens.costUsd } : {}),
      threshold: cfg.threshold,
      flags,
    });
  } catch (error) {
    const timedOut = error instanceof JevTimeoutError;
    const threshold = cfg?.threshold ?? (await readJevEditGuardConfig(root).catch(() => undefined))?.threshold ?? 0.5;
    try {
      await appendEditGuardLog(root, {
        at: now().toISOString(),
        file: "(unknown)",
        tool: "(unknown)",
        status: timedOut ? "timeout" : "error",
        reason: redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 500),
        latencyMs: Date.now() - started,
        jevCalls: 0,
        threshold,
        flags: [],
      });
    } catch {
      // Best-effort — see `finish` above.
    }
    process.exitCode = 0;
  }
}

export async function handleInstall(cwd: string): Promise<void> {
  const root = resolveProjectRoot(cwd);
  const { errors } = await installSurfaces(root, EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH, ["jev-edit-guard"], EDIT_GUARD_SETTINGS_OWNER);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ installed: ${EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH} — PostToolUse(${EDIT_GUARD_HOOK_MATCHER}) → \`${editGuardHookCommand()}\``);
  if (!(await readJevEditGuardEnabled(root))) {
    console.log(
      `  note: review.jev.edit_guard is not set in .metaproject/tasks.config.json — the hook is installed but will stay ` +
        `silent (fail-open) until you set {"review":{"jev":{"edit_guard": true}}}, or toggle it with the TUI's /editguard.`,
    );
  }
}

export async function handleUninstall(cwd: string): Promise<void> {
  const root = resolveProjectRoot(cwd);
  const { errors } = await uninstallSurfaces(root, EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH, ["jev-edit-guard"], EDIT_GUARD_SETTINGS_OWNER);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ removed the jev-edit-guard PostToolUse hook from ${EDIT_GUARD_CLAUDE_SETTINGS_RELATIVE_PATH} (other hooks untouched).`);
}

export async function handleStatus(cwd: string, args: string[]): Promise<void> {
  const root = resolveProjectRoot(cwd);
  const cfg = await readJevEditGuardConfig(root);
  const records = await readEditGuardLogRecords(root);
  const stats = editGuardTodayStats(records);
  const recentFlags = recentEditGuardFlags(records, 10);

  if (args.includes("--json")) {
    console.log(JSON.stringify({ config: cfg, today: stats, recentFlags }, null, 2));
    return;
  }
  console.log("# keryx review jev-edit-guard status");
  console.log("");
  console.log(`enabled: ${cfg.enabled}`);
  console.log(`threshold: ${cfg.threshold}`);
  console.log(`max-calls per run: ${cfg.maxCalls}`);
  console.log(`today: ${stats.calls} Jev call(s), ${stats.flagged} flag(s), $${stats.costUsd.toFixed(4)}`);
  console.log("");
  console.log(`## Recent flags (${recentFlags.length})`);
  for (const flag of recentFlags) {
    console.log(`- [${flag.at}] ${flag.file}:${flag.line} — ${flag.ruleId}#${flag.clauseId} (p=${flag.probability.toFixed(2)})`);
  }
}

function printHelp(): void {
  console.log(`keryx review jev-edit-guard

Usage:
  keryx review jev-edit-guard --hook claude [--fixtures <dir>]   Read a PostToolUse hook payload from stdin (used by the installed hook itself)
  keryx review jev-edit-guard install                            Merge-safe install of the Claude Code PostToolUse hook
  keryx review jev-edit-guard uninstall                          Remove it, preserving every other hook entry
  keryx review jev-edit-guard status [--json]                    Enabled/threshold/today's calls, flags, cost

  --fixtures <dir>   Answers every Jev call from <dir>/jev-responses.json (a JSON array, consumed in call order)
                      instead of the network — no OpenRouter key resolves, no call ever leaves this machine.
`);
}

export async function runJevEditGuard(args: string[]): Promise<void> {
  const cwd = process.cwd();
  const hookRuntime = optionValue(args, "--hook");
  if (hookRuntime !== undefined) {
    if (hookRuntime !== "claude") {
      // No codec for any other runtime yet — a reporting gap, not a security
      // decision, so this never fails a tool call closed.
      process.exitCode = 0;
      return;
    }
    const fixturesDir = optionValue(args, "--fixtures");
    await runJevEditGuardHook(cwd, fixturesDir === undefined ? {} : { fetchFn: await fixtureEditGuardFetch(fixturesDir) });
    return;
  }

  const subcommand = args[0];
  switch (subcommand) {
    case "install":
      await handleInstall(cwd);
      return;
    case "uninstall":
      await handleUninstall(cwd);
      return;
    case "status":
      await handleStatus(cwd, args.slice(1));
      return;
    default:
      printHelp();
      if (subcommand !== undefined) process.exitCode = 1;
  }
}
