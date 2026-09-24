// Flow 308 (W8, Lane B, T6): `keryx security impact-evidence` — the CLI
// surface over `src/security/impact-evidence` (core zone). T7 wires this
// handler into `src/commands/security.ts`'s subcommand switch; until then it
// is reachable only by calling `handleImpactEvidence` directly (as this
// file's own tests do).

import {
  computeImpactEvidence,
  createImpactEvidenceProvider,
  hostDeliveryStatus,
  loadSecurityConfig,
  normalizeRequestFiles,
  readLogRecords,
  renderEvidenceBlock,
  resolveImpactEvidenceConfigTrusted,
  verifyConfigChecksum,
  type ImpactEvidenceProfile,
  type ImpactEvidenceRequest,
} from "../security/service";
import { optionValue } from "../lib/args";
import { resolveProjectRoot } from "../lib/contained-path";

/**
 * F13 (review round 1): the real signature reads `process.stdin`; tests
 * inject an async iterable of chunks instead so `handleHook`'s malformed-JSON
 * and provider-throw paths are reachable without a real piped process.
 */
export interface ImpactEvidenceCliDeps {
  stdin?: AsyncIterable<Buffer | string>;
}

async function readStdin(source: AsyncIterable<Buffer | string>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleImpactEvidence(
  cwd: string,
  args: string[],
  deps: ImpactEvidenceCliDeps = {},
): Promise<void> {
  const subcommand = args[0];
  const rest = args.slice(1);

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    printHelp();
    return;
  }

  switch (subcommand) {
    case "status":
      await handleStatus(cwd, rest);
      return;
    case "test":
      await handleTest(cwd, rest);
      return;
    case "hook":
      await handleHook(cwd, rest, deps);
      return;
    default:
      console.error(`Unknown impact-evidence command: ${subcommand}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function handleStatus(cwd: string, args: string[]): Promise<void> {
  const security = await loadSecurityConfig(cwd);
  // F11 (review round 2): `resolveImpactEvidenceConfig` alone takes the
  // declared block on trust — exactly the reading a hand-written, unchecked
  // `security.config.json` exploits. `status` must show what the GATE
  // actually uses, so it goes through the same
  // `resolveImpactEvidenceConfigTrusted` the provider does, and surfaces
  // whether the declared block was trusted at all (and why not, when it
  // wasn't).
  const trustedResult = resolveImpactEvidenceConfigTrusted(security);
  const effective = trustedResult.config;
  const checksum = verifyConfigChecksum(security);
  const killSwitch = process.env.KERYX_DISABLE_IMPACT_GATE === "1" || process.env.KERYX_DISABLE_IMPACT_GATE === "true";
  const host = hostDeliveryStatus();
  const records = await readLogRecords(cwd);
  const recent = records.slice(-20);
  const perSessionTouchCounts: Record<string, number> = {};
  for (const record of records) {
    if (record.event === "injected" || record.event === "dampened") {
      perSessionTouchCounts[record.sessionId] = (perSessionTouchCounts[record.sessionId] ?? 0) + record.files.length;
    }
  }

  if (args.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          schemaVersion: 1,
          config: effective,
          configDeclared: security.impactEvidence !== undefined,
          configChecksum: { match: checksum.match, expected: checksum.expected, actual: checksum.actual },
          configTrusted: !trustedResult.tampered,
          ...(trustedResult.tampered ? { configUntrustedReason: trustedResult.detail } : {}),
          envKillSwitch: killSwitch,
          hostDelivery: host,
          recentLog: recent,
          perSessionTouchCounts,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("# keryx security impact-evidence status");
  console.log("");
  console.log(`enabled: ${effective.enabled}${killSwitch ? " (overridden OFF by KERYX_DISABLE_IMPACT_GATE)" : ""}`);
  console.log(`strict: ${effective.strict}`);
  console.log(`exemptGlobs: ${effective.exemptGlobs.length > 0 ? effective.exemptGlobs.join(", ") : "none"}`);
  console.log(`dampenAfter: ${effective.dampenAfter}`);
  console.log(`config declared impactEvidence block: ${security.impactEvidence !== undefined ? "yes" : "no (using defaults)"}`);
  console.log(`configChecksum: ${checksum.match ? "ok" : "MISMATCH"}`);
  console.log(
    `impactEvidence block trusted: ${trustedResult.tampered ? `no (${trustedResult.detail === "absent" ? "no configChecksum recorded" : "configChecksum mismatch"}) — loosening fields ignored, safe defaults used` : "yes"}`,
  );
  console.log("");
  console.log("## Host delivery (pre-tool-context surface per adapter)");
  for (const entry of host) {
    console.log(`- ${entry.adapterId} (${entry.label}): ${entry.status}`);
  }
  console.log("");
  console.log(`## Recent log (${recent.length} of ${records.length})`);
  for (const record of recent) {
    console.log(`- [${record.at}] ${record.event} session=${record.sessionId} files=${record.files.join(",") || "(none)"}`);
  }
}

async function handleTest(cwd: string, args: string[]): Promise<void> {
  const requested = args.filter((arg) => !arg.startsWith("--"));
  if (requested.length === 0) {
    console.error("Usage: keryx security impact-evidence test <file...> [--json]");
    process.exitCode = 1;
    return;
  }

  // F14 (review round 2): the same containment `normalizeRequestFiles`
  // gives the live `hook` path applies here too — an absolute or
  // traversal-shaped argument (`../../etc/passwd`) must not be handed to
  // `computeImpactEvidence`, which reads the file. Run against the project
  // root, not the raw CLI cwd, for the same reason the hook path does.
  const root = resolveProjectRoot(cwd);
  const { files, rejected } = normalizeRequestFiles(root, requested);
  if (rejected.length > 0) {
    console.error(`skipped ${rejected.length} path(s) outside the project root: ${rejected.join(", ")}`);
  }
  if (files.length === 0) {
    process.exitCode = 1;
    return;
  }

  // Dry-run: computes and prints only. Writes NOTHING — no session state, no
  // log — unlike `hook`, which is the live path.
  const evidences = await Promise.all(files.map((file) => computeImpactEvidence(root, file)));

  if (args.includes("--json")) {
    console.log(JSON.stringify({ schemaVersion: 1, files, evidences }, null, 2));
    return;
  }

  console.log(renderEvidenceBlock(evidences, files));
}

/**
 * F13 (review round 1, major): a malformed stdin payload or the provider
 * throwing used to ALWAYS "refuse without blocking" (exit 0, no decision) —
 * including under `unattended-untrusted` and strict (`gate`) mode, where W6's
 * failure table (W6-shell-hooks.md ~l.203-223) requires failing CLOSED, not
 * open. This maps a hook-level failure to the same semantics `provider.ts`
 * already uses for an evidence-service failure (F12): `gate` in ANY profile,
 * or `gate-advisory` specifically under `unattended-untrusted`, denies with
 * reason `hook-crashed` (N5, review round 2 — the W6 failure-table name for
 * a gate hook crash); the two supervised `gate-advisory` profiles get no
 * decision at all (a true refuse-without-blocking) plus a stderr warning.
 */
function isStrictHookClass(strict: boolean, profile: ImpactEvidenceProfile): boolean {
  return strict || profile === "unattended-untrusted";
}

function emitHookFailure(message: string, strict: boolean, profile: ImpactEvidenceProfile): void {
  if (isStrictHookClass(strict, profile)) {
    console.error(`impact-evidence hook: ${message} — denying (fail-closed).`);
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "hook-crashed",
        },
      }),
    );
    return;
  }
  console.error(`impact-evidence hook: ${message} — refusing without blocking (no decision).`);
}

