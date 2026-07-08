import { beta } from "./beta";
// Naming-matches alpha.ts by prefix ("alpha.") but ONLY exercises beta.ts.
// This is the false positive that the static naming heuristic over-selects and
// the coverage map correctly excludes.
export const check = () => beta(2) === 4;
