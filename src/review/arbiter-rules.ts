// The arbiter's written rules: a versioned file of numbered rules, and the closed vocabulary they are written in.
//
// The arbiter answers only from this file. A rule names the question kinds it covers; a verdict has to cite a
// rule that covers the question's kind. The file is data, not code: the bundled default ships in the package,
// a project replaces it with `.metaproject/review/arbiter-rules.json`. A project file that does not validate
// is never half-used: every question then escalates, with the reason in the log.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import bundled from "./arbiter-rules.json";

/** The six kinds of question the arbiter answers. Anything else escalates without a model call. */
export const ARBITER_KINDS = ["scope", "budget", "option_choice", "partial_coverage", "smaller_slice", "slice_order"] as const;
export type ArbiterKind = (typeof ARBITER_KINDS)[number];

export function isArbiterKind(value: unknown): value is ArbiterKind {
  return typeof value === "string" && (ARBITER_KINDS as readonly string[]).includes(value);
}

/** The closed verdict set. */
export const ARBITER_VERDICTS = ["allow", "deny", "escalate"] as const;
export type ArbiterVerdictKind = (typeof ARBITER_VERDICTS)[number];

export interface FactSpec {
  readonly type: "number" | "boolean";
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

/** Every fact a question may carry. A number is bounded; nothing here is text. */
export const ARBITER_FACTS: Readonly<Record<string, FactSpec>> = {
  coveragePercent: { type: "number", min: 0, max: 100 },
  budgetUsedPercent: { type: "number", min: 0, max: 1000 },
  blockersOpen: { type: "number", min: 0, max: 100_000, integer: true },
  retryCount: { type: "number", min: 0, max: 1000, integer: true },
  sliceCount: { type: "number", min: 0, max: 100_000, integer: true },
  filesInScope: { type: "number", min: 0, max: 1_000_000, integer: true },
  widensScope: { type: "boolean" },
  outsideRepository: { type: "boolean" },
  raisesBudget: { type: "boolean" },
  changesFiles: { type: "boolean" },
  reversible: { type: "boolean" },
  blockersFirst: { type: "boolean" },
};

/**
 * The facts each kind carries, all required. The facts describe the option the orchestrator recommends: the
 * arbiter judges whether that option may be taken, it does not pick between options by their wording.
 */
export const ARBITER_KIND_FACTS: Readonly<Record<ArbiterKind, readonly string[]>> = {
  scope: ["filesInScope", "widensScope", "outsideRepository"],
  budget: ["budgetUsedPercent", "raisesBudget"],
  option_choice: ["changesFiles", "reversible"],
  partial_coverage: ["coveragePercent", "blockersOpen"],
  smaller_slice: ["retryCount", "sliceCount"],
  slice_order: ["blockersFirst", "sliceCount"],
};

export type ArbiterFacts = Readonly<Record<string, number | boolean>>;

export const CLAUSE_OPS = ["==", "<=", ">=", "<", ">"] as const;
export type ClauseOp = (typeof CLAUSE_OPS)[number];

/** One machine-checked condition of a rule: `fact op value`. */
export interface RuleClause {
  readonly fact: string;
  readonly op: ClauseOp;
  readonly value: number | boolean;
}

export interface ArbiterRule {
  readonly id: string;
  /** The kinds the rule covers; `*` covers all of them. */
  readonly kinds: readonly (ArbiterKind | "*")[];
  /** What the rule decides. A model verdict that cites the rule has to be this verdict. */
  readonly verdict: ArbiterVerdictKind;
  readonly text: string;
  /**
   * All of these hold for the facts the rule applies to. keryx checks them itself after the model has answered, so a
   * model cannot cite a rule the facts do not satisfy. A rule without clauses is not machine-checked.
   */
  readonly when?: readonly RuleClause[];
}

export interface ArbiterRules {
  readonly version: number;
  readonly rules: readonly ArbiterRule[];
  readonly source: "bundled" | "project";
  /** Short hash of the rules in force, kept in the log so a verdict can be tied to the text it was given. */
  readonly hash: string;
}

export const RULE_ID = /^R-\d{2,3}$/;
const MAX_RULE_TEXT = 600;

export const PROJECT_RULES_PATH = path.join(".metaproject", "review", "arbiter-rules.json");

export type ParsedRules = { readonly ok: true; readonly rules: ArbiterRules } | { readonly ok: false; readonly errors: readonly string[] };

export function parseArbiterRules(raw: unknown, source: ArbiterRules["source"]): ParsedRules {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: ["the rules file must be a JSON object"] };
  const file = raw as Record<string, unknown>;
  const version = file["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) errors.push("`version` must be a positive integer");
  const list = file["rules"];
  if (!Array.isArray(list) || list.length === 0) {
    errors.push("`rules` must be a non-empty array");
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  const rules: ArbiterRule[] = [];
  list.forEach((entry, index) => {
    const where = `rules[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${where} must be an object`);
      return;
    }
    const rule = entry as Record<string, unknown>;
    const id = rule["id"];
    if (typeof id !== "string" || id.length === 0) {
      errors.push(`${where} has no id`);
    } else if (!RULE_ID.test(id)) {
      errors.push(`${where} id "${id}" must look like R-01`);
    } else if (seen.has(id)) {
      errors.push(`${where} repeats the id ${id}`);
    } else {
      seen.add(id);
    }
    const kinds = rule["kinds"];
    const kindList: (ArbiterKind | "*")[] = [];
    if (!Array.isArray(kinds) || kinds.length === 0) {
      errors.push(`${where} must name at least one kind`);
    } else {
      for (const kind of kinds) {
        if (kind === "*" || isArbiterKind(kind)) kindList.push(kind as ArbiterKind | "*");
        else errors.push(`${where} names the unknown kind ${JSON.stringify(kind)}`);
      }
    }
    const verdict = rule["verdict"];
    if (typeof verdict !== "string" || !(ARBITER_VERDICTS as readonly string[]).includes(verdict)) {
      errors.push(`${where} verdict must be one of ${ARBITER_VERDICTS.join(", ")}`);
    }
    const when = parseWhen(rule["when"], where, errors);
    const text = rule["text"];
    if (typeof text !== "string" || text.trim().length === 0) errors.push(`${where} has no text`);
    else if (text.length > MAX_RULE_TEXT) errors.push(`${where} text is longer than ${MAX_RULE_TEXT} characters`);
    if (
      typeof id === "string" &&
      RULE_ID.test(id) &&
      typeof text === "string" &&
      text.trim().length > 0 &&
      kindList.length > 0 &&
      typeof verdict === "string" &&
      (ARBITER_VERDICTS as readonly string[]).includes(verdict)
    ) {
      rules.push({
        id,
        kinds: kindList,
        verdict: verdict as ArbiterVerdictKind,
        text: text.trim(),
        ...(when === undefined || when.length === 0 ? {} : { when }),
      });
    }
  });
  if (errors.length > 0) return { ok: false, errors };
  const hash = createHash("sha256").update(JSON.stringify({ version, rules })).digest("hex").slice(0, 12);
  return { ok: true, rules: { version: version as number, rules, source, hash } };
}

