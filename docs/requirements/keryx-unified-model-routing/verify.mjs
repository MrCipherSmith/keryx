import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
const root = path.dirname(fileURLToPath(import.meta.url));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
const files = fs.readdirSync(root).filter(x => x.endsWith(".md"));
for (const name of ["README.md", "prd.md", "specification.md", "implementation-plan.md", "verification.md"]) assert(files.includes(name), `missing ${name}`);
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const readme = read("README.md");
for (const name of files) {
  const text = read(name);
  assert(/^# .+\nVersion: \d+\.\d+\.\d+/u.test(text), `version ${name}`);
  assert(name === "README.md" || readme.includes(`](${name})`), `README omits ${name}`);
  for (const link of text.matchAll(/\]\(([^)]+)\)/gu)) {
    if (/^(https?:|#)/u.test(link[1])) continue;
    assert(fs.existsSync(path.resolve(root, link[1].split("#")[0])), `broken link ${name}: ${link[1]}`);
  }
}
const prd = read("prd.md");
const requirements = [...prd.matchAll(/^### R(\d+) —[^]*?(?=^### |^## |$(?![^]))/gmu)];
assert(requirements.length === 12, `requirements count ${requirements.length}`);
for (const requirement of requirements) assert(requirement[0].includes("Verification: judged"), `verification R${requirement[1]}`);
assert(prd.includes("## Критерии выпуска") && prd.includes("## Критерии результата"), "success lists");
const spec = read("specification.md");
for (let n = 1; n <= 12; n++) assert(spec.includes(`AC${n} / R${n}:`) && spec.split(`AC${n} / R${n}:`)[1].split("\n")[0].includes("Verification:"), `AC${n}`);
const roadmap = fs.readFileSync(path.resolve(root, "../roadmap.md"), "utf8");
assert(roadmap.includes("keryx-unified-model-routing/README.md"), "roadmap");
const ajv = new Ajv({ allErrors: true, schemaId: "auto" });
const validators = {};
for (const filename of fs.readdirSync(path.join(root, "schemas"))) {
  const relative = `schemas/${filename}`;
  assert(readme.includes(`](${relative})`) && spec.includes(`](${relative})`), `schema link ${filename}`);
  const schema = JSON.parse(read(relative));
  assert(ajv.validateSchema(schema), `invalid schema ${filename}`);
  validators[filename] = ajv.compile(schema);
}
let count = 0;
function check(name, value, expected) {
  const validator = validators[`${name}.schema.json`];
  assert(validator(value) === expected, `${name}: expected ${expected}; ${JSON.stringify(validator.errors)}`); count++;
}
check("routing-config", { schemaVersion: 2 }, true);
const target = { providerId: "provider-a", modelId: "model-a" };
check("routing-config", { schemaVersion: 2, classes: { expert: { candidates: [{target, enabled: true, priority: 10}], selection: "priority", fallbackClasses: [] } }, categories: {review: { mode: "class", modelClass: "expert" }} }, true);
check("routing-config", { schemaVersion: 2, categories: { review: { mode: "class", modelClass: "deep" } } }, false);
check("routing-config", { schemaVersion: 2, classifier: { chain: [], timeoutMs: 3000, minConfidence: 0.7, onFailure: {mode: "auto"} } }, false);
check("routing-config", { schemaVersion: 2, apiKey: "forbidden" }, false);
const classified = {category: "review", modelClass: "expert", confidence: 0.9, reasonCode: "multi-module-change", requiredCapabilities: ["tools"]};
check("classification", classified, true);
check("classification", {...classified, confidence: 2}, false);
check("classification", {...classified, modelId: "model-a"}, false);
const decision = {schemaVersion: 2, decisionId: "d", requestId: "r", configDigest: "c", snapshotDigest: "s", assignmentSource: "user", recommendationSource: "none", status: "selected", selection: target, exclusions: []};
check("routing-decision", decision, true);
const {selection, ...withoutSelection} = decision;
check("routing-decision", withoutSelection, false);
check("routing-decision", {...withoutSelection, status: "blocked", reason: "empty-class"}, true);
check("routing-decision", {...decision, status: "blocked", reason: "empty-class"}, false);
check("routing-decision", {...withoutSelection, status: "needs-classification"}, true);
console.log(`PASS: ${files.length} Markdown documents, links, 12 requirements/ACs, roadmap, 3 compiled schemas, ${count} schema fixtures. Runtime v2 not tested or implemented.`);
