import type { Worker } from "node:worker_threads";
import type { Sanitized } from "./sources";
/** Owns the worker through termination; abort leaves no detector work running. */
export function runEvidenceScan(worker: Worker, signal?: AbortSignal): Promise<Sanitized | { code: "blocked" }> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: Sanitized | { code: "blocked" }) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      // Retain the error handler through termination: never expose raw errors.
      void worker.terminate().then(() => resolve(result), () => resolve({ code: "blocked" }));
    };
    const abort = () => finish({ code: "blocked" });
    const timer = setTimeout(abort, 1000);
    worker.once("error", abort);
    worker.once("exit", abort);
    worker.once("message", (result: unknown) => {
      if (result && typeof result === "object" && "code" in result && result.code === "ok" &&
          "text" in result && typeof result.text === "string" && Buffer.byteLength(result.text) <= 8 * 1024 * 1024 &&
          "redaction" in result && (result.redaction === "applied" || result.redaction === "not-needed")) {
        finish({ code: "ok", text: result.text, redaction: result.redaction });
      } else abort();
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
