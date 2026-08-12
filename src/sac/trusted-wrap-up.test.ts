import { expect, test } from "bun:test";
import { createSacAuthorizationServer } from "./index";
import { createTrustedWrapUpAuthority } from "./trusted-wrap-up";

const evidence = [{ kind: "evidence", uri: "./evidence/wrap-up.md", revision: "e1", observedAt: "2026-08-12T00:00:00.000Z" }];
const resolve = async () => ({ workspaceId: "workspace-a", sourceRevision: "snapshot-r1", summary: "finished explicit wrap-up", evidence, expiresAt: "2026-08-12T01:00:00.000Z" });

async function actor(subject: string) {
  const server = createSacAuthorizationServer({ authenticateRequest: async () => ({ subject, authenticationMethod: "trusted-harness" as const, roleRevision: "roles-r1" }) });
  return (await server.actorContextFor(undefined, "wrap-up-correlation-0001"))!;
}

test("only server-issued explicit wrap-ups authorize one matching proposal and Flow source is read-only", async () => {
  const authority = createTrustedWrapUpAuthority({ now: () => new Date("2026-08-12T00:00:00.000Z"), resolveExplicitWrapUp: resolve });
  const issuer = await actor("agent:writer"); const other = await actor("agent:other");
  const provenance = await authority.issue({ actor: issuer, source: "flow", sourceRef: "./flows/149-snapshot.json" });
  expect(provenance.source).toBe("flow");
  expect(authority.verify(provenance, { actor: other, workspaceId: "workspace-a" })).toBe("mismatch");
  expect(authority.verify(provenance, { actor: issuer, workspaceId: "workspace-b" })).toBe("mismatch");
  expect(authority.consume(provenance, { actor: issuer, workspaceId: "workspace-a" })).toBe("ok");
  expect(authority.consume(provenance, { actor: issuer, workspaceId: "workspace-a" })).toBe("replayed");
});

test("expired provenance never authorizes", async () => {
  let now = new Date("2026-08-12T00:00:00.000Z");
  const authority = createTrustedWrapUpAuthority({ now: () => now, resolveExplicitWrapUp: async () => ({ ...await resolve(), expiresAt: "2026-08-12T00:01:00.000Z" }) }); const issuer = await actor("agent:writer");
  const provenance = await authority.issue({ actor: issuer, source: "session", sourceRef: "./sessions/wrap-up.json" });
  now = new Date("2026-08-12T00:02:00.000Z");
  expect(authority.consume(provenance, { actor: issuer, workspaceId: "workspace-a" })).toBe("expired");
});
