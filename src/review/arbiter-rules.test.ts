// AC1: the arbiter answers from a versioned file of numbered rules, with a closed verdict set.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ARBITER_FACTS,
  ARBITER_KINDS,
  ARBITER_KIND_FACTS,
  ARBITER_VERDICTS,
  PROJECT_RULES_PATH,
  RULE_ID,
  bundledArbiterRules,
  loadArbiterRules,
  parseArbiterRules,
  ruleHolds,
  rulesForKind,
  type ArbiterFacts,
  type ArbiterKind,
} from "./arbiter-rules";
import bundled from "./arbiter-rules.json";

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-arbiter-rules-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const GOOD_RULE = { id: "R-01", kinds: ["scope"], verdict: "allow", text: "Allow a small scope.", when: [{ fact: "filesInScope", op: "<=", value: 10 }] };

test("the bundled rules are versioned, numbered, and validate", () => {
  const rules = bundledArbiterRules();
  expect(rules.version).toBeGreaterThanOrEqual(1);
  expect(rules.rules.length).toBeGreaterThan(10);
  for (const rule of rules.rules) {
    expect(rule.id).toMatch(RULE_ID);
    expect((ARBITER_VERDICTS as readonly string[]).includes(rule.verdict)).toBe(true);
  }
  expect(new Set(rules.rules.map((rule) => rule.id)).size).toBe(rules.rules.length);
  expect(rules.hash).toMatch(/^[0-9a-f]{12}$/);
});

test("AC1: a rule without an id is rejected", () => {
  const { id: _dropped, ...noId } = GOOD_RULE;
  const parsed = parseArbiterRules({ version: 1, rules: [noId] }, "project");
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.errors.join(" ")).toContain("has no id");
});

test("AC1: an empty id, a malformed id and a repeated id are rejected", () => {
  for (const id of ["", "rule-1", "R-1", "r-01"]) {
    expect(parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, id }] }, "project").ok).toBe(false);
  }
  const repeated = parseArbiterRules({ version: 1, rules: [GOOD_RULE, GOOD_RULE] }, "project");
  expect(repeated.ok).toBe(false);
});

test("AC1: the verdict set is closed to allow, deny and escalate", () => {
  expect([...ARBITER_VERDICTS]).toEqual(["allow", "deny", "escalate"]);
  for (const verdict of ["approve", "maybe", "", 1, undefined]) {
    expect(parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, verdict }] }, "project").ok).toBe(false);
  }
});

test("a file without a version, without rules, or that is not an object is rejected", () => {
  expect(parseArbiterRules({ rules: [GOOD_RULE] }, "project").ok).toBe(false);
  expect(parseArbiterRules({ version: 1, rules: [] }, "project").ok).toBe(false);
  expect(parseArbiterRules([], "project").ok).toBe(false);
  expect(parseArbiterRules("rules", "project").ok).toBe(false);
});

test("a rule needs known kinds, text, and well-typed conditions", () => {
  expect(parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, kinds: ["weather"] }] }, "project").ok).toBe(false);
  expect(parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, kinds: [] }] }, "project").ok).toBe(false);
  expect(parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, text: "  " }] }, "project").ok).toBe(false);
  expect(parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, text: "x".repeat(601) }] }, "project").ok).toBe(false);
  const clause = (c: Record<string, unknown>) => parseArbiterRules({ version: 1, rules: [{ ...GOOD_RULE, when: [c] }] }, "project").ok;
  expect(clause({ fact: "filesInScope", op: "<=", value: 10 })).toBe(true);
  expect(clause({ fact: "invented", op: "<=", value: 10 })).toBe(false);
  expect(clause({ fact: "filesInScope", op: "~", value: 10 })).toBe(false);
  expect(clause({ fact: "filesInScope", op: "<=", value: "ten" })).toBe(false);
  expect(clause({ fact: "widensScope", op: "<", value: true })).toBe(false);
});

