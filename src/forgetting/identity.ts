// Flow 242 (forgetting), lane E — the one layer this reconcile WRITES.
//
// This code was first written inside `src/commands/sync.ts`, and putting it
// there was wrong twice over.
//
// Architecturally: assembling a wiki section index and calling
// `syncSectionRegistry` is an owner operation, not a transport one. The CLI's
// job in this stage is to parse two flags and print lines; deciding what a
// removal means for the identity registry is core work and belongs beside the
// rest of it.
//
// Measurably: `src/lib/import-policy.live.test.ts` counts every edge from an
// adapter (`src/commands/**`) into a core owner's INTERNALS rather than through
// its `service.ts`. The first version of this stage added five such edges —
// three into `src/wiki/` internals and two into `src/forgetting/` — and the
// ratchet went red the same day the guard was written. Both directions are
// fixed here rather than absorbed by a raised ceiling: these imports are
// core→core now, which the policy does not restrict, and `./service.ts` is the
// one door the adapter goes through.
//
// The write itself is the only propagation the reconcile performs, and it is
// safe in a way a cascade is not: `syncSectionRegistry` only ever ADDS a
// removal record. It deletes no authored content, so the objection in
// `./propagation.ts` — that cascading multiplies a mistake across four layers
// with no undo — does not apply to it.

import { readFile } from "node:fs/promises";
import { collectPages } from "../wiki/collect";
import { buildSectionIndex } from "../wiki/section-index";
import { syncSectionRegistry } from "../wiki/section-tombstone";

export type IdentityLayerOutcome = {
  propagated: boolean;
  cause: string;
  /**
   * The registry's own words when it declined to write, or null.
   *
   * Carried out separately rather than folded into `cause`, because "I declined
   * to write" and "there was nothing to write" are different facts and the
   * journal records them as different outcomes (`refused` vs `reported-only`).
   */
  refusal: string | null;
};

/**
 * Write the tombstones for every registered identity the wiki no longer
 * carries.
 *
 * A refusal from `syncSectionRegistry` (lane B: an unreadable previous
 * registry, a failed write) is returned as a named outcome. Reporting it as a
 * successful propagation would be the precise defect this flow exists to
 * remove — a write that did not happen, filed as one that did.
 */
export async function applyIdentityLayer(
  cwd: string,
  reason: string | undefined,
  at: string,
): Promise<IdentityLayerOutcome> {
  const pages = await collectPages(cwd);
  const index = buildSectionIndex(
    await Promise.all(
      pages.map(async (page) => ({
        page,
        content: await readFile(page.absolutePath, "utf8").catch(() => ""),
      })),
    ),
  );
  const outcome = await syncSectionRegistry(cwd, index, {
    now: at,
    ...(reason ? { reason } : {}),
  });

  if (outcome.status === "refused") {
    return {
      propagated: false,
      cause: `the identity registry refused this write and nothing was recorded: ${outcome.reason}`,
      refusal: outcome.reason,
    };
  }
  return {
    propagated: true,
    cause: `${outcome.tombstoned.length} tombstone(s) written by this run.`,
    refusal: null,
  };
}

/** The outcome for a run that was never going to write — `keryx sync` without `--apply`. */
export function reportOnlyIdentityOutcome(): IdentityLayerOutcome {
  return {
    propagated: false,
    cause:
      "this run is a report. `keryx sync --apply` writes the tombstones; until then every identity below is " +
      "recorded as live in the registry while the wiki no longer carries it.",
    refusal: null,
  };
}
