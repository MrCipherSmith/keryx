// Fixture (flow 239, T8): the LIMIT, held as a fixture rather than as a claim
// in a comment.
//
// A core owner importing a client module's TYPE. TypeScript erases this before
// any runtime artifact exists, so neither the parser nor the bundler reports an
// edge — this check cannot see it and does not pretend to. The fixture exists
// so that the limit is measured on every run: if a future parser change ever
// DOES surface type-only edges, the test asserting zero findings here fails and
// the documented limit gets corrected instead of quietly going stale.
//
// Whether a compile-time-only coupling across a zone boundary should count as a
// violation at all is a real open question, and enforcing it needs the
// TypeScript compiler API rather than this module.
import type { ClientShape } from "../harness/leaf";

export const value: ClientShape = { id: "type-only" };
