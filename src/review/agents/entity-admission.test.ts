import { describe, expect, test } from "bun:test";
import { loadAgentCatalog, type AgentCatalog } from "../../agents/catalog";
import type { AgentDefinition, LoadedAgent } from "../../agents/types";
import {
  authorizeReviewAgentSourceAction,
  createReviewAgentEntityPolicyResolver,
  resolveReviewAgentEntityAdmission,
} from "./entity-admission";

const catalog = loadAgentCatalog(process.cwd());
const BASE_REQUEST = {
  entity: "review-worker",
  requestedRole: "worker" as const,
  allowedEntities: ["review-coordinator", "review-worker", "review-scout", "review-validator"],
  allowedSkills: ["review-logic", "review-verifier"],
};

function fixtureCatalog(definition: AgentDefinition): AgentCatalog {
  const loaded: LoadedAgent = {
    definition,
    source: { kind: "project", path: `/fixture/${definition.name}.md` },
    raw: "fixture",
  };
  return { agents: [loaded], errors: [] };
}

describe("resolveReviewAgentEntityAdmission", () => {
  test("resolves an exact entity and derives role instead of trusting requestedRole", () => {
    expect(resolveReviewAgentEntityAdmission(catalog, BASE_REQUEST).ok).toBe(true);
    const spoofed = resolveReviewAgentEntityAdmission(catalog, { ...BASE_REQUEST, requestedRole: "coordinator" });
    expect(spoofed).toMatchObject({ ok: false, disposition: "denied", code: "role_mismatch" });
    const wrongCase = resolveReviewAgentEntityAdmission(catalog, { ...BASE_REQUEST, entity: "Review-Worker" });
    expect(wrongCase).toMatchObject({ ok: false, disposition: "denied", code: "entity_not_found" });
  });

  test("returns the coordinator's normalized bounded policy without claiming source enforcement", () => {
    const result = resolveReviewAgentEntityAdmission(catalog, {
      ...BASE_REQUEST,
      entity: "review-coordinator",
      requestedRole: "coordinator",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.binding.role).toBe("coordinator");
    expect(result.binding.executionKind).toBe("orchestrator");
    expect(result.binding.allowedChildren).toContain("review-worker");
    expect(result.binding.sourcePolicy).toEqual({
      sourceRead: true,
      sourceWrite: false,
      resultWrite: true,
      enforcement: "adapter-required",
    });
  });

  test("enforces parent-child delegation and rejects general-to-general and leaf delegation", () => {
    const child = resolveReviewAgentEntityAdmission(catalog, { ...BASE_REQUEST, parentEntity: "review-coordinator" });
    expect(child.ok).toBe(true);
    const general = resolveReviewAgentEntityAdmission(catalog, {
      ...BASE_REQUEST,
      entity: "review-coordinator",
      requestedRole: "coordinator",
      parentEntity: "review-coordinator",
    });
    expect(general).toMatchObject({ ok: false, disposition: "denied", code: "general_child_denied" });
    const leafParent = resolveReviewAgentEntityAdmission(catalog, { ...BASE_REQUEST, parentEntity: "review-scout" });
    expect(leafParent).toMatchObject({ ok: false, disposition: "denied", code: "parent_not_orchestrator" });
  });

  test("requires both run and entity skill allowlists", () => {
    const allowed = resolveReviewAgentEntityAdmission(catalog, { ...BASE_REQUEST, skillRef: "review-logic" });
    expect(allowed.ok).toBe(true);
    const runDenied = resolveReviewAgentEntityAdmission(catalog, {
      ...BASE_REQUEST,
      allowedSkills: ["review-verifier"],
      skillRef: "review-logic",
    });
    expect(runDenied).toMatchObject({ ok: false, code: "skill_not_allowed_by_run" });
    const entityDenied = resolveReviewAgentEntityAdmission(catalog, { ...BASE_REQUEST, skillRef: "review-verifier" });
    expect(entityDenied).toMatchObject({ ok: false, code: "skill_not_allowed_by_entity" });
  });

  test("does not silently narrow writable or contradictory definitions", () => {
    const writable: AgentDefinition = {
      name: "legacy-writer",
      description: "legacy writable entity",
      role: "worker",
      tools: ["read_file", "apply_patch"],
      model_tier: "standard",
      policy_profile: "workspace-write",
      skills: [],
      stacks: [],
      output_contract: "subagent-result",
      isolation: "none",
      body: "write",
    };
    const unsupported = resolveReviewAgentEntityAdmission(fixtureCatalog(writable), {
      ...BASE_REQUEST,
      entity: "legacy-writer",
      allowedEntities: ["legacy-writer"],
    });
    expect(unsupported).toMatchObject({ ok: false, disposition: "unsupported", code: "source_policy_unsupported" });

    const contradictory: AgentDefinition = { ...writable, name: "bad-reader", policy_profile: "read-only" };
    const invalid = resolveReviewAgentEntityAdmission(fixtureCatalog(contradictory), {
      ...BASE_REQUEST,
      entity: "bad-reader",
      allowedEntities: ["bad-reader"],
    });
    expect(invalid).toMatchObject({ ok: false, disposition: "unsupported", code: "invalid_entity_contract" });
  });

  test("keeps legacy read-only leaves truthful and exposes a controller policy resolver", async () => {
    const legacy: AgentDefinition = {
      name: "legacy-reader",
      description: "legacy reader",
      role: "worker",
      tools: ["read_file"],
      model_tier: "standard",
      policy_profile: "read-only",
      skills: [],
      stacks: [],
      output_contract: "subagent-result",
      isolation: "none",
      body: "read",
    };
    const legacyCatalog = fixtureCatalog(legacy);
    const result = resolveReviewAgentEntityAdmission(legacyCatalog, {
      ...BASE_REQUEST,
      entity: "legacy-reader",
      allowedEntities: ["legacy-reader"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.legacyDefinition).toBe(true);
      expect(result.binding.sourcePolicy.enforcement).toBe("adapter-required");
    }
    expect(await createReviewAgentEntityPolicyResolver(legacyCatalog).resolve("legacy-reader")).toEqual({
      name: "legacy-reader",
      role: "worker",
      allowedSkills: [],
      allowedChildren: [],
    });
  });
});

describe("authorizeReviewAgentSourceAction", () => {
  test("permits source reads and result writes but explicitly denies source writes", () => {
    expect(authorizeReviewAgentSourceAction("read-source")).toEqual({ ok: true });
    expect(authorizeReviewAgentSourceAction("write-result")).toEqual({ ok: true });
    expect(authorizeReviewAgentSourceAction("write-source")).toMatchObject({
      ok: false,
      disposition: "denied",
      code: "source_write_denied",
    });
  });
});
