import type { BackgroundJobEvent, JobRegistry } from "../harness/tool/builtin/background-job-registry";

interface Capture { stdout: string; stderr: string; bytes: number; overflow: boolean; signal: AbortSignal; jobId?: string }
/** A local runner used only after a fixed native read adapter validates its argv.
 * Capture uses actual process stream events, before the registry shrinks its terminal tail. */
export function createOwnedReadCapture() {
  const pending = new Map<string, Capture[]>(); const active = new Map<string, Capture>();
  let registry: JobRegistry | undefined;
  const maxBytes = 512 * 1024;
  return {
    onEvent(event: BackgroundJobEvent) {
      if (event.type === "start") {
        const queue = pending.get(event.command); const capture = queue?.shift();
        if (capture !== undefined) { capture.jobId = event.jobId; active.set(event.jobId, capture); if (capture.signal.aborted) void registry?.kill(event.jobId).catch(() => undefined); }
      } else if (event.type === "output") {
        const capture = active.get(event.jobId); if (capture === undefined || capture.overflow) return;
        capture.bytes += Buffer.byteLength(event.chunk);
        if (capture.bytes > maxBytes) { capture.overflow = true; void registry?.kill(event.jobId).catch(() => undefined); return; }
        capture[event.stream] += event.chunk;
      }
    },
    async run(jobs: JobRegistry, command: string, outerSignal?: AbortSignal): Promise<{ stdout: string; stderr: string; exitCode: number }> {
      registry = jobs;
      const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(outerSignal === undefined ? [] : [outerSignal])]); signal.throwIfAborted();
      const capture: Capture = { stdout: "", stderr: "", bytes: 0, overflow: false, signal };
      const queue = pending.get(command) ?? []; queue.push(capture); pending.set(command, queue);
      const abort = () => { if (capture.jobId !== undefined) void jobs.kill(capture.jobId).catch(() => undefined); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const begun = await jobs.start(command);
        if (!begun.ok) throw new Error("owned-analysis-read-start-failed");
        if (capture.jobId !== begun.jobId) { await jobs.kill(begun.jobId); throw new Error("owned-analysis-read-observer-missing"); }
        if (signal.aborted) { await jobs.kill(begun.jobId); signal.throwIfAborted(); }
        if (await jobs.waitForExit(begun.jobId, 31_000) !== "exited") { await jobs.kill(begun.jobId); throw new Error("owned-analysis-read-timeout"); }
        signal.throwIfAborted();
        if (capture.overflow) throw new Error("owned-analysis-read-quota-exceeded");
        const task = jobs.get(begun.jobId);
        if (task?.exitCode === undefined || task.status === "running" || task.status === "killed") throw new Error("owned-analysis-read-stop-unconfirmed");
        return { stdout: capture.stdout, stderr: capture.stderr, exitCode: task.exitCode };
      } finally {
        signal.removeEventListener("abort", abort);
        if (capture.jobId !== undefined) active.delete(capture.jobId);
        const rest = (pending.get(command) ?? []).filter((value) => value !== capture); if (rest.length === 0) pending.delete(command); else pending.set(command, rest);
      }
    },
  };
}
