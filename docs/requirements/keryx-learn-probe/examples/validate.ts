// Documentation-only offline checker. It neither runs probe nor writes artifacts.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { validateAgainstSchema } from "../../../../src/contracts/validator";
import { SchemaResolver } from "../../../../src/contracts/resolver";
import { linksIn } from "../../../../scripts/check-doc-links";
const dir = path.resolve(import.meta.dir, "..");
const schemas = path.join(dir, "schemas");
const read = (file: string) => JSON.parse(readFileSync(path.join(dir, file), "utf8"));
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
let checks = 0, positive = 0, negative = 0, refs = 0;
function check(value: unknown, label: string): asserts value {
  checks++; if (!value) throw new Error(label);
}
function schema(name: string, value: unknown, expected = true) {
  const result = validateAgainstSchema(name, value, { schemaDir: schemas });
  check(result.valid === expected, `${name}: expected ${expected}, ${JSON.stringify(result.errors)}`);
  if (expected) positive++; else negative++;
}
const clone = <T>(x: T): T => structuredClone(x);
const task = read("examples/task-set.json");
const bundle = read("examples/artifact-bundle.json");
const { plan, comparison, checkpoint } = bundle;
const resolver = new SchemaResolver(schemas);
const allowed = new Set(["$schema", "$id", "$ref", "$defs", "title", "description", "type", "additionalProperties", "required", "properties", "const", "enum", "pattern", "minLength", "maxLength", "format", "minimum", "maximum", "exclusiveMinimum", "minItems", "maxItems", "uniqueItems", "items", "allOf", "anyOf", "oneOf", "not", "if", "then", "else"]);
function audit(node: any, root: any) {
  if (typeof node === "boolean") return;
  check(node && typeof node === "object" && !Array.isArray(node), "schema node object");
  for (const key of Object.keys(node)) check(allowed.has(key), `unsupported keyword ${key}`);
  if (node.$ref) { resolver.resolve(node.$ref, root); refs++; }
  if (node.pattern) new RegExp(node.pattern);
  if (node.type === "object") check(node.additionalProperties === false, "closed object schema");
  for (const container of [node.properties, node.$defs]) if (container) for (const value of Object.values(container)) audit(value, root);
  for (const key of ["items", "not", "if", "then", "else"]) if (node[key] !== undefined) audit(node[key], root);
  for (const key of ["allOf", "anyOf", "oneOf"]) if (node[key]) for (const value of node[key]) audit(value, root);
}
for (const file of readdirSync(schemas)) {
  const root = resolver.loadSchema(file);
  check(root.$schema === "https://json-schema.org/draft/2020-12/schema", "draft declaration");
  audit(root, root);
}
schema("probe-task-set.schema.json", task);
schema("probe-plan.schema.json", plan);
schema("probe-comparison.schema.json", comparison);
schema("probe-checkpoint.schema.json", checkpoint);
const digestOfPlan = (p: any) => hash(`${JSON.stringify(p)}\n`);
function semantic(b: any) {
  const { plan: p, comparison: c, checkpoint: k } = b;
  const pd = hash(JSON.stringify([p.snapshot.trigger, p.snapshot.action]));
  const e = p.environment;
  const id = hash([p.patternId, pd, p.taskId, e.model, e.provider, e.commit, e.taskSetDigest, String(p.request.runs)].join("\0"));
  if (p.patternDigest !== pd || p.identityDigest !== id || p.probeId !== id.slice(0, 12)) return false;
  if (k.planDigest !== digestOfPlan(p) || k.probeId !== p.probeId || !Number.isFinite(p.request.maxUsd) || p.request.maxUsd <= 0) return false;
  if (["probeId", "identityDigest", "patternId", "patternDigest", "taskId"].some(key => c[key] !== p[key])) return false;
  if (JSON.stringify(e) !== JSON.stringify(c.environment)) return false;
  const unique = (xs: any[]) => new Set(xs.map(x => `${x.arm}/${x.seed}`)).size === xs.length;
  if (!unique(c.runs) || !unique(k.seeds)) return false;
  if (k.seeds.some((s: any) => s.planDigest !== k.planDigest || s.seed >= p.request.runs || (s.success && !s.answered))) return false;
  if (c.runs.some((s: any) => s.seed >= p.request.runs || (s.success && !s.answered))) return false;
  const charged = k.seeds.reduce((n: number, s: any) => n + s.chargedUsd, 0);
  const reserved = k.seeds.reduce((n: number, s: any) => n + s.reservedUsd, 0);
  if (Math.abs(charged - k.spendUsd) > 1e-9 || Math.abs(reserved - k.reservedUsd) > 1e-9) return false;
  if (k.seeds.some((s: any) => s.state !== "running" && s.reservedUsd !== 0)) return false;
  if (k.phase === "finalized" && k.seeds.some((s: any) => s.state === "running")) return false;
  if (c.verdict !== "unmeasurable") {
    for (const arm of ["base", "probe"]) {
      const a = c.arms[arm], runs = c.runs.filter((s: any) => s.arm === arm);
      if (a.seeds !== p.request.runs || runs.length !== a.seeds || runs.some((s: any) => !s.answered)) return false;
      if (a.successes !== runs.filter((s: any) => s.success).length || a.rate !== a.successes / a.seeds || a.ci[0] > a.ci[1]) return false;
    }
    if (c.delta.rate !== c.arms.probe.rate - c.arms.base.rate || c.delta.ci[0] > c.delta.ci[1]) return false;
  }
  return true;
}
check(plan.environment.taskSetDigest === hash(readFileSync(path.join(dir, "examples/task-set.json"))), "task-set byte digest");
check(semantic(bundle), "fixture semantic linkage");
// Every verdict/reason branch, including partial-failure runs and pre-run empty runs.
for (const reason of ["no-task", "gold-leak", "underpowered", "run-failed", "budget-exceeded", "environment-drift"]) {
  const c = clone(comparison); c.verdict = "unmeasurable"; c.reason = reason;
  c.arms = { base: null, probe: null }; c.delta = null;
  if (["no-task", "gold-leak", "underpowered"].includes(reason)) c.runs = [];
  schema("probe-comparison.schema.json", c);
  const bad = clone(c); bad.arms.base = clone(comparison.arms.base);
  schema("probe-comparison.schema.json", bad, false);
  const badDelta = clone(c); badDelta.delta = clone(comparison.delta);
  schema("probe-comparison.schema.json", badDelta, false);
  const noReason = clone(c); delete noReason.reason;
  schema("probe-comparison.schema.json", noReason, false);
  if (c.runs.length === 0) { const badRuns = clone(c); badRuns.runs = clone(comparison.runs); schema("probe-comparison.schema.json", badRuns, false); }
}
for (const verdict of ["improved", "regressed", "indistinguishable"]) {
  const c = clone(comparison); c.verdict = verdict;
  // Branch-shape cases only; CI/verdict arithmetic remains a runtime fixture obligation.
  schema("probe-comparison.schema.json", c);
  c.reason = "run-failed"; schema("probe-comparison.schema.json", c, false);
  delete c.reason; c.arms.base = null; schema("probe-comparison.schema.json", c, false);
}
for (const finalization of [{ evidence: "applied" }, { evidence: "not-needed" }, { evidence: "skipped", reason: "environment-drift" }]) {
  const k = clone(checkpoint); k.finalization = finalization; schema("probe-checkpoint.schema.json", k);
}
const pending = clone(checkpoint); pending.phase = "finalizing"; pending.finalization = null;
schema("probe-checkpoint.schema.json", pending);
const dry = clone(plan); dry.request.maxUsd = null; schema("probe-plan.schema.json", dry);
for (const amount of [0, -1, Infinity, NaN]) {
  const bad = clone(plan); bad.request.maxUsd = amount; schema("probe-plan.schema.json", bad, false);
}
for (const runs of [0, -1, 1.5]) {
  const bad = clone(plan); bad.request.runs = runs; schema("probe-plan.schema.json", bad, false);
}
for (const mutation of [(k: any) => k.finalization = null, (k: any) => k.finalization = { evidence: "skipped" }, (k: any) => k.finalization = { evidence: "applied", reason: "environment-drift" }, (k: any) => k.reservedUsd = 1]) {
  const k = clone(checkpoint); mutation(k); schema("probe-checkpoint.schema.json", k, false);
}
const emptyFinal = clone(pending); emptyFinal.finalization = { evidence: "applied" };
schema("probe-checkpoint.schema.json", emptyFinal, false);
for (const badPath of ["/tmp/key", "../key", "a/../key", "C:/key", "a\\key", ""]) {
  const t = clone(task); t.tasks[0].goldArtifacts = [badPath]; schema("probe-task-set.schema.json", t, false);
}
for (const [name, value] of [["probe-plan.schema.json", plan], ["probe-comparison.schema.json", comparison], ["probe-checkpoint.schema.json", checkpoint], ["probe-task-set.schema.json", task]] as const) {
  const extra = clone(value); extra.unexpected = true; schema(name, extra, false);
}
const badDigest = clone(plan); badDigest.patternDigest = "xyz";
schema("probe-plan.schema.json", badDigest, false);
const badReason = clone(comparison); badReason.verdict = "unmeasurable"; badReason.reason = "new-spelling"; badReason.arms = { base: null, probe: null }; badReason.delta = null;
schema("probe-comparison.schema.json", badReason, false);
for (const mutate of [(b: any) => b.plan.snapshot.action += " Changed", (b: any) => b.checkpoint.planDigest = "0".repeat(64), (b: any) => b.checkpoint.spendUsd = 1, (b: any) => b.comparison.runs.push(clone(b.comparison.runs[0])), (b: any) => b.comparison.arms.base.successes = 0]) {
  const b = clone(bundle); mutate(b); check(!semantic(b), "negative semantic mutation"); negative++;
}
// Demonstrate separate late-drift output without mutating its published comparison.
const published = JSON.stringify(comparison);
const envelope = { schemaVersion: 1, comparison, finalization: { evidence: "skipped", reason: "environment-drift" } };
check(JSON.stringify(envelope.comparison) === published, "separate outcome leaves comparison bytes alone");
const positiveDuplicateTask = clone(task); positiveDuplicateTask.tasks.push(clone(task.tasks[0]));
check(new Set(positiveDuplicateTask.tasks.map((t: any) => t.id)).size !== positiveDuplicateTask.tasks.length, "duplicate IDs need semantic rejection");
const files: string[] = [];
function walk(base = "") { for (const e of readdirSync(path.join(dir, base), { withFileTypes: true })) {
  const rel = path.join(base, e.name); if (e.isDirectory()) walk(rel); else files.push(rel);
} }
walk();
const index = readFileSync(path.join(dir, "README.md"), "utf8");
const indexed = new Set(linksIn(index).map(x => x.split("#")[0]));
for (const file of files) {
  if (file !== "README.md") check(indexed.has(file), `README index missing ${file}`);
  if (!file.endsWith(".md")) continue;
  const text = readFileSync(path.join(dir, file), "utf8");
  check(/^# .+\nVersion: \d+\.\d+\.\d+/m.test(text), `version ${file}`);
  for (const link of linksIn(text)) {
    if (/^(https?:|mailto:|#)/.test(link)) continue;
    check(existsSync(path.resolve(dir, path.dirname(file), link.split("#")[0]!)), `broken ${file} -> ${link}`);
  }
}
for (const file of ["README.md", "prd.md", "specification.md"]) check(existsSync(path.join(dir, file)), `required ${file}`);
const prd = readFileSync(path.join(dir, "prd.md"), "utf8");
const requirements = prd.split(/^### R\d+ .+$/m).slice(1);
check(requirements.length === 10, "ten PRD requirements");
for (const [i, req] of requirements.entries()) check(/Verification: (exec `[^`]+`|invariant `[^`]+`|judged|none — .+)/.test(req), `R${i + 1} verification`);
check(prd.includes("### Release criteria") && prd.includes("### Outcome criteria"), "split success criteria");
const spec = readFileSync(path.join(dir, "specification.md"), "utf8");
for (let i = 1; i <= 24; i++) check(spec.includes(`**AC${i}**`), `AC${i}`);
for (const file of readdirSync(schemas)) check(spec.includes(`schemas/${file}`), `spec schema reference ${file}`);
const artifact = read("docpack-update-result.json");
const result = validateAgainstSchema("subagent-result.schema.json", artifact, { schemaDir: path.resolve(dir, "../../../.metaproject/core/gdskills/contracts") });
check(result.valid, `result contract ${JSON.stringify(result.errors)}`);
for (const item of artifact.changed_files) check(existsSync(path.resolve(dir, "../../..", item.path)), `changed file exists ${item.path}`);
console.log(JSON.stringify({ status: "PASS", checks, schema_positive_cases: positive, negative_cases: negative, schema_refs_resolved: refs, files: files.length, runtime_tests: "not run: docs-only", network: "none", installs: "none" }));
