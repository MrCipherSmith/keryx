// Flow 364 (AC5-AC7): what the governance modal's check and close do — the
// same flow service, built from the same dependencies, as `keryx flow
// check-complete` and `keryx flow complete`. In-process and never through the
// model's JobRegistry: a click must never cost a model turn (the governance
// runner's rule, flow 300).

import { flowServiceDeps, signerIdentityArgs } from "../commands/flow";
import { createFlowService } from "../flow/service";
import type { FlowCompleteResult, FlowCompletionCheck, FlowService } from "../flow/types";

export interface GovernanceFlowActions {
  /** `flow check-complete`: every gate, nothing written. */
  check(id: string): Promise<FlowCompletionCheck>;
  /** `flow complete`, signed exactly as the CLI signs it with no `--signed-by`. */
  close(id: string): Promise<FlowCompleteResult>;
  /** The checked-out branch, named in the close confirmation; `undefined` when git cannot say. */
  branch(): Promise<string | undefined>;
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
    if ((await proc.exited) !== 0) return undefined;
    const name = (await new Response(proc.stdout).text()).trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export function createGovernanceFlowActions(cwd: string, service: FlowService = createFlowService(flowServiceDeps())): GovernanceFlowActions {
  return {
    check: (id) => service.checkComplete({ cwd, id }),
    // The signer falls back exactly as `flow complete` without `--signed-by`
    // does: KERYX_ACTOR, then the local git identity (basis `derived`).
    close: async (id) => service.complete({ cwd, id, ...(await signerIdentityArgs(cwd, undefined)) }),
    branch: () => currentBranch(cwd),
  };
}
