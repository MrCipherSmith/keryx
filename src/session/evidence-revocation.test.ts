import { expect, test } from "bun:test";
import { createSessionEvidenceOwner, isSessionEvidenceId } from "./evidence-revocation";

test("owner refuses success without a lifecycle backend", async () => {
  const owner = createSessionEvidenceOwner({ projectRoot: "/project" });
  expect(await owner.revokeSessionEvidence("session-1")).toEqual({ code: "unavailable" });
});

test("owner rejects unsafe identifiers before invoking backend", async () => {
  let calls = 0;
  const owner = createSessionEvidenceOwner({ projectRoot: "/project", revokeAndDrain: async () => { calls++; } });
  for (const id of ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b", "a\0b"]) {
    expect((await owner.revokeSessionEvidence(id)).code).toBe("invalid-session");
  }
  expect(calls).toBe(0);
});

test("owner pins runtime scope, awaits durable revocation and reader drain", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const scopes: unknown[] = [];
  const options = { projectRoot: "/project", revokeAndDrain: async (scope: unknown) => { scopes.push(scope); await gate; } };
  const owner = createSessionEvidenceOwner(options);
  options.projectRoot = "/other";
  let delivered = false;
  const pending = owner.revokeSessionEvidence("session-1").then(result => { delivered = true; return result; });
  await Promise.resolve();
  expect(delivered).toBe(false);
  expect(scopes).toEqual([{ projectRoot: "/project", sessionId: "session-1", sourceKind: "session-archive" }]);
  finish();
  expect(await pending).toEqual({ code: "revoked" });
});

test("ledger or drain failure never reports deletion success", async () => {
  const owner = createSessionEvidenceOwner({ projectRoot: "/project", revokeAndDrain: async () => { throw new Error("disk failure"); } });
  expect(await owner.revokeSessionEvidence("session-1")).toEqual({ code: "unavailable" });
});

// The owner seam does not erase archives or expose ACP session/delete.


test("shared ERL identifiers accept dotted IDs with an exact length bound", () => {
  for (const id of ["session.1", "a_b-c.d", "a".repeat(200)]) expect(isSessionEvidenceId(id)).toBe(true);
  for (const id of [undefined, null, 1, "", ".", "..", "../a", "/a", "a/b", "a\\b", "a\0b", "a".repeat(201)]) {
    expect(isSessionEvidenceId(id)).toBe(false);
  }
});
