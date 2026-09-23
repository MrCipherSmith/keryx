// One ACP run inside the runtime's disposable worktree, and its durable record
// (flow 292, T8/T9).
//
// `runExternalChild` (`./runtime.ts`) owns the gate, the depth marker, the
// prompt, the worktree and its removal — unchanged for every transport. For an
// ACP agent it hands the worktree to `runAcpInWorktree`, which:
//
//   1. offers keryx's own MCP server — `serve-mcp --read-only`, launched from the
//      RUNNING build (`process.execPath` + this checkout's CLI entry), never a
//      `keryx` found on PATH, which is a stale install on a developer machine;
//      when the MCP module or its SDK is unavailable the run proceeds and the
//      record says `context: not-offered` with the reason;
//   2. runs `superviseAcpRun` with the permission mode lowered to `ask`;
//   3. on a `--write` run, captures the worktree's diff as a patch artifact
//      BEFORE the worktree is removed — through a throwaway git index, so the
//      worktree's own index is not touched — and never applies it.
//
// `persistAcpRun` then writes the run as a keryx session (`provider:
// acp:<agent-id>`), so `keryx sessions` lists it, with a redacted side record of
// every decision, fs request, usage and cost. A cost the agent did not report is
// recorded as `"missing"`, never as 0.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AcpClientCapabilities, AcpImplementation, AcpMcpServerStdio, AcpStopReason } from "../../acp/protocol";
import type { AgentIO } from "../../commands/agent";
import type { PermissionMode } from "../../commands/permission-mode";
import { withoutGitDiscoveryOverrides } from "../../lib/git-env";
import { loadDiscovery } from "../../mcp/discovery";
import { redactSensitiveText } from "../../security/service";
import { createSession, persistHistory } from "../../session/store";
import type { NormalizedMessage } from "../provider/types";
import { clampForeignMode, type AcpModeClamp, type AcpPermissionDecision } from "./acp-permission";
import {
  superviseAcpRun,
  type AcpCost,
  type AcpEmbeddedResource,
  type AcpToolCallRecord,
  type AcpUsage,
  type SuperviseAcpOutcome,
} from "./acp-client";
import type { AcpFsRequestRecord } from "./acp-fs";
import type { ExternalSpawnPort } from "./supervise";
import type { ExternalAgentEntry, ExternalEvent } from "./types";

const execFileAsync = promisify(execFile);

/** Whether keryx's own MCP server was offered to the agent, and why not when it was not. */
export type AcpContextOffer =
  | { readonly offered: true; readonly server: AcpMcpServerStdio }
  | { readonly offered: false; readonly reason: string };

/** This checkout's CLI entry, when it exists on disk (a compiled binary has none). */
export function defaultCliEntry(): string | undefined {
  const entry = path.join(import.meta.dir, "..", "..", "cli.ts");
  return existsSync(entry) ? entry : undefined;
}

/** The stdio MCP server entry that launches the running keryx build as a read-only MCP server. */
export function keryxServeMcpServer(
  projectRoot: string,
  execPath: string = process.execPath,
  cliEntry: string | undefined = defaultCliEntry(),
): AcpMcpServerStdio {
  return {
    name: "keryx",
    command: execPath,
    args: [...(cliEntry === undefined ? [] : [cliEntry]), "serve-mcp", "--read-only", "--cwd", projectRoot],
    env: [],
  };
}

