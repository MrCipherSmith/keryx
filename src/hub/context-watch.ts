import { setTimeout } from "node:timers/promises";
import { HubSyncCancelled, HubSyncError, type SyncErrorCode } from "./context-sync";

type SyncConnector = { sync(options?: { signal?: AbortSignal }): Promise<{ revision: number; changed?: boolean }> };
export type WatchEvent = { state: "updated" | "unchanged" | "retrying" | "busy" | "fatal" | "stopped"; revision?: number; errorCode?: SyncErrorCode; retryAfterSeconds?: number };
type WatchOptions = {
    connector: SyncConnector;
    intervalSeconds?: number;
    signal?: AbortSignal;
    onEvent: (event: WatchEvent) => void;
    sleep?: (seconds: number, signal: AbortSignal) => Promise<void>;
};
export function validateWatchInterval(value: number): void {
    if (!Number.isInteger(value) || value < 5 || value > 3600) throw new HubSyncError("configuration");
}
/** A foreground loop: every request and wait completes before the next cycle starts. */
export async function watchHubContext(options: WatchOptions): Promise<void> {
    const interval = options.intervalSeconds ?? 15;
    validateWatchInterval(interval);
    const signal = options.signal ?? new AbortController().signal;
    const sleep = options.sleep ?? (async (seconds, cancellation) => { await setTimeout(seconds * 1000, undefined, { signal: cancellation }); });
    let revision: number | undefined;
    let failures = 0;
    const emit = (event: WatchEvent) => options.onEvent({ ...event, ...(revision === undefined ? {} : { revision }) });
    while (!signal.aborted) {
        let delay = interval;
        try {
            const result = await options.connector.sync({ signal });
            revision = result.revision;
            emit({ state: result.changed === false ? "unchanged" : "updated" });
            failures = 0;
        } catch (error) {
            if (error instanceof HubSyncCancelled && error.revision !== undefined) revision = error.revision;
            if (signal.aborted) break;
            const failure = error instanceof HubSyncError ? error : new HubSyncError("filesystem");
            if (failure.revision !== undefined) revision = failure.revision;
            if (failure.code === "cache-busy") emit({ state: "busy", errorCode: failure.code, retryAfterSeconds: interval });
            else if (["network", "timeout", "rate-limited", "server-unavailable"].includes(failure.code)) {
                delay = Math.min(interval * 2 ** Math.min(failures++, 16), Math.max(interval, 60));
                emit({ state: "retrying", errorCode: failure.code, retryAfterSeconds: delay });
            } else {
                emit({ state: "fatal", errorCode: failure.code });
                throw failure;
            }
        }
        if (signal.aborted) break;
        try { await sleep(delay, signal); }
        catch (error) { if (!signal.aborted) throw error; }
    }
    emit({ state: "stopped" });
}
