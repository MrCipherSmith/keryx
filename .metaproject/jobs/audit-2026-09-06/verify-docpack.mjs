import fs from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';

// Documentation-only verification; no runtime source or model execution.
const root = process.cwd();
const packageRoot = path.join(root, 'docs/requirements/keryx-agent-first-core');
const errors = [];
const warnings = [];
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}
const files = walk(packageRoot);
const rel = p => path.relative(packageRoot, p);
for (const name of ['README.md', 'prd.md', 'specification.md']) {
  if (!fs.existsSync(path.join(packageRoot, name))) errors.push(`Missing ${name}`);
}
const markdown = files.filter(p => p.endsWith('.md'));
const readme = fs.existsSync(path.join(packageRoot, 'README.md'))
  ? fs.readFileSync(path.join(packageRoot, 'README.md'), 'utf8') : '';
const readmeTargets = new Set();
for (const p of markdown) {
  const text = fs.readFileSync(p, 'utf8');
  if (!/^# [^\n]+\r?\n(?:\r?\n)?Version: \d+\.\d+\.\d+\s*$/m.test(text)) {
    errors.push(`${rel(p)}: missing Version directly below H1`);
  }
  const prose = text.replace(/^```[^\n]*\n[\s\S]*?^```[^\n]*$/gm, '');
  for (const m of prose.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
    const href = m[1].trim().replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    const target = decodeURIComponent(href.split('#')[0] ?? '');
    if (!target) continue;
    const resolved = path.resolve(path.dirname(p), target);
    if (!fs.existsSync(resolved)) errors.push(`${rel(p)}: broken link ${href}`);
    if (path.basename(p) === 'README.md') readmeTargets.add(resolved);
  }
  if (/\.metaproject\/jobs\//.test(text)) errors.push(`${rel(p)}: untracked audit dependency`);
}
for (const p of files) {
  if (path.basename(p) !== 'README.md' && !readmeTargets.has(p)) {
    errors.push(`README does not link ${rel(p)}`);
  }
}
const roadmapPath = path.join(root, 'docs/requirements/roadmap.md');
const roadmap = fs.readFileSync(roadmapPath, 'utf8');
if (!roadmap.includes('keryx-agent-first-core/README.md')) errors.push('Roadmap missing package link');
if (/^Version: 0\.27\.0$/m.test(roadmap)) errors.push('Roadmap version not incremented');
const schemas = files.filter(p => p.endsWith('.schema.json'));
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const parsed = [];
for (const p of files.filter(p => p.endsWith('.json'))) {
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (schemas.includes(p)) parsed.push([p, data]);
  } catch(e) { errors.push(`${rel(p)}: invalid JSON ${e.message}`); }
}
for (const [p, schema] of parsed) {
  try { ajv.addSchema(schema, schema.$id ?? rel(p)); }
  catch(e) { errors.push(`${rel(p)}: addSchema ${e.message}`); }
}
let examplesChecked = 0;
for (const [p, schema] of parsed) {
  try {
    const validate = ajv.getSchema(schema.$id ?? rel(p));
    if (!validate) throw new Error('schema not registered');
    for (const ex of schema.examples ?? []) {
      examplesChecked++;
      if (!validate(ex)) errors.push(`${rel(p)}: example invalid ${JSON.stringify(validate.errors)}`);
    }
  } catch(e) { errors.push(`${rel(p)}: compile ${e.message}`); }
}
const spec = fs.existsSync(path.join(packageRoot, 'specification.md'))
  ? fs.readFileSync(path.join(packageRoot, 'specification.md'), 'utf8') : '';
for (const p of schemas) {
  if (!spec.includes(rel(p))) errors.push(`Specification does not reference ${rel(p)}`);
}
let positiveExamples = 0;
let negativeSchemaCases = 0;
let serviceOnlyCases = 0;
const exampleRoot = path.join(packageRoot, 'examples');
for (const p of walk(exampleRoot).filter(p => p.endsWith('.json') && path.basename(p) !== 'validation-cases.json')) {
  const schemaName = path.basename(p).replace(/\.json$/, '.schema.json');
  try {
    const validate = ajv.getSchema(schemaName);
    if (!validate) throw new Error(`missing schema ${schemaName}`);
    positiveExamples++;
    if (!validate(JSON.parse(fs.readFileSync(p, 'utf8')))) {
      errors.push(`${rel(p)}: invalid positive example ${JSON.stringify(validate.errors)}`);
    }
  } catch(e) { errors.push(`${rel(p)}: ${e.message}`); }
}
const casesPath = path.join(exampleRoot, 'validation-cases.json');
if (fs.existsSync(casesPath)) {
  for (const c of JSON.parse(fs.readFileSync(casesPath, 'utf8')).cases) {
    try {
      const value = c.value ?? JSON.parse(fs.readFileSync(path.join(exampleRoot, c.base), 'utf8'));
      for (const m of c.mutations ?? []) {
        const parts = m.path.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
        let target = value;
        for (const part of parts.slice(0,-1)) target = target[part];
        const key = parts.at(-1);
        if (m.op === 'remove') {
          if (!Object.hasOwn(target, key)) throw new Error(`missing mutation path ${m.path}`);
          delete target[key];
        } else if (m.op === 'replace' || m.op === 'add') {
          if (m.op === 'replace' && !Object.hasOwn(target, key)) throw new Error(`missing replacement path ${m.path}`);
          target[key] = m.value;
        } else throw new Error(`unsupported mutation ${m.op}`);
      }
      const schemaName = c.schema ?? c.base.replace(/\.json$/, '.schema.json');
      const validate = ajv.getSchema(schemaName);
      if (!validate) throw new Error(`missing schema ${schemaName}`);
      const actual = validate(value);
      const expected = c.schemaValid ?? c.valid;
      if (actual !== expected) errors.push(`${c.id}: expected schema ${expected}, got ${actual}: ${JSON.stringify(validate.errors)}`);
      if (c.serviceOutcome) serviceOnlyCases++;
      else if (expected === false) negativeSchemaCases++;
      else positiveExamples++;
    } catch(e) { errors.push(`${c.id}: ${e.message}`); }
  }
}
const combined = markdown.map(p => fs.readFileSync(p, 'utf8')).join('\n');
const ids = [...Array.from({length: 32}, (_,i) => String(i+1).padStart(2,'0')),
  ...Array.from({length: 11}, (_,i) => `M${String(i+1).padStart(2,'0')}`),
  ...Array.from({length: 6}, (_,i) => `W${String(i+1).padStart(2,'0')}`)];
for (const id of ids) {
  if (!new RegExp(`(^|[^A-Za-z0-9])${id}([^A-Za-z0-9]|$)`).test(combined)) {
    errors.push(`Missing plan identifier ${id}`);
  }
}
console.log(JSON.stringify({ status: errors.length ? 'FAIL' : 'PASS',
  markdownFiles: markdown.length, schemaFiles: schemas.length,
  schemaExamplesChecked: examplesChecked, positiveExamples, negativeSchemaCases,
  serviceOnlyCasesSchemaValidated: serviceOnlyCases, planIdentifiersPresent: ids.length,
  checks: ['required files', 'Version', 'relative file links', 'README inventory',
    'roadmap', 'JSON syntax', 'schema compilation', 'schema examples', 'positive and negative fixtures', 'plan ID presence'],
  limits: ['Plan identifier presence is not semantic coverage; independent review required',
    'External URLs and Markdown fragment anchors are not checked by this script',
    'Service-only outcomes are specified, not executed; only their request shapes are validated'],
  errors, warnings }, null, 2));
process.exitCode = errors.length ? 1 : 0;
