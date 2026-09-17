// flow 268 T18 — guard test: the machine-triggered wrap-up summary
// (`resolveMachineWrapUp`, this module's memory/evidence writer — see
// `./machine-wrap-up.ts`'s own top-of-file comment) must be built only from
// the injected model-turn port's `.text`, never from a `reasoning` field
// (AC12).
//
// `ModelTurnPort`'s result type, `ModelTurnOutcome`
// (`./model-turn-port.ts`), structurally carries only `credentialAvailable`
// and `text` — no `reasoning` field exists on the contract at all. That is
// itself the guard: `resolveMachineWrapUp` (see `machine-wrap-up.ts` around
// `summary = result.text.trim()...`) cannot read a reasoning field it was
// never given. This test pins that behaviourally: a port implementation that
// (incorrectly, defensively) attaches extra reasoning-shaped data alongside
// `.text` must still never have that data surface in the written summary,
// because the consumer only ever reads `.text`.

import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveMachineWrapUp } from "./machine-wrap-up";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";
import type { Slate, SlateSeed } from "../session/slate";
import type { ModelTurnOutcome, ModelTurnPort } from "./model-turn-port";

const REASONING_MARKER = "REASONING-MARKER-268";
const time = "2026-08-16T00:00:00.000Z";

async function tempGitCwd(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-machine-wrapup-reasoning-guard-"));
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Test"], { cwd });
  return cwd;
}

async function createWorkspace(cwd: string, workspaceId: string): Promise<void> {
  const workspaces = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
    now: () => new Date(time),
  });
  await workspaces.create({ request: undefined, requestCorrelationId: "reasoning-guard-fixture-0001", id: workspaceId, title: "Wrap-up target" });
}

function seed(id: string, text: string, kind?: SlateSeed["kind"]): SlateSeed {
  return { id, text, ts: time, ...(kind !== undefined ? { kind } : {}) };
}

function baseSlate(overrides: Partial<Slate> = {}): Slate {
  return {
    anchors: { root: "/tmp/does-not-matter", touched: [] },
    course: {},
    seeds: [],
    ...overrides,
  };
}

/**
 * A port whose declared return type (`ModelTurnOutcome`) has no `reasoning`
 * field, but whose runtime object (deliberately, to simulate a leaky
 * implementation) attaches one anyway alongside a clean `.text`. Proves
 * `resolveMachineWrapUp` reads only `.text`.
 */
function leakyModelTurn(answerText: string): ModelTurnPort {
  return async () =>
    ({
      credentialAvailable: true,
      text: answerText,
      reasoning: { text: `${REASONING_MARKER} internal chain-of-thought, never meant for the summary` },
    }) as ModelTurnOutcome;
}

test("flow 268 T18: resolveMachineWrapUp's summary never contains a reasoning marker attached to the model-turn outcome (AC12)", async () => {
  const cwd = await tempGitCwd();
  await createWorkspace(cwd, "workspace-a");

  const result = await resolveMachineWrapUp({
    cwd,
    workspaceId: "workspace-a",
    slate: baseSlate({ workspaceId: "workspace-a", seeds: [seed("s1", "a real finding", "decision")] }),
    kind: "decision",
    now: () => new Date(time),
    modelTurn: leakyModelTurn("machine-authored summary with no reasoning in it"),
  });

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.resolution.summary).toBe("machine-authored summary with no reasoning in it");
  expect(result.resolution.summary).not.toContain(REASONING_MARKER);
});