/** Whether the optional MCP SDK resolves from this build. */
function mcpSdkAvailable(): boolean {
  try {
    Bun.resolveSync("@modelcontextprotocol/sdk/server/index.js", import.meta.dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether keryx's MCP server can be offered for `projectRoot`. Never
 * throws: an unavailable server is a recorded fact, not a failed run.
 */
export async function resolveKeryxMcpOffer(
  projectRoot: string | undefined,
  options: { readonly sdkAvailable?: () => boolean; readonly execPath?: string; readonly cliEntry?: string } = {},
): Promise<AcpContextOffer> {
  if (projectRoot === undefined) {
    return { offered: false, reason: "no project root is known for this run" };
  }
  const discovery = await loadDiscovery(projectRoot);
  if (!discovery.mcpEnabled) {
    return { offered: false, reason: "the MCP module is disabled for this project (modules.mcp.enabled is not true)" };
  }
  if (!(options.sdkAvailable ?? mcpSdkAvailable)()) {
    return { offered: false, reason: "the optional @modelcontextprotocol/sdk is not installed" };
  }
  return {
    offered: true,
    server: keryxServeMcpServer(projectRoot, options.execPath, options.cliEntry ?? defaultCliEntry()),
  };
}

/** Project instructions offered as embedded context, when present. Bounded. */
const CONTEXT_FILES = ["AGENTS.md", path.join(".metaproject", "index.md")];
const MAX_CONTEXT_FILE_BYTES = 64 * 1024;

export function projectContextResources(projectRoot: string | undefined): AcpEmbeddedResource[] {
  if (projectRoot === undefined) return [];
  const out: AcpEmbeddedResource[] = [];
  for (const relative of CONTEXT_FILES) {
    const file = path.join(projectRoot, relative);
    try {
      const text = readFileSync(file, "utf8");
      if (text.trim().length === 0) continue;
      out.push({
        uri: `file://${file}`,
        text: text.length > MAX_CONTEXT_FILE_BYTES ? `${text.slice(0, MAX_CONTEXT_FILE_BYTES)}\n…(truncated)` : text,
      });
    } catch {
      // Absent or unreadable: nothing to offer from this file.
    }
  }
  return out;
}

/**
 * The worktree's full diff against HEAD — tracked changes AND new files — via a
 * throwaway index, so the worktree's own index is untouched. Undefined when
 * there is nothing, or when git says no.
 */
export async function captureWorktreePatch(worktreePath: string): Promise<string | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), "keryx-acp-index-"));
  const env = { ...withoutGitDiscoveryOverrides(process.env), GIT_INDEX_FILE: path.join(dir, "index") };
  const git = (args: string[]) => execFileAsync("git", args, { cwd: worktreePath, env, maxBuffer: 64 * 1024 * 1024 });
  try {
    await git(["read-tree", "HEAD"]);
    await git(["add", "-A"]);
    const { stdout } = await git(["diff", "--cached", "--binary", "HEAD"]);
    return stdout.length > 0 ? stdout : undefined;
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Everything a foreign ACP run leaves on record. */
export interface AcpRunRecord {
  readonly agentId: string;
  readonly transport: "acp";
  readonly argv: readonly string[];
  readonly worktreePath: string;
  readonly agentInfo: AcpImplementation | "unreported";
  readonly protocolVersion?: number;
  readonly mode: AcpModeClamp;
  readonly unattended: boolean;
  readonly clientCapabilities: AcpClientCapabilities;
  readonly context: AcpContextOffer;
  readonly embeddedContextSent: boolean;
  readonly decisions: readonly AcpPermissionDecision[];
  readonly fsRequests: readonly AcpFsRequestRecord[];
  readonly toolCalls: readonly AcpToolCallRecord[];
  readonly usage: AcpUsage | "missing";
  readonly cost: AcpCost | "missing";
  readonly stopReason?: AcpStopReason;
  readonly cancelSent: boolean;
  readonly killed: boolean;
  /** Where the never-applied patch artifact was saved, on a `--write` run that changed something. */
  readonly patchArtifact?: string;
  /** The keryx session this run was persisted as. */
  readonly sessionId?: string;
}

/** ACP-specific wiring the runtime threads through. All optional. */
export interface AcpChildOptions {
  /** The operator's approver. Absent means unattended: every question that needs a human is refused. */
  readonly requestApproval?: AgentIO["requestApproval"];
  /** Force unattended even with an approver (no TTY, `--unattended`). */
  readonly unattended?: boolean;
  /** The operator's configured mode; recorded, then lowered to `ask`. Defaults to `ask`. */
  readonly mode?: PermissionMode;
  readonly approvalTimeoutMs?: number;
  /** Override the agent command (tests; a scripted fake agent). Defaults to `binary` + `acpArgs`. */
  readonly argv?: readonly string[];
  /** A pre-resolved context offer. Defaults to {@link resolveKeryxMcpOffer} for the project root. */
  readonly context?: AcpContextOffer;
  /** Patch capture seam. Defaults to {@link captureWorktreePatch}. */
  readonly capturePatch?: (worktreePath: string) => Promise<string | undefined>;
  /** keryx data dir for the session record (tests). */
  readonly dataDir?: string;
  readonly killGraceMs?: number;
  /** Ceiling on the run's output (assistant text + events). Defaults to 16 MiB; see `./bounded.ts`. */
  readonly maxOutputBytes?: number;
  /**
   * Ceiling on stderr read from the agent (flow 298 T14). Defaults to the
   * registry entry's own `maxStderrBytes`, or 16 MiB (`DEFAULT_MAX_STDERR_BYTES`,
   * `./bounded.ts`) when the entry declares none.
   */
  readonly maxStderrBytes?: number;
  readonly onDecision?: (decision: AcpPermissionDecision) => void;
  readonly onFsRequest?: (record: AcpFsRequestRecord) => void;
}

export interface RunAcpInWorktreeInput {
  readonly entry: ExternalAgentEntry;
  readonly worktreePath: string;
  readonly projectRoot?: string;
  readonly prompt: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
  readonly write: boolean;
  readonly spawn: ExternalSpawnPort;
  readonly onEvent?: (event: ExternalEvent) => void;
  readonly options: AcpChildOptions;
}

export interface RunAcpInWorktreeResult {
  readonly supervised: SuperviseAcpOutcome;
  readonly record: AcpRunRecord;
  /** The patch text, held until the session directory exists to receive it. */
  readonly patch?: string;
}

/** The argv that starts this entry in ACP mode, unless the caller overrides it. */
export function acpArgvFor(entry: ExternalAgentEntry, override?: readonly string[]): readonly string[] {
  return override ?? [entry.binary, ...(entry.acpArgs ?? [])];
}

export async function runAcpInWorktree(input: RunAcpInWorktreeInput): Promise<RunAcpInWorktreeResult> {
  const options = input.options;
  const mode = clampForeignMode(options.mode ?? "ask");
  const unattended = options.unattended === true || options.requestApproval === undefined;
  const context = options.context ?? (await resolveKeryxMcpOffer(input.projectRoot));
  const argv = acpArgvFor(input.entry, options.argv);
  // The caller's option wins; otherwise fall back to the registry entry's own
  // per-agent override (flow 298 T14), if it declared one.
  const maxStderrBytes = options.maxStderrBytes ?? input.entry.maxStderrBytes;

  const supervised = await superviseAcpRun(
    {
      argv,
      cwd: input.worktreePath,
      env: input.env,
      prompt: input.prompt,
      embeddedResources: projectContextResources(input.projectRoot),
      mcpServers: context.offered ? [context.server] : [],
      write: input.write,
      timeoutMs: input.timeoutMs,
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      ...(maxStderrBytes === undefined ? {} : { maxStderrBytes }),
      permission: {
        mode,
        unattended,
        ...(options.approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs: options.approvalTimeoutMs }),
      },
    },
    {
      spawn: input.spawn,
      ...(options.requestApproval === undefined ? {} : { requestApproval: options.requestApproval }),
      ...(input.onEvent === undefined ? {} : { onEvent: input.onEvent }),
      ...(options.onDecision === undefined ? {} : { onDecision: options.onDecision }),
      ...(options.onFsRequest === undefined ? {} : { onFsRequest: options.onFsRequest }),
    },
  );

  // Captured while the worktree still exists; the runtime removes it right after.
  const patch = input.write ? await (options.capturePatch ?? captureWorktreePatch)(input.worktreePath) : undefined;

  const record: AcpRunRecord = {
    agentId: input.entry.id,
    transport: "acp",
    argv,
    worktreePath: input.worktreePath,
    agentInfo: supervised.agentInfo ?? "unreported",
    ...(supervised.protocolVersion === undefined ? {} : { protocolVersion: supervised.protocolVersion }),
    mode,
    unattended,
    clientCapabilities: supervised.clientCapabilities,
    context,
    embeddedContextSent: supervised.embeddedContextSent,
    decisions: supervised.decisions,
    fsRequests: supervised.fsRequests,
    toolCalls: supervised.toolCalls,
    usage: supervised.usage ?? "missing",
    cost: supervised.cost ?? "missing",
    ...(supervised.stopReason === undefined ? {} : { stopReason: supervised.stopReason }),
    cancelSent: supervised.cancelSent,
    killed: supervised.killed,
  };
  return { supervised, record, ...(patch === undefined ? {} : { patch }) };
}

