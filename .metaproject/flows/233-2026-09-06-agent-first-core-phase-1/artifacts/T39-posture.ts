// T39 probe A — attack the posture-unavailable repair (T37) at its boundaries.
// Read-only against production code; every fixture is mkdtemp and removed.
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { guardOutput, securityFlowGate, isSecurityEnabled } from "../../../../src/security/guard";
import { loadSecurityConfig } from "../../../../src/security/config";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const SECRET = `aws_access_key_id = ${AWS}`;

type Row = Record<string, unknown>;
const rows: Row[] = [];

async function workspace(opts: {
  manifest?: string | undefined;
  config?: string | undefined;
}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t39-posture-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  if (opts.manifest !== undefined) {
    await writeFile(path.join(root, ".metaproject", "metaproject.json"), opts.manifest, "utf8");
  }
  if (opts.config !== undefined) {
    await writeFile(path.join(root, ".metaproject", "security.config.json"), opts.config, "utf8");
  }
  return root;
}

const ENABLED_MANIFEST = JSON.stringify({ modules: { security: { enabled: true } } });

function leaks(text: string, root: string): boolean {
  return text.includes(root) || text.includes(AWS) || text.includes("JSON") || text.includes("ENOENT");
}

async function probe(label: string, manifest: string | undefined, config: string | undefined) {
  const root = await workspace({ manifest, config });
  try {
    let enabledThrew: string | null = null;
    let enabled: boolean | null = null;
    try {
      enabled = await isSecurityEnabled(root);
    } catch (e) {
      enabledThrew = e instanceof Error ? e.message : String(e);
    }

    let guardThrew: string | null = null;
    let guard: Awaited<ReturnType<typeof guardOutput>> | null = null;
    try {
      guard = await guardOutput({ cwd: root, content: SECRET, target: "memory" });
    } catch (e) {
      guardThrew = e instanceof Error ? e.message : String(e);
    }

    let gateThrew: string | null = null;
    let gate: Awaited<ReturnType<typeof securityFlowGate>> | null | undefined;
    try {
      gate = await securityFlowGate(root);
    } catch (e) {
      gateThrew = e instanceof Error ? e.message : String(e);
    }

    let cfgMode: string | null = null;
    let cfgUnreadable: unknown = undefined;
    try {
      const cfg = await loadSecurityConfig(root);
      cfgMode = cfg.mode;
      cfgUnreadable = (cfg as { configUnreadable?: boolean }).configUnreadable;
    } catch (e) {
      cfgMode = `THREW: ${e instanceof Error ? e.message : String(e)}`;
    }

    const serialized = JSON.stringify({ guard, gate });
    rows.push({
      label,
      enabled,
      enabledThrew,
      guardThrew,
      guardAllowed: guard?.allowed ?? null,
      guardGate: guard?.decision.gate ?? null,
      guardReason: guard?.reason ?? null,
      gateThrew,
      gate: gate === null ? "NULL(module disabled)" : gate,
      gateBlocks: gate ? gate.status === "fail" : false,
      cfgMode,
      cfgUnreadable,
      leaky: leaks(serialized, root),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function main() {
  // --- A. manifest shapes (config absent throughout, so mode = advisory default)
  await probe("A1 manifest absent", undefined, undefined);
  await probe("A2 manifest null", "null", undefined);
  await probe("A3 manifest []", "[]", undefined);
  await probe("A4 manifest 42", "42", undefined);
  await probe("A5 manifest \"x\"", '"x"', undefined);
  await probe("A6 manifest true", "true", undefined);
  await probe("A7 manifest unparseable", "{not json", undefined);
  await probe("A8 manifest {} (no modules key)", "{}", undefined);
  await probe("A9 manifest {name} only (realistic minimal, no modules)", '{"name":"demo"}', undefined);
  await probe("A10 manifest modules:null", '{"modules":null}', undefined);
  await probe("A11 manifest modules:[]", '{"modules":[]}', undefined);
  await probe("A12 manifest modules:42", '{"modules":42}', undefined);
  await probe("A13 manifest modules:\"security\"", '{"modules":"security"}', undefined);
  await probe("A14 manifest modules:{} (no security key)", '{"modules":{}}', undefined);
  await probe("A15 manifest security disabled", '{"modules":{"security":{"enabled":false}}}', undefined);
  await probe("A16 manifest security enabled", ENABLED_MANIFEST, undefined);
  await probe("A17 manifest __proto__ payload", '{"__proto__":{"modules":{"security":{"enabled":true}}}}', undefined);
  await probe("A18 manifest empty file", "", undefined);
  await probe("A19 manifest whitespace only", "   \n ", undefined);

  // --- B. config shapes, module enabled
  await probe("B1 config absent", ENABLED_MANIFEST, undefined);
  await probe("B2 config null", ENABLED_MANIFEST, "null");
  await probe("B3 config []", ENABLED_MANIFEST, "[]");
  await probe("B4 config 42", ENABLED_MANIFEST, "42");
  await probe("B5 config \"advisory\"", ENABLED_MANIFEST, '"advisory"');
  await probe("B6 config unparseable", ENABLED_MANIFEST, "{not json");
  await probe("B7 config {} (legit minimal)", ENABLED_MANIFEST, "{}");
  await probe("B8 config mode ci", ENABLED_MANIFEST, '{"mode":"ci"}');
  await probe("B9 config mode enforced", ENABLED_MANIFEST, '{"mode":"enforced"}');
  await probe("B10 config mode advisory", ENABLED_MANIFEST, '{"mode":"advisory"}');
  await probe("B11 config mode UNRECOGNIZED string", ENABLED_MANIFEST, '{"mode":"bananas"}');
  await probe("B12 config mode 'ENFORCED' (case)", ENABLED_MANIFEST, '{"mode":"ENFORCED"}');
  await probe("B13 config mode 'enforced ' (trailing space)", ENABLED_MANIFEST, '{"mode":"enforced "}');
  await probe("B14 config mode null", ENABLED_MANIFEST, '{"mode":null}');
  await probe("B15 config mode 42", ENABLED_MANIFEST, '{"mode":42}');
  await probe("B16 config mode true", ENABLED_MANIFEST, '{"mode":true}');
  await probe("B17 config empty file", ENABLED_MANIFEST, "");

  // --- C. the forced-closed mode must be a returned flag, not a disk write.
  const root = await workspace({ manifest: ENABLED_MANIFEST, config: "null" });
  const before = await readFile(path.join(root, ".metaproject", "security.config.json"), "utf8");
  const beforeList = (await readdir(path.join(root, ".metaproject"))).sort();
  const beforeStat = await stat(path.join(root, ".metaproject", "security.config.json"));
  const cfg = await loadSecurityConfig(root);
  await guardOutput({ cwd: root, content: SECRET, target: "memory" });
  await securityFlowGate(root);
  const after = await readFile(path.join(root, ".metaproject", "security.config.json"), "utf8");
  const afterList = (await readdir(path.join(root, ".metaproject"))).sort();
  const afterStat = await stat(path.join(root, ".metaproject", "security.config.json"));
  rows.push({
    label: "C1 forced-closed mode is a returned flag, not a disk write",
    returnedMode: cfg.mode,
    returnedFlag: (cfg as { configUnreadable?: boolean }).configUnreadable,
    fileBytesUnchanged: before === after,
    fileContent: after,
    mtimeUnchanged: beforeStat.mtimeMs === afterStat.mtimeMs,
    dirBefore: beforeList,
    dirAfter: afterList,
    dirUnchanged: JSON.stringify(beforeList) === JSON.stringify(afterList),
  });
  await rm(root, { recursive: true, force: true });

  // --- D. prototype hygiene
  rows.push({
    label: "D1 Object.prototype untouched after every payload",
    protoModules: (Object.prototype as unknown as { modules?: unknown }).modules ?? null,
    protoMode: (Object.prototype as unknown as { mode?: unknown }).mode ?? null,
  });

  for (const row of rows) console.log(JSON.stringify(row));
}

await main();
