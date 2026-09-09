// The model-turn seam itself: precedence, the process-wide registration a
// client performs, and the refusal that has to be audible.
//
// Two defect classes this repository keeps re-finding are in scope here and are
// tested, not assumed:
//
//   * "a capability living in a helper nothing calls" — `setModelTurnPort` is a
//     registration function whose only consumers are outside core, so it would
//     look identical whether it worked or not. The registry is therefore driven
//     end-to-end through a REAL call site (`resolveOrCreateWorkspace`), not
//     just read back with `getModelTurnPort`.
//   * "a failure rendered indistinguishable from a legitimate result" — an
//     absent port must not read as "the model had nothing to say". The stderr
//     line is asserted on, including that it is emitted exactly once.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { resetWarnOnce } from "../capability/warn-once";
import {
  getModelTurnPort,
  resolveModelTurnPort,
  setModelTurnPort,
  warnModelTurnUnavailable,
  type ModelTurnPort,
} from "./model-turn-port";
import { resolveOrCreateWorkspace } from "./workspace-resolve";
import { WorkspaceService, localWorkspaceAuthorizationServer } from "./workspace-service";

beforeEach(() => {
  // The registry and the warn-once ledger are both process-scoped, so every
  // test starts from "no client has wired anything yet".
  setModelTurnPort(undefined);
  resetWarnOnce();
});

afterEach(() => {
  setModelTurnPort(undefined);
});

/** Capture what is written to stderr while `run` executes. */
async function capturingStderr(run: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = "";
  (process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    captured += chunk;
    return true;
  };
  try {
    await run();
  } finally {
    (process.stderr as unknown as { write: typeof original }).write = original;
  }
  return captured;
}

async function tempCwdWithWorkspace(): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "keryx-model-turn-port-"));
  const service = new WorkspaceService({
    workspaceRoot: cwd,
    authorizationServer: localWorkspaceAuthorizationServer(),
    strictGuard: { mode: "strict", availability: "available", decision: "pass", policyRevision: "local-offline-v1" },
  });
  // One existing workspace, so `resolveOrCreateWorkspace` has something to judge
  // over and actually reaches the model-turn seam (an empty list short-circuits).
  await service.create({ request: undefined, requestCorrelationId: randomUUID(), id: "workspace-a", title: "An existing topic" });
  return cwd;
}

test("nothing is registered by default — core ships no model-turn implementation of its own", () => {
  expect(getModelTurnPort()).toBeUndefined();
  expect(resolveModelTurnPort()).toBeUndefined();
});

test("an explicitly passed port wins over the process-wide registration", async () => {
  const registered: ModelTurnPort = async () => ({ credentialAvailable: true, text: "registered" });
  const explicit: ModelTurnPort = async () => ({ credentialAvailable: true, text: "explicit" });
  setModelTurnPort(registered);

  expect(getModelTurnPort()).toBe(registered);
  expect(resolveModelTurnPort()).toBe(registered);
  expect(resolveModelTurnPort(explicit)).toBe(explicit);
  // …and the winner is the one that actually runs.
  await expect(resolveModelTurnPort(explicit)!({ system: "s", user: "u", requestId: "r" })).resolves.toEqual({
    credentialAvailable: true,
    text: "explicit",
  });
});

test("a client that registers a port makes a real core call site work again", async () => {
  const cwd = await tempCwdWithWorkspace();
  let sawRequest = "";

  // Exactly the wiring a client entry point performs — one line, no core edit:
  setModelTurnPort(async (request) => {
    sawRequest = request.requestId;
    return { credentialAvailable: true, text: "BIND workspace-a" };
  });

  const result = await resolveOrCreateWorkspace({ cwd, topicHint: "more of the existing topic", env: {} });
  expect(result).toEqual({ ok: true, action: "bound-existing", workspaceId: "workspace-a" });
  // The registered port really was the thing that answered.
  expect(sawRequest).toBe("workspace-resolve");
});

test("clearing the registration puts the call site back to refusing", async () => {
  const cwd = await tempCwdWithWorkspace();
  setModelTurnPort(async () => ({ credentialAvailable: true, text: "BIND workspace-a" }));
  expect(await resolveOrCreateWorkspace({ cwd, topicHint: "topic", env: {} })).toMatchObject({ ok: true });

  setModelTurnPort(undefined);
  expect(await resolveOrCreateWorkspace({ cwd, topicHint: "topic", env: {} })).toEqual({
    ok: false,
    reason: "no_model_turn",
  });
});

test("the refusal is audible on stderr, names the call site, and is said once per process", async () => {
  const cwd = await tempCwdWithWorkspace();
  const captured = await capturingStderr(async () => {
    await resolveOrCreateWorkspace({ cwd, topicHint: "first attempt", env: {} });
    await resolveOrCreateWorkspace({ cwd, topicHint: "second attempt", env: {} });
  });

  expect(captured).toContain("workspace-resolve");
  expect(captured).toContain("no model-turn port supplied");
  expect(captured).toContain("refused");
  // Once, not once per call — the same discipline `capability/warn-once.ts`
  // applies to a degraded capability.
  expect(captured.split("no model-turn port supplied").length - 1).toBe(1);
  // And it must not claim a fallback ran: nothing was substituted for the
  // judgment, which is the whole point of calling it a refusal.
  expect(captured).not.toContain("using deterministic fallback");
});

test("each call site is warned about separately — one silenced key never hides another", async () => {
  const captured = await capturingStderr(async () => {
    warnModelTurnUnavailable("machine-wrap-up");
    warnModelTurnUnavailable("machine-wrap-up");
    warnModelTurnUnavailable("decision-dedup-annotation");
  });
  expect(captured.split("\n").filter((line) => line.includes("[sac]"))).toHaveLength(2);
  expect(captured).toContain("machine-wrap-up");
  expect(captured).toContain("decision-dedup-annotation");
});
