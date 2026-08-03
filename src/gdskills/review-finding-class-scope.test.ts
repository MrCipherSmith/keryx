// A finding of severity `blocker` or `major` must enumerate its CLASS, not one site.
//
// Eleven review rounds across flows 127 and 128 produced the same failure twice
// in a row: the fix was applied where the finding pointed rather than everywhere
// the shape lived. One writer of five. One operator instruction of four. Six
// readers of eight. Each time the reviewer reported a single `file:line`, the
// fixer repaired that line, and the next round found the sibling.
//
// The rule therefore lives in the SCHEMA, not in a sentence asking reviewers to
// please enumerate. `allowlist-not-a-boundary` is the recorded lesson: a rule
// matched against nothing is not a boundary.
//
// Two schemas carry a finding and BOTH are enforced here, because they disagree
// about strictness and would otherwise disagree about this field:
//
//   src/gdskills/contracts/review-finding.schema.json          additionalProperties: FALSE
//   src/gdskills/bundled/.../reviewer-finding.schema.json      additionalProperties: true
//
// The strict one rejects any property it does not declare, so adding
// `class_scope` to only the loose one would make every conforming finding
// invalid under `keryx skills contracts validate --schema review-finding`.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { validateContractFile, validateJson } from "./contracts";

const CLASS_SCOPE = {
  sites: ["src/lib/config-dir.ts:171", "src/session/store.ts:133"],
  enumeration_method: "grep for `ensureKeryxConfigDir(` outside tests; 7 call sites, 2 unguarded",
};

function finding(severity: string, withClassScope: boolean): Record<string, unknown> {
  return {
    id: "F-001",
    reviewer: "review-security-code",
    severity,
    problem: "the shared config directory is created group-writable",
    impact: "any member of the operator's group can replace auth.json",
    suggested_fix: "route every writer through ensureKeryxConfigDir",
    evidence: "measured 0775 under umask 002 on a fresh install",
    confidence: "high",
    ...(withClassScope ? { class_scope: CLASS_SCOPE } : {}),
  };
}

function writeFinding(value: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-finding-"));
  const file = path.join(dir, "finding.json");
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

describe("review-finding contract requires class_scope for blocker and major", () => {
  for (const severity of ["blocker", "major"]) {
    test(`a ${severity} WITHOUT class_scope is rejected`, async () => {
      const file = writeFinding(finding(severity, false));
      try {
        const result = await validateContractFile(file, "review-finding");
        expect(result.valid).toBe(false);
        // The error must name the missing field. A generic failure would pass
        // this assertion for the wrong reason — e.g. if the fixture itself were
        // malformed — so the path is pinned.
        expect(result.errors.some((e) => e.path.includes("class_scope"))).toBe(true);
      } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
      }
    });

    test(`a ${severity} WITH class_scope is accepted`, async () => {
      const file = writeFinding(finding(severity, true));
      try {
        const result = await validateContractFile(file, "review-finding");
        // This is the half that catches `additionalProperties: false`: declaring
        // the requirement without declaring the property makes every conforming
        // finding invalid.
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
      }
    });
  }

  for (const severity of ["minor", "info"]) {
    test(`a ${severity} WITHOUT class_scope is accepted — enumerating every info finding is theatre`, async () => {
      const file = writeFinding(finding(severity, false));
      try {
        const result = await validateContractFile(file, "review-finding");
        expect(result.errors).toEqual([]);
        expect(result.valid).toBe(true);
      } finally {
        rmSync(path.dirname(file), { recursive: true, force: true });
      }
    });
  }
});

describe("the two finding schemas do not drift apart", () => {
  // The whole reason this flow exists is that a rule applied to one member of a
  // class leaves the others wrong. Two schemas describe a finding; a
  // `class_scope` that means one thing in the strict contract and another in the
  // bundled reviewer output is the same defect wearing this flow's own clothes.
  const strict = JSON.parse(
    readFileSync(path.join(import.meta.dir, "contracts", "review-finding.schema.json"), "utf8"),
  ) as Record<string, any>;
  const bundled = JSON.parse(
    readFileSync(
      path.join(
        import.meta.dir,
        "bundled",
        "skills",
        "review",
        "review-orchestrator",
        "reviewer-finding.schema.json",
      ),
      "utf8",
    ),
  ) as Record<string, any>;
  const bundledFinding = bundled.properties.findings.items as Record<string, any>;

  test("both declare class_scope", () => {
    expect(strict.properties.class_scope).toBeDefined();
    expect(bundledFinding.properties.class_scope).toBeDefined();
  });

  test("the class_scope shape is identical in both", () => {
    // Compared without the prose, which legitimately differs: the bundled copy
    // names the strict one so the next editor finds it.
    const shape = (s: Record<string, any>) => ({
      type: s.type,
      required: s.required,
      additionalProperties: s.additionalProperties,
      properties: Object.fromEntries(
        Object.entries(s.properties as Record<string, any>).map(([k, v]) => [
          k,
          { type: v.type, minItems: v.minItems, minLength: v.minLength, items: v.items },
        ]),
      ),
    });
    expect(shape(bundledFinding.properties.class_scope)).toEqual(
      shape(strict.properties.class_scope),
    );
  });

  test("both make it conditional on the same severities", () => {
    expect(bundledFinding.if).toEqual(strict.if);
    expect(bundledFinding.then).toEqual(strict.then);
  });
});

describe("the validator actually evaluates a conditional", () => {
  // Without this the tests above could pass for the wrong reason. The validator
  // is hand-rolled (zero runtime dependencies) and silently ignores any keyword
  // it does not implement, so a schema carrying `if`/`then` would LOOK enforced
  // while enforcing nothing — the decorative-guard failure this flow exists to
  // stop. This pins the keyword itself, independently of the finding schema.
  const conditional = {
    type: "object",
    properties: { kind: { type: "string" }, detail: { type: "string" } },
    if: { properties: { kind: { const: "strict" } }, required: ["kind"] },
    then: { required: ["detail"] },
  };

  test("`then` applies when `if` matches", async () => {
    const errors = await validateJson({ kind: "strict" }, conditional);
    expect(errors.some((e) => e.path.includes("detail"))).toBe(true);
  });

  test("`then` does not apply when `if` does not match", async () => {
    expect(await validateJson({ kind: "loose" }, conditional)).toEqual([]);
  });

  test("`if` matching with the requirement satisfied is valid", async () => {
    expect(await validateJson({ kind: "strict", detail: "why" }, conditional)).toEqual([]);
  });
});