function parseWhen(raw: unknown, where: string, errors: string[]): RuleClause[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    errors.push(`${where} \`when\` must be an array`);
    return undefined;
  }
  const clauses: RuleClause[] = [];
  raw.forEach((entry, index) => {
    const at = `${where}.when[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const clause = entry as Record<string, unknown>;
    const fact = clause["fact"];
    const op = clause["op"];
    const value = clause["value"];
    const spec = typeof fact === "string" ? ARBITER_FACTS[fact] : undefined;
    if (typeof fact !== "string" || spec === undefined) {
      errors.push(`${at} names the unknown fact ${JSON.stringify(fact)}`);
      return;
    }
    if (typeof op !== "string" || !(CLAUSE_OPS as readonly string[]).includes(op)) {
      errors.push(`${at} op must be one of ${CLAUSE_OPS.join(" ")}`);
      return;
    }
    if (typeof value !== spec.type) {
      errors.push(`${at} value must be a ${spec.type}`);
      return;
    }
    if (spec.type === "boolean" && op !== "==") {
      errors.push(`${at} a boolean fact only takes ==`);
      return;
    }
    clauses.push({ fact, op: op as ClauseOp, value: value as number | boolean });
  });
  return clauses;
}

function clauseHolds(clause: RuleClause, facts: ArbiterFacts): boolean {
  const actual = facts[clause.fact];
  if (actual === undefined) return false;
  if (typeof actual === "boolean" || typeof clause.value === "boolean") return actual === clause.value;
  switch (clause.op) {
    case "==":
      return actual === clause.value;
    case "<=":
      return actual <= clause.value;
    case ">=":
      return actual >= clause.value;
    case "<":
      return actual < clause.value;
    case ">":
      return actual > clause.value;
  }
}

/** Whether every clause of the rule holds for the facts. A rule without clauses is not machine-checked: it holds. */
export function ruleHolds(rule: ArbiterRule, facts: ArbiterFacts): boolean {
  return (rule.when ?? []).every((clause) => clauseHolds(clause, facts));
}

let bundledRules: ArbiterRules | undefined;

/** The rules that ship with keryx. They are validated by the same parser, so a bad edit fails a test, not a run. */
export function bundledArbiterRules(): ArbiterRules {
  if (bundledRules === undefined) {
    const parsed = parseArbiterRules(bundled, "bundled");
    if (!parsed.ok) throw new Error(`the bundled arbiter rules are invalid: ${parsed.errors.join("; ")}`);
    bundledRules = parsed.rules;
  }
  return bundledRules;
}

export type LoadedRules = { readonly rules: ArbiterRules; readonly error?: undefined } | { readonly rules?: undefined; readonly error: string };

/** The project's rules when it has a file, else the bundled ones. An unreadable or invalid project file is an error, never a fallback. */
export function loadArbiterRules(cwd: string): LoadedRules {
  const file = path.join(cwd, PROJECT_RULES_PATH);
  if (!existsSync(file)) return { rules: bundledArbiterRules() };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: `${PROJECT_RULES_PATH} cannot be read as JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = parseArbiterRules(raw, "project");
  if (!parsed.ok) return { error: `${PROJECT_RULES_PATH} is invalid: ${parsed.errors.join("; ")}` };
  return { rules: parsed.rules };
}

/** The rules that cover `kind`. */
export function rulesForKind(rules: ArbiterRules, kind: ArbiterKind): ArbiterRule[] {
  return rules.rules.filter((rule) => rule.kinds.includes("*") || rule.kinds.includes(kind));
}
