// Flow 331, AC2 — the adapter registry `run.ts` iterates over.
import { ciTriageAdapter } from "./ci-triage";
import { reviewConformAdapter } from "./review-conform";
import { flowCheckAcAdapter, reviewJevRulesAdapter, severityCalibrationAdapter } from "./not-available";
import type { ComponentAdapter } from "../types";

/**
 * Registration order is the report's display order: real, available
 * components first (the numbers a reader came for), then the `not
 * available` hooks for components landing elsewhere (AC2) — so a reader
 * scans down to real results before hitting placeholders.
 */
export function registerAdapters(): readonly ComponentAdapter[] {
  return [ciTriageAdapter(), reviewConformAdapter(), flowCheckAcAdapter(), reviewJevRulesAdapter(), severityCalibrationAdapter()];
}
