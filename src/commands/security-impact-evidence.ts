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
  readLogRecords,
  renderEvidenceBlock,
  resolveImpactEvidenceConfig,
  verifyConfigChecksum,
  type ImpactEvidenceProfile,
  type ImpactEvidenceRequest,
} from "../security/service";
import { optionValue } from "../lib/args";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleImpactEvidence(cwd: string, args: string[]): Promise<void> {
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
      await handleHook(cwd, rest);
      return;
    default:
      console.error(`Unknown impact-evidence command: ${subcommand}`);
      printHelp();
      process.exitCode = 1;
  }
}

async function handleStatus(cwd: string, args: string[]): Promise<void> {
  const security = await loadSecurityConfig(cwd);
  const effective = resolveImpactEvidenceConfig(security);
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
  const files = args.filter((arg) => !arg.startsWith("--"));
  if (files.length === 0) {
    console.error("Usage: keryx security impact-evidence test <file...> [--json]");
    process.exitCode = 1;
    return;
  }

  // Dry-run: computes and prints only. Writes NOTHING — no session state, no
  // log — unlike `hook`, which is the live path.
  const evidences = await Promise.all(files.map((file) => computeImpactEvidence(cwd, file)));

  if (args.includes("--json")) {
    console.log(JSON.stringify({ schemaVersion: 1, files, evidences }, null, 2));
    return;
  }

  console.log(renderEvidenceBlock(evidences, files));
}

async function handleHook(cwd: string, args: string[]): Promise<void> {
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

  const raw = await readStdin();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    console.error("impact-evidence hook: stdin was not valid JSON — refusing without blocking.");
    process.exitCode = 0;
    return;
  }

  const request = requestFromClaudePayload(cwd, profile, payload);
  const provider = createImpactEvidenceProvider();
  const decision = await provider(request);

  const permissionDecision = decision.outcome;
  const output: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      ...(decision.reason ? { permissionDecisionReason: decision.reason } : {}),
      ...(decision.additionalContext ? { additionalContext: decision.additionalContext } : {}),
    },
  };
  console.log(JSON.stringify(output));
}

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
