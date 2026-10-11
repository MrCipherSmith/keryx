import { describe, expect, test } from "bun:test";
import { OUTCOME_HINT } from "./description-intent";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseAcKinds } from "./ac-kinds";
import { createFlowService } from "./service";
import { renderAcceptanceCriteria, renderDescription, renderFlowInitSkill } from "./templates";

describe("renderDescription", () => {
  const description = renderDescription("Speed up checkout", "user description");
  const headings = description.split("\n").filter((line) => line.startsWith("## "));

  test("has an Outcome criteria section after Expected Outcome and before Out of Scope", () => {
    expect(headings).toEqual(["## Problem", "## Expected Outcome", "## Outcome criteria", "## Out of Scope"]);
  });

  test("the hint asks for an outcome criterion, or `not measured — <reason>`", () => {
    const hint = description.split("\n").find((line) => line.startsWith(OUTCOME_HINT));
    expect(hint).toBeDefined();
    expect(hint).toContain("not measured — <reason>");
  });

  test("the rest of the template is unchanged", () => {
    expect(description).toContain("# Speed up checkout\n\nStatus: draft (flow-init skill formalizes this)\nSource: user description\n");
    expect(description).toContain("Describe the problem precisely");
    expect(description).toContain("What must be true when this flow is done.");
    expect(description).toContain("Explicitly excluded work.");
  });
});

// Flow 422 (AC1): the verification-kind marker is in front of the agent where it writes criteria.
describe("renderAcceptanceCriteria", () => {
  const body = renderAcceptanceCriteria();

  test("a rule line names all four marker forms", () => {
    expect(body).toContain("- Every criterion ends with [verify: exec `<command>`],");
    expect(body).toContain("[verify: invariant `<command>`], [verify: judged] or");
    expect(body).toContain("[verify: none — <reason>].");
  });

  test("the placeholder carries the kind placeholder", () => {
    expect(body).toContain(
      "- AC1: <replace with a hard, verifiable criterion before freeze> [verify: <exec|invariant|judged|none>]\n",
    );
  });

  test("the placeholder's marker is not a valid kind: it classifies as unclassified, with a named error", () => {
    const parsed = parseAcKinds(body);
    expect(parsed.criteria).toHaveLength(1);
    expect(parsed.criteria[0]?.id).toBe("AC1");
    expect(parsed.criteria[0]?.record).toEqual({ kind: "unclassified" });
    expect(parsed.errors).toHaveLength(1);
  });

  test("the service's placeholder detector still sees the new placeholder: a fresh package cannot be frozen", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "keryx-ac-template-"));
    try {
      await mkdir(path.join(root, ".metaproject"), { recursive: true });
      const service = createFlowService({ tracker: null, healthGate: async () => ({ status: "skipped", reasons: [] }), now: () => new Date("2026-10-10T10:00:00Z") });
      const created = await service.init({ cwd: root, title: "placeholder detector" });
      expect(readFileSync(path.join(root, created.dir, "acceptance-criteria.md"), "utf8")).toBe(body);
      await expect(service.freeze({ cwd: root, id: created.flow.id })).rejects.toThrow(/at least one real `- ACn:` criterion/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// Flow 422 (AC2): the flow-init skill's criteria step, generated text and its .metaproject copy.
describe("flow-init skill criteria step", () => {
  const generated = renderFlowInitSkill();

  test("step 7 requires the marker, the command forms, judged, none with a reason, and one operator question before freeze", () => {
    for (const phrase of [
      "Every criterion ends with one marker",
      "[verify: exec `<command>`]",
      "[verify: invariant `<command>`]",
      "[verify: judged] (a human checks: live run, operator",
      "[verify: none — <reason>]",
      "ask the operator ONE question listing the criteria with proposed",
      "before `flow freeze`",
    ]) {
      expect(generated.replace(/\s+/g, " ")).toContain(phrase.replace(/\s+/g, " "));
    }
  });

  test(".metaproject/skills/flow/init.md matches the generated text", () => {
    const copy = readFileSync(path.join(import.meta.dir, "..", "..", ".metaproject", "skills", "flow", "init.md"), "utf8");
    expect(copy).toBe(generated);
  });
});