async function handleHook(cwd: string, args: string[], deps: ImpactEvidenceCliDeps = {}): Promise<void> {
  const runtime = optionValue(args, "--runtime") ?? "claude";
  const profileArg = optionValue(args, "--profile");
  const profile: ImpactEvidenceProfile =
    profileArg === "read-only-review" || profileArg === "unattended-untrusted" ? profileArg : "monitored-trusted-local";

  if (runtime !== "claude") {
    // No implemented codec for this runtime (and no `pre-tool-context`
    // surface registered for ANY adapter yet — see
    // `src/security/impact-evidence/host.ts`). Refuse without blocking: this
    // is a reporting gap, not a security decision, so it must never fail a
    // tool call closed.
    console.error(
      `impact-evidence hook: no runtime codec for "${runtime}" (no verified pre-tool-context surface is registered for it) — refusing without blocking.`,
    );
    process.exitCode = 0;
    return;
  }

  // F14 (review round 2): stdin must be parsed BEFORE the project root is
  // decided, because the root itself depends on `payload.cwd` — Claude's
  // hook payload carries the tool-call's own cwd, which can be a
  // subdirectory of the project (or a different directory than this
  // process's own `cwd`, e.g. an MCP server invoked from elsewhere). Using
  // the raw, un-resolved `cwd` as `request.root` used to write session
  // state/log entries under whatever subdirectory happened to invoke the
  // hook instead of the one true project root `loadSecurityConfig` itself
  // already walks up to — splitting a single project's impact-evidence
  // state across directories exactly the way `resolveProjectRoot`'s own doc
  // comment (`lib/contained-path.ts`) describes for the security config.
  const raw = await readStdin(deps.stdin ?? process.stdin);
  let payload: Record<string, unknown> = {};
  let payloadOk = true;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    payloadOk = false;
  }
  const payloadCwd = payloadOk && typeof payload.cwd === "string" ? payload.cwd : undefined;
  const root = resolveProjectRoot(payloadCwd ?? cwd);

  // Needed to decide fail-open vs fail-closed on a hook-level failure below
  // BEFORE the provider (which resolves this same config) ever runs — a
  // tampered/unreadable config is treated the same as `provider.ts` treats
  // it (F11): untrusted, so `strict` only comes from it when the checksum
  // verifies.
  const security = await loadSecurityConfig(root);
  const { config: effective } = resolveImpactEvidenceConfigTrusted(security);
  const strict = effective.strict;

  if (!payloadOk) {
    emitHookFailure("stdin was not valid JSON", strict, profile);
    process.exitCode = 0;
    return;
  }

  const request = requestFromClaudePayload(root, profile, payload);
  const provider = createImpactEvidenceProvider();
  let decision: Awaited<ReturnType<typeof provider>>;
  try {
    decision = await provider(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    emitHookFailure(`provider threw (${message})`, strict, profile);
    process.exitCode = 0;
    return;
  }

  // F1 (review round 1, blocker): `permissionDecision: "allow"` is not a
  // no-op in Claude Code's PreToolUse hook contract — it AUTO-APPROVES the
  // tool call, bypassing the user's own permission prompt entirely. Every
  // path above this point that reaches "allow" (no evidence needed, already
  // touched, kill switch, …) used to emit it anyway, silently granting every
  // Edit/Write/Bash the gate did not explicitly ask about or deny. Only
  // "ask"/"deny" are real decisions this hook is entitled to make; "allow"
  // means "defer to Claude Code's own prompt", which is what omitting the
  // key does.
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      ...(decision.outcome !== "allow"
        ? {
            permissionDecision: decision.outcome,
            ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
          }
        : {}),
      ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
    },
    // F18 (review round 1, minor): `decision.warnings` (a tampered config, a
    // rejected out-of-root path, a failed-open evidence service, …) used to
    // be computed and then dropped on the floor — nothing in the hook output
    // surfaced them anywhere a human or the model would see them. Claude
    // Code's hook JSON supports a top-level `systemMessage` shown to the
    // user; stderr carries the same text for anyone reading hook logs.
    ...(decision.warnings.length > 0 ? { systemMessage: decision.warnings.join("\n") } : {}),
  };
  for (const warning of decision.warnings) {
    console.error(`impact-evidence: ${warning}`);
  }
  console.log(JSON.stringify(output));
}