test("ruleHolds checks every clause against the facts", () => {
  const parsed = parseArbiterRules({ version: 1, rules: [GOOD_RULE] }, "project");
  if (!parsed.ok) throw new Error("fixture invalid");
  const rule = parsed.rules.rules[0];
  if (rule === undefined) throw new Error("fixture empty");
  expect(ruleHolds(rule, { filesInScope: 10, widensScope: false, outsideRepository: false })).toBe(true);
  expect(ruleHolds(rule, { filesInScope: 11, widensScope: false, outsideRepository: false })).toBe(false);
  expect(ruleHolds(rule, {})).toBe(false);
});

test("a project file replaces the bundled rules, and a broken one is an error, never a fallback", () => {
  expect(loadArbiterRules(root).rules?.source).toBe("bundled");
  const file = path.join(root, PROJECT_RULES_PATH);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 7, rules: [GOOD_RULE] }));
  const project = loadArbiterRules(root);
  expect(project.rules?.source).toBe("project");
  expect(project.rules?.version).toBe(7);
  writeFileSync(file, "{ not json");
  expect(loadArbiterRules(root).error).toContain("cannot be read as JSON");
  writeFileSync(file, JSON.stringify({ version: 1, rules: [{ ...GOOD_RULE, id: "" }] }));
  const invalid = loadArbiterRules(root);
  expect(invalid.rules).toBeUndefined();
  expect(invalid.error).toContain("is invalid");
});

test("every kind has rules, and every fact a rule names is one the kind carries", () => {
  for (const kind of ARBITER_KINDS) {
    const rules = rulesForKind(bundledArbiterRules(), kind);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const clause of rule.when ?? []) expect(ARBITER_KIND_FACTS[kind]).toContain(clause.fact);
    }
  }
});

/** Values worth trying for a fact: the edges of every clause that mentions it, one step either side, and the bounds. */
function samples(kind: ArbiterKind, fact: string): (number | boolean)[] {
  const spec = ARBITER_FACTS[fact];
  if (spec === undefined) throw new Error(`unknown fact ${fact}`);
  if (spec.type === "boolean") return [true, false];
  const found = new Set<number>([spec.min ?? 0]);
  for (const rule of rulesForKind(bundledArbiterRules(), kind)) {
    for (const clause of rule.when ?? []) {
      if (clause.fact !== fact || typeof clause.value !== "number") continue;
      for (const step of [-1, 0, 1]) found.add(clause.value + step);
    }
  }
  return [...found].filter((value) => (spec.min === undefined || value >= spec.min) && (spec.max === undefined || value <= spec.max));
}

function grid(kind: ArbiterKind): ArbiterFacts[] {
  let combos: Record<string, number | boolean>[] = [{}];
  for (const fact of ARBITER_KIND_FACTS[kind]) {
    combos = combos.flatMap((base) => samples(kind, fact).map((value) => ({ ...base, [fact]: value })));
  }
  return combos;
}

test("every fact combination of every kind is covered by at least one rule, so no question depends on the model's guess", () => {
  const gaps: string[] = [];
  for (const kind of ARBITER_KINDS) {
    for (const facts of grid(kind)) {
      const holding = rulesForKind(bundledArbiterRules(), kind).filter((rule) => rule.when !== undefined && ruleHolds(rule, facts));
      if (holding.length === 0) gaps.push(`${kind} ${JSON.stringify(facts)}`);
    }
  }
  expect(gaps).toEqual([]);
});

test("where several rules hold for the same facts they do not give an allow next to a deny", () => {
  const conflicts: string[] = [];
  for (const kind of ARBITER_KINDS) {
    for (const facts of grid(kind)) {
      const holding = rulesForKind(bundledArbiterRules(), kind).filter((rule) => rule.when !== undefined && ruleHolds(rule, facts));
      const verdicts = new Set(holding.map((rule) => rule.verdict));
      if (verdicts.has("allow") && verdicts.has("deny")) conflicts.push(`${kind} ${JSON.stringify(facts)}`);
    }
  }
  expect(conflicts).toEqual([]);
});

test("the JSON file and the parsed rules agree on the rule count", () => {
  expect(bundledArbiterRules().rules.length).toBe((bundled as { rules: unknown[] }).rules.length);
});
