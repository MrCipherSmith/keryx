// Flow 490: the review lenses agree with the contract they are dispatched under.
//
// Each check pins a defect that existed in the shipped lenses until flow 490 and
// that a round could not see: a reviewer told to mutate the shared tree while other
// reviewers read it, a reviewer pointed at a command that does not exist, a schema
// that refused the negative-enumeration form the orchestrator documents, and an
// orchestrator sentence that forbade the read-only layer commands every lens uses.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const REVIEW_ROOT = path.join(import.meta.dir, "bundled", "skills", "review");
const ORCH = path.join(REVIEW_ROOT, "review-orchestrator");
const read = (name: string): string => readFileSync(path.join(REVIEW_ROOT, name, "SKILL.md"), "utf8");

/** Dispatched finding-raising lenses: every `review-*` skill except the orchestrator, Jev (owner decision) and pr-feedback (not dispatched). */
const LENSES = readdirSync(REVIEW_ROOT).filter(
  (name) => name.startsWith("review-") && name !== "review-orchestrator" && name !== "review-pr-feedback" && !name.startsWith("review-jev-"),
);

describe("review lens contract (flow 490)", () => {
  test("there are lenses to check", () => {
    expect(LENSES.length).toBeGreaterThanOrEqual(15);
  });

  test("no lens names a command that does not exist or a retired reviewer (AC5)", () => {
    const stale = [/keryx wiki query/, /\bcode-style-review\b/, /\bcode-mobx-store-review\b/];
    const hits = LENSES.flatMap((name) => stale.filter((re) => re.test(read(name))).map((re) => `${name}: ${re.source}`));
    expect(hits).toEqual([]);
    expect(read("review-verifier")).not.toMatch(/\bAC9\b/);
  });

  test("no lens runs tests, health checks or a dev server in the reviewed tree (AC2)", () => {
    const forbidden = [/`keryx test run\b/, /`keryx health run\b/, /\b(npm|bun|pnpm|yarn) (run )?dev\b/];
    const hits = LENSES.flatMap((name) => forbidden.filter((re) => re.test(read(name))).map((re) => `${name}: ${re.source}`));
    expect(hits).toEqual([]);
  });

  test("the orchestrator names every command a reviewer may run and what it never runs (AC2)", () => {
    const bullet = read("review-orchestrator").split("\n").find((line) => line.startsWith("- Reviewers are read-only:")) ?? "";
    for (const command of ["git log", "git blame", "git show", "keryx gdgraph affected", "keryx test related", "keryx wiki ask", "keryx memory search", "keryx ctx rg"]) {
      expect(bullet).toContain(command);
    }
    expect(bullet).toMatch(/never tests, health checks, servers, mutation/);
  });

  test("mutation and written tests go through a scratch copy, never the reviewed tree (AC3)", () => {
    expect(read("review-testing-practices")).toContain("keryx review mutate");
    expect(read("review-testing-practices")).not.toMatch(/delete G\s+->\s+run the nearest suite/);
    expect(read("review-verifier")).toContain("keryx review mutate");
    expect(read("review-verifier")).not.toMatch(/Delete the guarded line and re-run\.?\s*$/m);
    expect(read("review-degradation")).toMatch(/also write, and never in the reviewed tree/);
    expect(read("review-ui-ux")).toMatch(/never starts? a dev server/i);
  });

  test("the input schema declares known_findings once (AC1)", () => {
    const raw = readFileSync(path.join(ORCH, "reviewer-input.schema.json"), "utf8");
    expect(raw.match(/"known_findings"\s*:/g)?.length).toBe(1);
  });

  test("an empty class_scope.sites is allowed only with a named enumeration method (AC1)", () => {
    const schema = JSON.parse(readFileSync(path.join(ORCH, "reviewer-finding.schema.json"), "utf8"));
    const find = (node: unknown): Record<string, any> | undefined => {
      if (node === null || typeof node !== "object") return undefined;
      const record = node as Record<string, any>;
      if (record.properties?.sites && record.properties?.enumeration_method) return record;
      for (const value of Object.values(record)) {
        const hit = find(value);
        if (hit) return hit;
      }
      return undefined;
    };
    const classScope = find(schema);
    expect(classScope).toBeDefined();
    expect(classScope!.properties.sites.minItems ?? 0).toBe(0);
    expect(classScope!.required).toContain("enumeration_method");
    expect(classScope!.properties.enumeration_method.minLength).toBeGreaterThanOrEqual(1);
  });
});
