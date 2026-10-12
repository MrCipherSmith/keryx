// Flow 400 (AC11): records from before the arms. They were not assigned by the
// seeded draw, so they are never part of the randomized comparison: the report shows
// them in a block of their own and a flag leaves them out.
//
// The old ordinary mode was exactly arm A (agent order, mark shown, recommended
// preselected) and the old blind mode was exactly arm D (shuffled, no mark), so a
// legacy record is placed in A or D by its mode. Placing it is a reading aid; it does
// not make the record random.
//
// The journal is append-only, so nothing is rewritten: a record on disk without `arm`
// is stamped here, on read, and the stamp is idempotent. `import` writes the same
// stamp onto the records it creates.

import { armOfMode, type Arm } from "./arms";
import type { OpenRecord } from "./types";

/** The arm a record belongs to: the stored one, or the one its old mode stands for. */
export function effectiveArm(open: Pick<OpenRecord, "arm" | "mode">): Arm {
  return open.arm ?? armOfMode(open.mode);
}

/** True for a record stamped legacy, or one written before the arms existed (no `arm`). */
export function isLegacy(open: Pick<OpenRecord, "arm" | "legacy">): boolean {
  return open.legacy === true || open.arm === undefined;
}

/** The record as the report reads it: a pre-v2 record gets its arm and `legacy: true`; any other is returned unchanged. */
export function stampLegacy(open: OpenRecord): OpenRecord {
  if (open.arm !== undefined) return open;
  return { ...open, arm: effectiveArm(open), legacy: true };
}
