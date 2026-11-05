import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";

const ROOT = path.join(
  import.meta.dir,
  "bundled",
  "skills",
  "review",
  "review-orchestrator",
);
const SKILL = readFileSync(path.join(ROOT, "SKILL.md"), "utf8");
const DETAIL = readFileSync(path.join(ROOT, "SKILL.detail.md"), "utf8");
const ORCHESTRATOR_TEXT = `${SKILL}\n${DETAIL}`;

describe("review-orchestrator Review agents opt-in contract", () => {
  test("keeps legacy as the default and fails closed when the exact host surface is unavailable", () => {
    expect(ORCHESTRATOR_TEXT).toContain("--hierarchical");
    expect(ORCHESTRATOR_TEXT).toMatch(/legacy[^\n]*default/i);
    for (const tool of [
      "review_agents_start",
      "review_agents_plan",
      "review_agents_spawn",
      "review_agents_status",
      "review_agents_wait",
      "review_agents_result",
      "review_agents_cancel",
    ]) {
      expect(ORCHESTRATOR_TEXT).toContain(tool);
    }
    expect(ORCHESTRATOR_TEXT).toContain("STATUS: BLOCKED hierarchical_capability_unavailable");
    expect(ORCHESTRATOR_TEXT).toMatch(/never silently fall back[^\n]*legacy/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/review_agents_plan[^\n]*(?:before|prior to)[^\n]*review_agents_spawn/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/host[^\n]*(?:computes|calculate)[^\n]*plan hash/i);
  });

  test("keeps root ownership while decomposing preparation and execution", () => {
    expect(ORCHESTRATOR_TEXT).toMatch(/revision-bound/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/behavior areas? [×x] aspects?/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/boundary owner/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/review-scout/);
    expect(ORCHESTRATOR_TEXT).toMatch(/review-coordinator/);
    expect(ORCHESTRATOR_TEXT).toMatch(/direct (?:worker|soldier)/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/never (?:give|hand|delegate)[^\n]*whole (?:review|round)[^\n]*coordinator/i);
  });

  test("counts only durable leaf evidence and preserves the existing gates", () => {
    expect(ORCHESTRATOR_TEXT).toMatch(/coordinator[^\n]*summary[^\n]*not[^\n]*(?:coverage|leaf evidence)/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/review_agents_result[^\n]*(?:full|durable)/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/readiness/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/premise/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/publish/i);
  });

  test("advertises the external Keryx general only with its enforced reduced capability profile", () => {
    expect(ORCHESTRATOR_TEXT).toContain("keryx-external-general");
    expect(ORCHESTRATOR_TEXT).toMatch(/external[^\n]*explicit/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/coordinator[^\n]*only|only[^\n]*coordinator/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/bridge-only|bridge only/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/no source inspection|source inspection[^\n]*false/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/provider\s+state[\s\S]{0,80}(?:already|pre-)/i);
    expect(ORCHESTRATOR_TEXT).toMatch(/no exact (?:parent )?tool parity/i);
    expect(ORCHESTRATOR_TEXT).not.toMatch(/review_agents_spawn_external/);
  });
});
