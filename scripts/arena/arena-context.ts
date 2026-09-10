// What the arena ablates, and what it refuses to ablate.
//
// The pilot strips `[".metaproject", "AGENTS.md", "CLAUDE.md"]`
// (`retrieval-run.ts:22`) — the whole instruction layer — because on the keryx
// repository those three ARE keryx's contribution. On vantage-frontend they are
// not: `AGENTS.md` (~781 tokens), `CLAUDE.md` (~4,920) and ten
// `.claude/rules/*.md` (~29,500) are that team's own conventions, written before
// keryx existed and present in every developer's checkout. Deleting them from the
// control arm would not be measuring keryx; it would be measuring what happens
// when you take a codebase's documentation away.
//
// So the arena ablates `.metaproject/` and keryx's managed hooks, and nothing
// else. Two consequences, both of which must be said out loud rather than
// discovered later:
//
//  1. `assertArmContext` as the pilot wrote it refuses any `context-off` arm that
//     still holds AGENTS.md or CLAUDE.md — which is every arena control arm. It
//     takes the path list as a parameter, so the function is reused; the constant
//     is not.
//  2. The arena's number and the pilot's number answer different questions and
//     must never appear in one table.

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { assertArmContext as assertArmContextWith, inventoryContext, stripKeryxHooks } from "../benchmark/retrieval-ablation";

/**
 * The only thing the arena takes away.
 *
 * One entry, deliberately. Every addition to this list widens the claim from
 * "keryx's workspace helped" toward "having documentation helped", and the second
 * is not in question.
 */
export const ARENA_CONTEXT_PATHS: readonly string[] = [".metaproject"];

export interface ArenaInventory {
  readonly wikiPages: number;
  readonly hasGraphDb: boolean;
  readonly hasRoutingIndex: boolean;
  /** T2 cannot run without them: an agent that cannot build cannot check its own work. */
  readonly hasNodeModules: boolean;
  /** The commit the workspace was derived from, for the ancestry assertion. */
  readonly provisionCommit: string | undefined;
}

/**
 * Take `.metaproject/` and keryx's hooks out of a control arm, and nothing else.
 *
 * `stripKeryxHooks` is reused verbatim: it removes only hook groups carrying the
 * `_keryxManaged` marker, leaving the project's own hooks in place for BOTH arms.
 * A control arm that lost the repository's own tooling would be handicapped, and a
 * handicapped control arm manufactures a win for the context arm.
 */
export function arenaStripContext(treePath: string): void {
  for (const entry of ARENA_CONTEXT_PATHS) {
    rmSync(path.join(treePath, entry), { recursive: true, force: true });
  }
  stripKeryxHooks(treePath);
}

/**
 * Refuse an arm whose workspace is not the one the measurement claims.
 *
 * Delegates to the pilot's assertion with the arena's narrower path list. Kept as
 * a wrapper rather than a direct call at each site so there is exactly one place
 * that knows the arena's ablation is narrower, and so a future widening shows up
 * in one diff.
 */
export function assertArenaArmContext(treePath: string, arm: "context-on" | "context-off"): void {
  assertArmContextWith(treePath, arm, ARENA_CONTEXT_PATHS);
}

/**
 * What the arm actually held, recorded in its result row.
 *
 * Inventory is not decoration. `hasGraphDb === false` on a `context-on` arm means
 * provisioning silently failed and the arm measured nothing; the pilot relies on
 * exactly that signal. `hasNodeModules` is the arena's addition, and it exists
 * because its absence is a floor effect rather than a bias: both arms fail equally
 * and the cell reports a confident zero, which is worse than reporting nothing.
 */
export function arenaInventory(treePath: string, provisionCommit?: string): ArenaInventory {
  const base = inventoryContext(treePath);
  return {
    wikiPages: base.wikiPages,
    hasGraphDb: base.hasGraphDb,
    hasRoutingIndex: base.hasRoutingIndex,
    hasNodeModules: existsSync(path.join(treePath, "node_modules")),
    provisionCommit,
  };
}

/**
 * Refuse a T2 arm that cannot build.
 *
 * T1 is exempt by design: it asks for file paths, so there is nothing to compile
 * and thirteen base commits do not need thirteen installs. T2 implements a change
 * and is expected to check it, so an arm without dependencies would spend its
 * budget on an install that the isolated environment has no network to complete,
 * then die to the watchdog — in both arms equally, which turns the cell into a
 * confident null rather than a measurement.
 */
export function assertBuildable(inventory: ArenaInventory, taskType: string, treePath: string): void {
  if (taskType !== "implement") return;
  if (inventory.hasNodeModules) return;
  throw new Error(
    `${treePath} has no node_modules and the task type is "implement" — ` +
      "the arm could neither build nor test its own change, and network is off by design, " +
      "so it would burn its budget on an impossible install and report a confident zero",
  );
}
