// The arena's environment rules, on top of the shared isolation module.
//
// `scripts/benchmark/retrieval-isolation.ts` already builds an arm's environment
// by allowlist and refuses configuration redirectors and answer-reaching tokens.
// The arena adds one thing the pilot deliberately does NOT do, and the difference
// has to be declared rather than assumed, because the two runs are otherwise not
// comparable:
//
//   The pilot leaves `keryx` on PATH in BOTH arms and verifies the ablation
//   indirectly, through `inventoryAfter.hasGraphDb === false`. Its reasoning is
//   sound on its own terms — both arms get the same tool roster, so an advantage
//   cannot come from one arm holding a binary the other lacks.
//
//   The arena takes it off PATH in the control arm and ASSERTS it. On a repository
//   with no `.metaproject/` the binary is not inert: `keryx ctx rg` still searches,
//   `keryx ctx read` still compacts, and those are capabilities under test. An arm
//   that can call them is not a without-keryx arm, whatever its graph database
//   looks like.
//
// Neither choice is free. The pilot's keeps the rosters identical and risks a
// control arm quietly using the tool. The arena's guarantees the ablation and
// accepts that the two arms differ by one binary on PATH. Both are stated in the
// report; what is not acceptable is choosing one and describing the other.

import { existsSync } from "node:fs";
import path from "node:path";
import { assertEnvIsolated, buildIsolatedEnv, type IsolatedEnvRequest } from "../benchmark/retrieval-isolation";

export type ArenaArm = "context-on" | "context-off";

/**
 * Remove every directory holding a `keryx` executable from a PATH.
 *
 * Entry-wise rather than by string match, so a directory merely *named* something
 * containing "keryx" survives while the one that actually resolves the binary does
 * not. The test for "is it gone" is resolution, never spelling.
 */
export function pathWithoutKeryx(pathValue: string): string {
  return pathValue
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && !existsSync(path.join(entry, "keryx")))
    .join(path.delimiter);
}

/**
 * Refuse a control arm that can still invoke the system under test.
 *
 * Resolution, not spelling: the check is whether some PATH entry holds an
 * executable called `keryx`. A control arm that can run `keryx ctx rg` has the
 * search capability the ablation was supposed to remove, and its zero would be
 * read as "context did not help" when it means "the control arm used the context
 * tooling".
 */
export function assertKeryxAbsent(env: Record<string, string>, arm: ArenaArm): void {
  if (arm !== "context-off") return;
  const resolved = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry.length > 0 && existsSync(path.join(entry, "keryx")));
  if (resolved.length > 0) {
    throw new Error(
      `the context-off arm can still resolve \`keryx\` via ${resolved.join(", ")} — ` +
        "on a tree with no .metaproject the binary is not inert (`keryx ctx rg` still searches, " +
        "`keryx ctx read` still compacts), so this is not a without-keryx arm",
    );
  }
}

export interface ArenaEnvRequest extends IsolatedEnvRequest {
  readonly arm: ArenaArm;
  readonly harness: string;
}

/**
 * Build an arm's environment and prove it is the one claimed.
 *
 * The order matters: strip PATH first, then assert. Asserting a PATH you then
 * modify proves nothing, and that mistake is invisible in a passing test.
 */
export function buildArenaEnv(request: ArenaEnvRequest): Record<string, string> {
  const env = buildIsolatedEnv(request);
  if (request.arm === "context-off" && env.PATH !== undefined) {
    env.PATH = pathWithoutKeryx(env.PATH);
  }
  assertEnvIsolated(env, request.harness, request.overrides ?? {});
  assertKeryxAbsent(env, request.arm);
  return env;
}
