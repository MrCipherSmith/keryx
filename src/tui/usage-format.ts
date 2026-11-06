import type { NormalizedUsage } from "../harness/provider/types";
import type { UsageSnapshot } from "./usage-tracker";

/** Cache counters are input subsets, not extra tokens or a price. */
export function formatUsageLine(usage: NormalizedUsage): string | undefined {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) parts.push(`↑${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`↓${usage.outputTokens}`);
  if (parts.length === 0) return undefined;
  const cache: string[] = [];
  if (usage.cacheReadTokens !== undefined) cache.push(`cache-read ${usage.cacheReadTokens}`);
  if (usage.cacheWriteTokens !== undefined) cache.push(`cache-write ${usage.cacheWriteTokens}`);
  // Absence is unknown, not a fabricated zero. Only derive a full breakdown.
  if (usage.inputTokens !== undefined && usage.cacheReadTokens !== undefined && usage.cacheWriteTokens !== undefined) {
    const uncached = usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens;
    if (uncached >= 0) cache.push(`uncached ${uncached}`);
  }
  return `${parts.join(" ")} tokens${cache.length > 0 ? ` · ${cache.join(" · ")}` : " · cache not reported"}`;
}

/** Flow 483: compact token count (1234 -> 1.2k, 1234567 -> 1.2M). */
export function compactTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Flow 483: active time, e.g. 45s, 3m05s, 1h02m. */
export function formatActiveTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function formatCostUsd(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

type Totals = UsageSnapshot["session"];

function totalsPart(t: Totals): string {
  const parts = [`\u2191${compactTokens(t.tokensIn)} \u2193${compactTokens(t.tokensOut)}`];
  if (t.cacheRead > 0 || t.cacheWrite > 0) parts.push(`cache ${compactTokens(t.cacheRead)}/${compactTokens(t.cacheWrite)}`);
  if (t.costUsd !== undefined) parts.push(formatCostUsd(t.costUsd));
  parts.push(formatActiveTime(t.activeMs));
  return parts.join(" ");
}

/** Flow 483: footer text — this turn (live or last) and session totals. Undefined before any turn. */
export function formatUsageFooter(snap: UsageSnapshot): string | undefined {
  if (!snap.turnRunning && snap.turns === 0) return undefined;
  return `turn ${totalsPart(snap.turn)} \u00b7 session ${totalsPart(snap.session)}`;
}

/** Flow 483: the /status Usage tab table. */
export function formatUsageTable(snap: UsageSnapshot): string {
  const cost = (c: number | undefined): string => (c !== undefined ? formatCostUsd(c) : "n/a");
  const rows: [string, string, string][] = [
    ["", snap.turnRunning ? "Turn (live)" : "Last turn", "Session"],
    ["Input", String(snap.turn.tokensIn), String(snap.session.tokensIn)],
    ["Output", String(snap.turn.tokensOut), String(snap.session.tokensOut)],
    ["Cache read", String(snap.turn.cacheRead), String(snap.session.cacheRead)],
    ["Cache write", String(snap.turn.cacheWrite), String(snap.session.cacheWrite)],
    ["Cost", cost(snap.turn.costUsd), cost(snap.session.costUsd)],
    ["Active time", formatActiveTime(snap.turn.activeMs), formatActiveTime(snap.session.activeMs)],
    ["Turns", "", String(snap.turns)],
  ];
  const w0 = Math.max(...rows.map((r) => r[0].length));
  const w1 = Math.max(...rows.map((r) => r[1].length));
  return rows.map((r) => `${r[0].padEnd(w0)}  ${r[1].padStart(w1)}  ${r[2]}`.trimEnd()).join("\n");
}
