import { TASKS_OUTPUT, type TaskOutputResult } from "../acp/providers";
import type { StreamSource } from "../panels/streamTabs";

type Request = <T>(method: string, params?: unknown) => Promise<T>;

/**
 * A background task's output as a terminal stream: all of it keryx still holds, then new output every
 * `pollMs` until keryx reports the task finished. A gap keryx reports (output dropped between reads)
 * is marked with an "[output skipped here]" line. Stops when the tab closes.
 */
export function taskOutputSource(request: Request, sessionId: string, taskId: string, pollMs = 1000): StreamSource {
  return (write, end) => {
    let cursor: string | number | null = null;
    let stopped = false;
    let inflight = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = () => {
      stopped = true;
      if (timer !== null) clearInterval(timer);
    };
    const tick = async () => {
      if (inflight || stopped) return;
      inflight = true;
      try {
        const params: Record<string, unknown> = { sessionId, taskId };
        if (cursor !== null) params.since = cursor;
        const r = await request<TaskOutputResult>(TASKS_OUTPUT, params);
        if (stopped) return;
        if (r?.nextCursor !== undefined && r.nextCursor !== null) cursor = r.nextCursor;
        if (r?.missed) write("\n[output skipped here]\n");
        if (typeof r?.output === "string" && r.output) write(r.output);
        if (r?.status && r.status !== "running") {
          stop();
          end(`task ${r.status}`);
        }
      } catch {
        /* the next tick tries again */
      } finally {
        inflight = false;
      }
    };
    void tick();
    timer = setInterval(() => void tick(), pollMs);
    return stop;
  };
}
