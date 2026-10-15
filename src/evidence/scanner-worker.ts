import { parentPort, workerData } from "node:worker_threads";
import { buildHarnessScanner } from "../security/harness-scan";
import { redactForPersistence } from "../harness/evidence/redaction";
// Deterministic scanner floor only: no model calls or persistence.
try {
  const { projectRoot, text } = workerData;
  const scanner = await buildHarnessScanner(projectRoot);
  if (!scanner.available || typeof text !== "string" || Buffer.byteLength(text) > 8 * 1024 * 1024) {
    parentPort?.postMessage({ code: "blocked" });
  } else {
    const clean = redactForPersistence(text, scanner);
    parentPort?.postMessage(clean.blocked ? { code: "blocked" } : {
      code: "ok", text: clean.preview, redaction: clean.provenance.redaction === "full" ? "applied" : "not-needed",
    });
  }
} catch { parentPort?.postMessage({ code: "blocked" }); }
parentPort?.close();

export {};
