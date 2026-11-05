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
const V3 = `${SKILL}\n${DETAIL}`;

describe("review-orchestrator Review V3 opt-in contract", () => {
  test("keeps legacy as the default and fails closed when the exact host surface is unavailable", () => {
    expect(V3).toContain("--v3");
    expect(V3).toMatch(/legacy[^\n]*default/i);
    for (const tool of [
      "review_v3_start",
      "review_v3_plan",
      "review_v3_spawn",
      "review_v3_status",
      "review_v3_wait",
      "review_v3_result",
      "review_v3_cancel",
    ]) {
      expect(V3).toContain(tool);
    }
    expect(V3).toContain("STATUS: BLOCKED v3_capability_unavailable");
    expect(V3).toMatch(/never silently fall back[^\n]*legacy/i);
    expect(V3).toMatch(/review_v3_plan[^\n]*(?:before|prior to)[^\n]*review_v3_spawn/i);
    expect(V3).toMatch(/host[^\n]*(?:computes|calculate)[^\n]*plan hash/i);
  });

  test("keeps root ownership while decomposing preparation and execution", () => {
    expect(V3).toMatch(/revision-bound/i);
    expect(V3).toMatch(/behavior areas? [×x] aspects?/i);
    expect(V3).toMatch(/boundary owner/i);
    expect(V3).toMatch(/review-scout/);
    expect(V3).toMatch(/review-coordinator/);
    expect(V3).toMatch(/direct (?:worker|soldier)/i);
    expect(V3).toMatch(/never (?:give|hand|delegate)[^\n]*whole (?:review|round)[^\n]*coordinator/i);
  });

  test("counts only durable leaf evidence and preserves the existing gates", () => {
    expect(V3).toMatch(/coordinator[^\n]*summary[^\n]*not[^\n]*(?:coverage|leaf evidence)/i);
    expect(V3).toMatch(/review_v3_result[^\n]*(?:full|durable)/i);
    expect(V3).toMatch(/readiness/i);
    expect(V3).toMatch(/premise/i);
    expect(V3).toMatch(/publish/i);
  });

  test("advertises the external Keryx general only with its enforced reduced capability profile", () => {
    expect(V3).toContain("keryx-external-general");
    expect(V3).toMatch(/external[^\n]*explicit/i);
    expect(V3).toMatch(/coordinator[^\n]*only|only[^\n]*coordinator/i);
    expect(V3).toMatch(/bridge-only|bridge only/i);
    expect(V3).toMatch(/no source inspection|source inspection[^\n]*false/i);
    expect(V3).toMatch(/provider\s+state[\s\S]{0,80}(?:already|pre-)/i);
    expect(V3).toMatch(/no exact (?:parent )?tool parity/i);
    expect(V3).not.toMatch(/review_v3_spawn_external/);
  });
});
