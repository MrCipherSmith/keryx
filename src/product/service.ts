// The product module's facade. The CLI adapter and the TUI reach it through
// here (import policy, rule 2); nothing outside `src/product/` imports a
// sibling file.

export { buildIntentIndex, corpusFingerprint } from "./corpus";
export { NO_INSTRUMENT } from "./extract";
export {
  buildOpenReport,
  loadOpenReport,
  openEntryLines,
  openHeaderLines,
  renderIndexSummary,
  renderOpen,
  type OpenLoad,
} from "./open";
export { checkStaleness, indexPath, productDataRoot, readIntentIndex, serializeIndex, writeIntentIndex } from "./store";
export type { IndexRead, Intent, IntentCounts, IntentIndex, IntentOutcome, OpenEntry, OpenReport, Staleness } from "./types";
