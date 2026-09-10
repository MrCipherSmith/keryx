// The three legs, and why these three.
//
// `keryx-shell` and `grok-build` both drive grok-4.6. That is the whole reason the
// pair exists: with the model held constant, the difference between them is the
// shell around it and nothing else. It is also the only thing this arena can
// answer without leaning on statistics, because wrapper overhead is close to
// deterministic.
//
// `claude-sonnet` is the third because a claim resting on one vendor's model is a
// claim about that vendor. It is sonnet rather than opus on cost grounds: opus
// alone was 26 of 104 arms at roughly $1 each, half the run's budget, for a second
// point on an axis — "does keryx help a strong model as much as a weak one" — that
// is interesting but not the question. Resume is keyed per harness, so adding opus
// later is an append, not a re-run. That is why `harnessId` exists.
//
// Unlike the pilot, `hardModel` and `easyModel` are equal on every spec. The pilot
// picks a model from the gold-set size, which is right when the sweep spans 50
// tasks of varying difficulty and wrong here: a leg whose model changes between
// tasks cannot be compared against a leg whose model does not, and the arena's
// whole point is a controlled comparison.

import path from "node:path";
import { createClaudeAgent } from "../benchmark/retrieval-agent-claude";
import { createGrokAgent } from "../benchmark/retrieval-agent-grok";
import { createKeryxAgent } from "../benchmark/retrieval-agent-keryx";
import type { AgentPort } from "../benchmark/retrieval-run";

export interface ArenaHarnessSpec {
  readonly id: string;
  /** Pinned: the same model on every task, so legs stay comparable. */
  readonly model: string;
  readonly createAgent: (options: { timeoutMs: number }) => AgentPort;
  /** Printed before the sweep, so the model split states itself rather than being described after. */
  readonly note: string;
}

/**
 * The keryx under test is THIS checkout, not the globally installed binary.
 *
 * Not a preference. The adapter reads its transcript from `--events-file`, and the
 * published 0.2.84 does not have that flag — the string appears nowhere in the
 * package, so `keryx shell` answers `Unknown shell argument` and the leg cannot
 * produce a row at all. The events file exists only in this branch.
 *
 * The adapter's own default is `["keryx"]`, i.e. PATH, and its docblock already
 * offers "a path to `src/cli.ts` under bun for a dev build" for exactly this case.
 * Pointing at the branch also means the two provider fixes this measurement needed
 * — the device-code grant reaching `makeProvider`, and the stream being asked for
 * usage — are present, which they are not in the release.
 *
 * Recorded in the report rather than glossed: the keryx leg measures an unreleased
 * build. A reader comparing against `npm i -g @mrciphersmith/keryx` is not
 * comparing against this.
 */
const ARENA_REPO_ROOT = path.resolve(import.meta.dir, "..", "..");
export const KERYX_DEV_COMMAND: readonly string[] = ["bun", path.join(ARENA_REPO_ROOT, "src", "cli.ts")];

export const KERYX_SHELL: ArenaHarnessSpec = {
  id: "keryx-shell",
  model: "grok-4.6",
  createAgent: ({ timeoutMs }) =>
    createKeryxAgent({ timeoutMs, provider: "grok", harnessId: "keryx-shell", command: KERYX_DEV_COMMAND }),
  note: "keryx's own shell on grok-4.6, built from this checkout — the release has no --events-file",
};

export const GROK_BUILD: ArenaHarnessSpec = {
  id: "grok-build",
  model: "grok-4.6",
  createAgent: ({ timeoutMs }) => createGrokAgent({ timeoutMs, harnessId: "grok-build" }),
  note: "the grok CLI on grok-4.6 — the control for the wrapper comparison",
};

/**
 * Model ids are the explicit ones, not the short aliases.
 *
 * `sonnet-5` is rejected outright — `[claude-code:unrecognized_model]` — which the
 * smoke run discovered by failing both claude arms. And the bare alias `sonnet` is
 * worse than wrong: it resolves, but on the same two-token prompt it billed $0.105
 * against `claude-sonnet-5`'s $0.0088, so it is not the model this leg claims to
 * measure. A leg whose model id is an alias is a leg whose cost and quality belong
 * to whatever that alias pointed at on the day.
 */
export const CLAUDE_SONNET: ArenaHarnessSpec = {
  id: "claude-sonnet",
  model: "claude-sonnet-5",
  createAgent: ({ timeoutMs }) => createClaudeAgent({ timeoutMs, harnessId: "claude-sonnet" }),
  note: "a second vendor, so the result is not a claim about one model family",
};

/**
 * Deliberately not registered, and kept here rather than deleted.
 *
 * Adding opus is two lines and ~$25. It is listed so the decision is visible as a
 * decision — a reader should be able to see that the axis was considered and
 * priced, not that nobody thought of it.
 */
export const CLAUDE_OPUS_DEFERRED: ArenaHarnessSpec = {
  id: "claude-opus",
  model: "claude-opus-5",
  createAgent: ({ timeoutMs }) => createClaudeAgent({ timeoutMs, harnessId: "claude-opus" }),
  note: "deferred on cost: ~$25 for the strong-versus-weak-model axis; resume is per harness, so this appends",
};

export const ARENA_HARNESSES: readonly ArenaHarnessSpec[] = [KERYX_SHELL, GROK_BUILD, CLAUDE_SONNET];

export function harnessById(id: string): ArenaHarnessSpec {
  const found = [...ARENA_HARNESSES, CLAUDE_OPUS_DEFERRED].find((spec) => spec.id === id);
  if (found === undefined) {
    const known = [...ARENA_HARNESSES, CLAUDE_OPUS_DEFERRED].map((spec) => spec.id).join(", ");
    throw new Error(`unknown harness ${JSON.stringify(id)} — known: ${known}`);
  }
  return found;
}

/**
 * Legs sharing a model, which the wrapper comparison depends on.
 *
 * Asserted rather than assumed: if someone repoints `keryx-shell` at grok-4.5 the
 * pair stops being a controlled comparison, and the failure would otherwise show
 * up as an unexplained difference in the results rather than as a broken test.
 */
export function modelPeers(): Map<string, string[]> {
  const peers = new Map<string, string[]>();
  for (const spec of ARENA_HARNESSES) {
    const existing = peers.get(spec.model) ?? [];
    existing.push(spec.id);
    peers.set(spec.model, existing);
  }
  return peers;
}
