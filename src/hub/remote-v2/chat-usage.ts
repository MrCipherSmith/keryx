import type { SessionChatUsage } from "../../remote-control/chat-usage";
import type { LiveShellUsage } from "../../remote-control/live-shell";
import type { RunRow, SessionRow } from "./model";
import type { RemoteRepository } from "./storage";

const usageFields = {
  inputTokens: "tokensIn",
  outputTokens: "tokensOut",
  cacheReadTokens: "cacheRead",
  cacheWriteTokens: "cacheWrite",
} as const;

export type ChatTokenUsage = Omit<LiveShellUsage, "activeMs">;
const emptyTokens = (): ChatTokenUsage => ({ tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0 });
const boundedAdd = (left: number, right: number) => Math.min(Number.MAX_SAFE_INTEGER, left + right);

/** The native bridge emits one usage log for each provider usage observation. */
export function addReportedUsage(run: RunRow, text: string): void {
  if (!text.startsWith('{"kind":"usage",')) return;
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    return;
  }
  if (typeof report !== "object" || report === null || !("source" in report) ||
      !["agent", "native-runtime", "routing-classifier"].some(source => source === report.source) ||
      !("usage" in report) || typeof report.usage !== "object" || report.usage === null) return;
  const usage = report.usage as Record<string, unknown>;
  for (const [providerField, field] of Object.entries(usageFields)) {
    const value = usage[providerField];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) continue;
    run.chatTokens ??= emptyTokens();
    run.chatTokens[field] = boundedAdd(run.chatTokens[field], value);
  }
}

const terminal = new Set<RunRow["state"]>(["succeeded", "failed", "cancelled", "rejected", "lost", "unknown"]);

function activeMs(run: RunRow, now: number): number {
  if (!run.chatStartedAt) return 0;
  const start = Date.parse(run.chatStartedAt);
  const end = terminal.has(run.state) ? Date.parse(run.observedAt ?? run.terminalAt ?? run.chatStartedAt) : now;
  return Number.isFinite(end - start) ? Math.max(0, end - start) : 0;
}

export function readSessionChatUsage(repo: RemoteRepository, row: SessionRow, now = Date.now()): SessionChatUsage {
  let latest: RunRow | undefined;
  let total: LiveShellUsage | null = null;
  let incomplete = false;
  for (const run of repo.sessionValues<RunRow>("remote_run", row.record.sessionId)) {
    if (run.projectId !== row.record.projectId) continue;
    const began = Boolean(run.chatStartedAt || run.nativeIdentity || run.chatTokens);
    if (!began && run.runId !== row.record.activeRunId) continue;
    const isActive = run.runId === row.record.activeRunId;
    if (isActive || (!row.record.activeRunId &&
        (!latest || (run.turnOrdinal ?? 0) > (latest.turnOrdinal ?? 0) ||
          (run.turnOrdinal === latest.turnOrdinal && (run.observedAt ?? "") > (latest.observedAt ?? ""))))) {
      latest = run;
    }
    incomplete ||= Boolean(run.chatUsageGap) || (began && (!run.chatStartedAt || (terminal.has(run.state) && !run.chatTokens)));
    if (!run.chatTokens) continue;
    total ??= { ...emptyTokens(), activeMs: 0 };
    for (const field of Object.values(usageFields)) total[field] = boundedAdd(total[field], run.chatTokens[field]);
    total.activeMs = boundedAdd(total.activeMs, activeMs(run, now));
  }
  const turn = latest?.chatTokens ? { ...latest.chatTokens, activeMs: activeMs(latest, now) } : null;
  return { turn, session: total, incomplete };
}
