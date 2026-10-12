// Flow 389 (AC6): getting the digest to the operator's Telegram.
//
// Delivery goes through `keryx serve`'s own Telegram path (`src/remote`), never a
// second bot client:
//   - the project has a live remote session   -> the digest goes into that session's topic,
//   - otherwise                               -> into the service topic "Digest"
//                                                (configurable: `action.digest.topic`).
//
// A run only ENQUEUES its message. The queue is `.metaproject/data/digest/<name>/delivery.json`,
// so a run started by `keryx trigger run` while serve is down is not lost: the serve ticker
// flushes it on its next tick. A flush that fails is written into the run's report
// (the "## Delivery" section) and retried with a growing delay, up to MAX_ATTEMPTS.
//
// What each answer from the hub means:
//   sent    -> done.
//   queued  -> Telegram or the network refused for now. The hub's durable outbound queue
//              owns the retry (it survives a restart), so the digest does NOT send it again;
//              the report says so.
//   refused -> the topic could not be created, or Telegram refused the text for good.
//              The digest keeps the message and retries it itself.

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { isNotFound, withFileLock, writeFileAtomic } from "../lib/fs";
import type { RemoteHub } from "../remote/hub";
import { digestScheduleDir, ensureDigestDataIgnored } from "./digest-snapshot";

export const DELIVERY_MAX_ATTEMPTS = 12;
const BACKOFF_BASE_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;

export type DeliveryStatus = "sent" | "queued" | "failed" | "pending" | "gave-up";

export interface PendingDelivery {
  readonly runId: string;
  readonly text: string;
  /** The service topic used when the project has no remote session. */
  readonly topic: string;
  /** Repo-relative path of the run's report; delivery lines are appended to it. */
  readonly reportPath?: string;
  readonly attempts: number;
  readonly firstAt: string;
  readonly nextAt: string;
}

export interface LastDelivery {
  readonly at: string;
  readonly runId: string;
  readonly status: DeliveryStatus;
  /** `session` (the project's remote topic) or `topic` (the service topic). */
  readonly target?: "session" | "topic";
  readonly topic?: string;
  readonly detail: string;
}

export interface DeliveryState {
  readonly version: 1;
  readonly last?: LastDelivery;
  readonly pending: readonly PendingDelivery[];
}

export type SinkResult = { readonly ok: true; readonly state: "sent" | "queued" } | { readonly ok: false; readonly reason: string };

/** What delivery needs from serve's Telegram path. A test passes a fake; production wraps the hub. */
export interface DigestSink {
  /** The id of this project's live remote session, if it has one. */
  sessionFor(projectRoot: string): string | undefined;
  sendToSession(sessionId: string, text: string): Promise<SinkResult>;
  sendToTopic(topic: string, text: string): Promise<SinkResult>;
}

/** The production sink: serve's own `RemoteHub`. */
export function hubSink(hub: Pick<RemoteHub, "list" | "sendToSessionTracked" | "sendToServiceTopic">): DigestSink {
  const norm = (p: string): string => path.resolve(p);
  return {
    sessionFor: (projectRoot) => hub.list().find((s) => s.status === "live" && s.project !== undefined && norm(s.project) === norm(projectRoot))?.sessionId,
    sendToSession: async (sessionId, text) => {
      const r = await hub.sendToSessionTracked(sessionId, text);
      return r.ok ? { ok: true, state: r.state } : { ok: false, reason: r.reason };
    },
    sendToTopic: async (topic, text) => {
      const r = await hub.sendToServiceTopic(topic, text);
      return r.ok ? { ok: true, state: r.state } : { ok: false, reason: r.reason };
    },
  };
}

export function deliveryPath(projectRoot: string, name: string): string {
  return path.join(digestScheduleDir(projectRoot, name), "delivery.json");
}

function lockPath(projectRoot: string, name: string): string {
  return path.join(digestScheduleDir(projectRoot, name), "delivery.lock");
}

function emptyState(): DeliveryState {
  return { version: 1, pending: [] };
}

function parseState(text: string): DeliveryState {
  try {
    const raw = JSON.parse(text) as { pending?: unknown; last?: unknown } | null;
    const pending: PendingDelivery[] = [];
    if (raw !== null && Array.isArray(raw.pending)) {
      for (const p of raw.pending as Array<Record<string, unknown>>) {
        if (typeof p?.["runId"] === "string" && typeof p["text"] === "string" && typeof p["topic"] === "string" && typeof p["attempts"] === "number" && typeof p["firstAt"] === "string" && typeof p["nextAt"] === "string") {
          pending.push({
            runId: p["runId"],
            text: p["text"],
            topic: p["topic"],
            ...(typeof p["reportPath"] === "string" ? { reportPath: p["reportPath"] } : {}),
            attempts: p["attempts"],
            firstAt: p["firstAt"],
            nextAt: p["nextAt"],
          });
        }
      }
    }
    const last = raw?.last as Record<string, unknown> | undefined;
    const validLast = last !== undefined && last !== null && typeof last["at"] === "string" && typeof last["runId"] === "string" && typeof last["status"] === "string" && typeof last["detail"] === "string";
    return {
      version: 1,
      ...(validLast ? { last: last as unknown as LastDelivery } : {}),
      pending,
    };
  } catch {
    return emptyState();
  }
}