/**
 * F19 (review round 1, minor/documentation): `acknowledgement`,
 * `rollback_line`, and `denied` below are read from the payload for the day a
 * caller sends them, but the Claude Code PreToolUse hook contract this
 * function decodes TODAY never populates them — Claude's own hook JSON has no
 * field for "the model acknowledges this evidence" or "here is the rollback
 * command", and no mechanism yet feeds back "the previous prompt for this
 * file was denied" on the next call. That is why `provider.ts`'s
 * acknowledgement-required / rollback-line-required paths return `outcome:
 * "ask"` with the evidence/rollback prompt in `additionalContext` rather than
 * ever silently treating an absent acknowledgement as given or withheld: the
 * host hook asks, and a HUMAN answers through Claude Code's own permission
 * prompt. Actually wiring `acknowledgement`/`rollback_line`/`denied` end to
 * end — so a human's answer at that prompt round-trips back into the next
 * hook invocation's payload — is W6's runtime integration to build, not this
 * flow's; no behavior is invented here beyond decoding the fields if a future
 * payload ever does carry them.
 */
function requestFromClaudePayload(
  cwd: string,
  profile: ImpactEvidenceProfile,
  payload: Record<string, unknown>,
): ImpactEvidenceRequest {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "unknown-session";
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "unknown-tool";
  const toolInput = (payload.tool_input && typeof payload.tool_input === "object" ? payload.tool_input : {}) as Record<
    string,
    unknown
  >;

  const files: string[] = [];
  if (typeof toolInput.file_path === "string") {
    files.push(toolInput.file_path);
  }
  if (Array.isArray(toolInput.edits)) {
    for (const edit of toolInput.edits) {
      if (edit && typeof edit === "object" && typeof (edit as Record<string, unknown>).file_path === "string") {
        files.push((edit as Record<string, unknown>).file_path as string);
      }
    }
  }
  if (Array.isArray(toolInput.file_paths)) {
    for (const file of toolInput.file_paths) {
      if (typeof file === "string") {
        files.push(file);
      }
    }
  }
  const command = typeof toolInput.command === "string" ? toolInput.command : undefined;

  return {
    root: cwd,
    sessionId,
    toolName,
    files: [...new Set(files)],
    ...(command !== undefined ? { command } : {}),
    profile,
    ...(typeof payload.acknowledgement === "string" ? { acknowledgement: payload.acknowledgement } : {}),
    ...(typeof payload.rollback_line === "string" ? { rollbackLine: payload.rollback_line } : {}),
    ...(payload.denied === true ? { denied: true } : {}),
  };
}

function printHelp(): void {
  console.log(`keryx security impact-evidence

Usage:
  keryx security impact-evidence status [--json]
  keryx security impact-evidence test <file...> [--json]
  keryx security impact-evidence hook [--runtime claude] [--profile read-only-review|monitored-trusted-local|unattended-untrusted]
`);
}