/** The file inside the session directory holding the run record. */
export const ACP_RUN_RECORD_FILE = "acp-run.json";
/** The file inside the session directory holding the never-applied patch. */
export const ACP_PATCH_FILE = "acp-worktree.patch";

/**
 * Persist one ACP run as a keryx session. Returns the record with `sessionId`
 * (and `patchArtifact`) filled in. Everything written is redacted.
 */
export function persistAcpRun(args: {
  readonly projectRoot: string;
  readonly dataDir?: string;
  readonly record: AcpRunRecord;
  readonly prompt: string;
  readonly assistantText: string;
  readonly status: string;
  readonly patch?: string;
}): AcpRunRecord {
  const { record } = args;
  const handle = createSession({
    cwd: args.projectRoot,
    ...(args.dataDir === undefined ? {} : { dataDir: args.dataDir }),
    provider: `acp:${record.agentId}`,
    ...(record.agentInfo === "unreported" ? {} : { model: `${record.agentInfo.name} ${record.agentInfo.version}` }),
    title: `ACP ${record.agentId}: ${args.status}`,
  });
  const messages: NormalizedMessage[] = [
    { role: "user", content: args.prompt, provenance: "trusted" },
    ...record.toolCalls.map(
      (call): NormalizedMessage => ({
        role: "tool",
        content: `[${call.kind ?? "tool"}] ${call.title ?? call.toolCallId} — ${call.status ?? "unknown"}`,
        provenance: "tool",
        toolCallId: call.toolCallId,
      }),
    ),
    { role: "assistant", content: args.assistantText, provenance: "model" },
  ];
  persistHistory(handle, messages, { title: `ACP ${record.agentId}: ${args.status}` });

  let patchArtifact: string | undefined;
  if (args.patch !== undefined) {
    patchArtifact = path.join(handle.dir, ACP_PATCH_FILE);
    writeFileSync(patchArtifact, redactSensitiveText(args.patch), "utf8");
  }
  const final: AcpRunRecord = {
    ...record,
    sessionId: handle.summary.id,
    ...(patchArtifact === undefined ? {} : { patchArtifact }),
  };
  writeFileSync(path.join(handle.dir, ACP_RUN_RECORD_FILE), redactSensitiveText(JSON.stringify(final, null, 2)), "utf8");
  return final;
}
