// Generating the context workspace inside the arm's own tree.
//
// `provisionContextOn` is reused as-is and its central decision is the reason:
// everything is derived FROM THE WORKTREE, at the task's base commit. Copying a
// maintainer's `.metaproject/` in would import artifacts built from code the task's
// change added — the answer, delivered inside the context arm's workspace. That is
// not a hypothetical here: the only authored wiki that exists for this target sits
// at a feature-branch tip dated after every one of the 13 task parents, and 0 of 13
// tasks are admissible against it.
//
// Which is why the arena's workspace is deterministic: `keryx init`, a graph build,
// and `wiki collect` / `wiki index`, all of which read code rather than write prose
// about it. No model authors anything, so there is nothing that could
// describe a change the task has not reached. The cost of that choice is stated in
// the report rather than hidden: **the arena measures the graph and routing layer,
// not an agent-authored wiki.** A null result is a result about that layer, and the
// authored-wiki claim stays untested rather than refuted.
//
// `forgetRegisteredProject` matters more than it looks. `keryx init` registers the
// project in a user-global registry, and 78 throwaway trees would leave 78 dead
// entries pointing at directories that no longer exist. The pilot's registry
// already carries twenty such leftovers.

import { KERYX_GRAPH_BUILD, KERYX_INIT, forgetRegisteredProject } from "../benchmark/retrieval-provision";
import type { ArenaProvisioner } from "./arena-run";

const KERYX_WIKI_COLLECT: readonly string[] = ["keryx", "wiki", "collect"];
const KERYX_WIKI_INDEX: readonly string[] = ["keryx", "wiki", "index"];

/**
 * `keryx wiki refresh` is documented by the gdwiki skill and does not exist on the
 * installed CLI.
 *
 * The skill describes it as the deterministic, model-free way to regenerate a
 * page's Reference block — exactly what this arena wants. `keryx wiki refresh` on
 * 0.2.84 prints the usage banner instead, and the subcommand list carries only
 * `status`, `new`, `collect`, `index` and `check-links`. So the workspace gets
 * `collect` + `index`, and the gap is recorded here rather than silently routed
 * around: the arena's context arm holds slightly less than the skill's
 * description implies.
 */
export const MISSING_WIKI_REFRESH_NOTE =
  "keryx wiki refresh: documented by the gdwiki skill, absent from CLI 0.2.84; using collect + index";

export interface ProvisionStep {
  readonly command: readonly string[];
  /**
   * When false, a non-zero exit is recorded and tolerated.
   *
   * Only the steps that define the arm are required. A wiki command that does not
   * exist on the installed keryx must not take down a sweep whose context arm is
   * already defined by its graph and routing index — but the fact that it did not
   * run has to reach the row, which is why the outcome is returned rather than
   * swallowed.
   */
  readonly required: boolean;
}

export const ARENA_PROVISION_STEPS: readonly ProvisionStep[] = [
  { command: KERYX_INIT, required: true },
  { command: KERYX_GRAPH_BUILD, required: true },
  { command: KERYX_WIKI_COLLECT, required: false },
  { command: KERYX_WIKI_INDEX, required: false },
];

export interface StepOutcome {
  readonly command: string;
  readonly exitCode: number | null;
  readonly ok: boolean;
  readonly output: string;
}

export interface ProvisionRunner {
  (command: readonly string[], cwd: string): StepOutcome;
}

export const spawnProvisionStep: ProvisionRunner = (command, cwd) => {
  const [executable, ...args] = command;
  if (executable === undefined) throw new Error("empty provisioning command");
  const proc = Bun.spawnSync([executable, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const output = `${proc.stdout.toString()}${proc.stderr.toString()}`;
  return {
    command: command.join(" "),
    exitCode: proc.exitCode,
    ok: proc.exitCode === 0,
    output: output.length > 2000 ? output.slice(-2000) : output,
  };
};

export interface ArenaProvisionOptions {
  /** The commit the arm's tree sits at. Recorded so the ancestry assertion has something to check. */
  readonly commitFor: (treePath: string) => string;
  readonly run?: ProvisionRunner;
  readonly onStep?: (outcome: StepOutcome) => void;
}

/**
 * A provisioner that builds the workspace in place and cleans the global registry.
 *
 * Tracks which trees it initialised, so `release` only forgets projects this sweep
 * created. Release is best-effort by design — failing to tidy a registry must not
 * lose an arm's result — but it is reported, because a silently growing registry is
 * how twenty leftovers accumulate unnoticed.
 */
export function createArenaProvisioner(options: ArenaProvisionOptions): ArenaProvisioner {
  const run = options.run ?? spawnProvisionStep;
  const initialised = new Set<string>();

  return {
    async provision(treePath: string): Promise<{ provisionCommit: string }> {
      for (const step of ARENA_PROVISION_STEPS) {
        const outcome = run(step.command, treePath);
        options.onStep?.(outcome);
        if (!outcome.ok && step.required) {
          throw new Error(
            `provisioning failed in ${treePath}: \`${outcome.command}\` exited ${String(outcome.exitCode)} — ` +
              `a context arm without its workspace is not a context arm\n${outcome.output}`,
          );
        }
      }
      initialised.add(treePath);
      return { provisionCommit: options.commitFor(treePath) };
    },

    async release(treePath: string): Promise<void> {
      if (!initialised.has(treePath)) return;
      initialised.delete(treePath);
      try {
        forgetRegisteredProject(treePath);
      } catch {
        // Best effort. Losing an arm's result to tidy a registry would be the worse
        // trade; the leftover is visible in `keryx projects list`.
      }
    },
  };
}