/** The stored delivery state: the last delivery and what is still waiting. Empty when nothing was ever delivered. */
export async function readDeliveryState(projectRoot: string, name: string): Promise<DeliveryState> {
  try {
    return parseState(await readFile(deliveryPath(projectRoot, name), "utf8"));
  } catch (error) {
    if (isNotFound(error)) return emptyState();
    return emptyState();
  }
}

async function writeState(projectRoot: string, name: string, state: DeliveryState): Promise<void> {
  await ensureDigestDataIgnored(projectRoot);
  await writeFileAtomic(deliveryPath(projectRoot, name), `${JSON.stringify(state, null, 2)}\n`);
}

async function locked<T>(projectRoot: string, name: string, fn: () => Promise<T>): Promise<T | undefined> {
  await ensureDigestDataIgnored(projectRoot);
  try {
    return await withFileLock(lockPath(projectRoot, name), fn, { timeoutMs: 2000 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Timed out waiting for lock:")) return undefined;
    throw error;
  }
}

/** Append one line to the run's report, under its "## Delivery" heading. A missing or pruned report is not an error. */
export async function appendDeliveryLine(projectRoot: string, reportPath: string | undefined, line: string): Promise<void> {
  if (reportPath === undefined) return;
  await appendFile(path.join(projectRoot, reportPath), `- ${line}\n`, "utf8").catch(() => {});
}

/** Queue one digest message for delivery. It is sent by the next `flushDeliveries`. */
export async function enqueueDelivery(
  projectRoot: string,
  name: string,
  item: { readonly runId: string; readonly text: string; readonly topic: string; readonly reportPath?: string },
  now: Date,
): Promise<void> {
  await locked(projectRoot, name, async () => {
    const state = await readDeliveryState(projectRoot, name);
    const entry: PendingDelivery = {
      runId: item.runId,
      text: item.text,
      topic: item.topic,
      ...(item.reportPath !== undefined ? { reportPath: item.reportPath } : {}),
      attempts: 0,
      firstAt: now.toISOString(),
      nextAt: now.toISOString(),
    };
    await writeState(projectRoot, name, { ...state, pending: [...state.pending.filter((p) => p.runId !== item.runId), entry] });
  });
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface FlushResult {
  readonly runId: string;
  readonly status: DeliveryStatus;
  readonly detail: string;
}

/** Send every pending digest message that is due. Safe to call at any time; a second concurrent call does nothing. */
export async function flushDeliveries(projectRoot: string, name: string, sink: DigestSink, now: () => Date): Promise<FlushResult[]> {
  const done = await locked(projectRoot, name, async () => {
    const state = await readDeliveryState(projectRoot, name);
    const results: FlushResult[] = [];
    const keep: PendingDelivery[] = [];
    let last = state.last;
    for (const item of state.pending) {
      if (Date.parse(item.nextAt) > now().getTime()) {
        keep.push(item);
        continue;
      }
      const sessionId = sink.sessionFor(projectRoot);
      const target: "session" | "topic" = sessionId !== undefined ? "session" : "topic";
      const where = target === "session" ? "the project's remote session topic" : `the "${item.topic}" topic`;
      let outcome: SinkResult;
      try {
        outcome = sessionId !== undefined ? await sink.sendToSession(sessionId, item.text) : await sink.sendToTopic(item.topic, item.text);
      } catch (error) {
        outcome = { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const at = now().toISOString();
      const attempt = item.attempts + 1;
      if (outcome.ok && outcome.state === "sent") {
        const detail = `delivered to ${where}`;
        last = { at, runId: item.runId, status: "sent", target, ...(target === "topic" ? { topic: item.topic } : {}), detail };
        await appendDeliveryLine(projectRoot, item.reportPath, `${at} ${detail} (attempt ${attempt})`);
        results.push({ runId: item.runId, status: "sent", detail });
      } else if (outcome.ok) {
        const detail = `Telegram did not take it yet — the remote outbound queue holds it for ${where} and retries`;
        last = { at, runId: item.runId, status: "queued", target, ...(target === "topic" ? { topic: item.topic } : {}), detail };
        await appendDeliveryLine(projectRoot, item.reportPath, `${at} ${detail} (attempt ${attempt})`);
        results.push({ runId: item.runId, status: "queued", detail });
      } else if (attempt >= DELIVERY_MAX_ATTEMPTS) {
        const detail = `gave up after ${attempt} attempts: ${outcome.reason}`;
        last = { at, runId: item.runId, status: "gave-up", target, ...(target === "topic" ? { topic: item.topic } : {}), detail };
        await appendDeliveryLine(projectRoot, item.reportPath, `${at} ${detail}`);
        results.push({ runId: item.runId, status: "gave-up", detail });
      } else {
        const retryAt = new Date(now().getTime() + backoffMs(attempt)).toISOString();
        const detail = `delivery to ${where} failed: ${outcome.reason}`;
        last = { at, runId: item.runId, status: "failed", target, ...(target === "topic" ? { topic: item.topic } : {}), detail };
        await appendDeliveryLine(projectRoot, item.reportPath, `${at} ${detail} (attempt ${attempt}, retrying after ${retryAt})`);
        keep.push({ ...item, attempts: attempt, nextAt: retryAt });
        results.push({ runId: item.runId, status: "failed", detail });
      }
    }
    await writeState(projectRoot, name, { version: 1, ...(last !== undefined ? { last } : {}), pending: keep });
    return results;
  });
  return done ?? [];
}
