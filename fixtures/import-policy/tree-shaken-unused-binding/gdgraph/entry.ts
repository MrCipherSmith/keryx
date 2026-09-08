// Fixture (flow 239, T8): a core owner writing a forbidden client import in
// plain sight, with the binding never used.
//
// This is the shape that broke the build-based check. `bun build` tree-shakes
// an unused binding, so the emitted sourcemap never mentions `../harness/leaf`
// and the reachability scan reported `scanned=1 violations=0` — a clean pass on
// a file whose second line is the violation.
//
// The direct-edge scan records the edge before anything is optimised away.
import { CLIENT } from "../harness/leaf";

export const value = "the import above is never used";
