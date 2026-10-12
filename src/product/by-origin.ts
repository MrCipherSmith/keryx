// G1a by origin: of the flows in the index, how many state a real outcome
// criterion and how many do not (`not measured`, or nothing), counted per
// origin. An agent-finding or agent-proposal line says how well the agent
// follows the instruction to fill the slot (obedience); a human-request line
// says whether what a human asked for was given an instrument (acceptance).
// A flow with no recorded origin, or an origin this build cannot read, counts
// as `unknown`. Pure over the index; it labels a sample and gates nothing.

import { ORIGIN_READINGS, readOriginKind, type OriginReading } from "../flow/service";
import { hasInstrument } from "./extract";
import type { G1aRow, IntentIndex } from "./types";

/** Four rows, in `ORIGIN_READINGS` order, one per reading, even when a row is empty. */
export function g1aByOrigin(index: IntentIndex): G1aRow[] {
  const criterion = new Map<OriginReading, number>();
  const notMeasured = new Map<OriginReading, number>();
  for (const intent of index.intents) {
    if (intent.source !== "flow") continue;
    const reading = readOriginKind(intent.origin);
    const bucket = hasInstrument(intent.outcome.criterion) ? criterion : notMeasured;
    bucket.set(reading, (bucket.get(reading) ?? 0) + 1);
  }
  return ORIGIN_READINGS.map((origin) => ({ origin, criterion: criterion.get(origin) ?? 0, notMeasured: notMeasured.get(origin) ?? 0 }));
}

/** The table printed by `product open` and the TUI; no lines when the index holds no flow at all. */
export function g1aLines(rows: readonly G1aRow[] | undefined): string[] {
  if (rows === undefined || rows.every((row) => row.criterion + row.notMeasured === 0)) return [];
  return [
    "G1a by origin (flows with a real criterion / not measured):",
    ...rows.map((row) => `  ${row.origin}: ${row.criterion} real criterion, ${row.notMeasured} not measured`),
  ];
}
