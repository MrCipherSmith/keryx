// Apply one narrow, single-defect mutation to the scratch copy, run the named
// test files, restore, and report. Never touches the real checkout.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const ROOT = "/private/tmp/claude-502/-Users-Goodea-goodea-keryx/2c1aca69-07c3-46d7-89d4-79e0152123a5/scratchpad/T24R2-mut";

type Mutation = {
  id: string;
  defect: string;
  file: string;
  find: string;
  replace: string;
  testFiles: string[];
  expectFail: string[];
};

const OV = `${ROOT}/src/security/output-validation.ts`;
const EX = `${ROOT}/src/security/detect/exfil.ts`;
const MCP_T = "src/mcp/structural-redaction.test.ts";
const PERS_T = "src/security/persistence-sinks.test.ts";
const EXFIL_T = "src/security/detect/exfil.test.ts";
const OV_T = "src/security/output-validation.test.ts";

const mutations: Mutation[] = [
  {
    id: "M1",
    defect: "T24#F-001 — property-name screen removed (credential key copied through)",
    file: OV,
    find: `      if (isSensitivePropertyName(nestedKey)) {
        return { ok: false, reason: "sensitive-property-name" };
      }
`,
    replace: "",
    testFiles: [MCP_T, PERS_T],
    expectFail: ["property name carries a credential"],
  },
  {
    id: "M2",
    defect: "T24#F-003 — $ref sibling screen removed",
    file: OV,
    find: `      if (Object.keys(schema).some((key) => !REFERENCE_SAFE_SIBLINGS.has(key))) {
        return { ok: false, reason: "schema.unsupported-reference-siblings" };
      }
`,
    replace: "",
    testFiles: [MCP_T, PERS_T],
    expectFail: ["validation sibling"],
  },
  {
    id: "M3",
    defect: "T24#F-004a — character-reference decoding removed from URL classification",
    file: EX,
    find: `    decodeCharacterReferences(url).replace(URL_STRIPPED_CHARACTERS, ""),`,
    replace: `    url.replace(URL_STRIPPED_CHARACTERS, ""),`,
    testFiles: [MCP_T, PERS_T],
    expectFail: ["entity-encoded image src"],
  },
  {
    id: "M4",
    defect: "T24#F-004b — srcset candidate enumeration removed",
    file: EX,
    find: `  HTML_IMG_SRCSET.lastIndex = 0;
  while ((m = HTML_IMG_SRCSET.exec(content)) !== null) {`,
    replace: `  HTML_IMG_SRCSET.lastIndex = 0;
  while (false && (m = HTML_IMG_SRCSET.exec(content)) !== null) {`,
    testFiles: [MCP_T, PERS_T],
    expectFail: ["srcset candidate"],
  },
  {
    id: "M5",
    defect:
      "T24#F-002 / T24R#F-001 — byte preservation made unconditional again (original bytes restored whenever the walk says none)",
    file: OV,
    find: `  return bytesAreCanonicalFor(content, result.text)
    ? { ...result, text: content }
    : {
        ...result,
        redaction: { state: "redacted", reasons: [SERIALIZED_NORMALIZED_REASON] },
      };`,
    replace: `  return { ...result, text: content };`,
    testFiles: [MCP_T, PERS_T],
    expectFail: ["duplicate member hiding a credential"],
  },
  {
    id: "M6",
    defect:
      "T24R#F-002 — character-reference decoder re-bounded by digit count (the zero-padding defect)",
    file: EX,
    find: `  /&(?:#(\\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;`,
    replace: `  /&(?:#(\\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));?/g;`,
    testFiles: [MCP_T, PERS_T, EXFIL_T, OV_T],
    expectFail: ["zero-padded"],
  },
  {
    id: "M7",
    defect: "T24R#F-002 — URL whitespace/control stripping removed",
    file: EX,
    find: `function renderableUrl(url: string): string {
  return stripC0OrSpace(
    decodeCharacterReferences(url).replace(URL_STRIPPED_CHARACTERS, ""),
  );
}`,
    replace: `function renderableUrl(url: string): string {
  return decodeCharacterReferences(url);
}`,
    testFiles: [MCP_T, PERS_T, EXFIL_T, OV_T],
    expectFail: ["whitespace"],
  },
];

const only = process.argv[2];
const report: unknown[] = [];

for (const mutation of mutations) {
  if (only && only !== "all" && only !== mutation.id) continue;
  const original = readFileSync(mutation.file, "utf8");
  if (!original.includes(mutation.find)) {
    report.push({ id: mutation.id, applied: false, error: "anchor not found" });
    continue;
  }
  writeFileSync(mutation.file, original.replace(mutation.find, mutation.replace));
  const run = spawnSync("bun", ["test", ...mutation.testFiles], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  writeFileSync(mutation.file, original);
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const failLines = out
    .split("\n")
    .filter((l) => /^\(fail\)/.test(l.trim()) || l.includes("(fail)"))
    .map((l) => l.trim());
  const tally = out.match(/\n\s*(\d+) pass\n\s*(?:(\d+) skip\n\s*)?(\d+) fail/);
  report.push({
    id: mutation.id,
    defect: mutation.defect,
    applied: true,
    exitCode: run.status,
    pass: tally?.[1] ?? null,
    fail: tally?.[3] ?? null,
    failingTests: failLines,
  });
  console.log(`--- ${mutation.id} :: ${mutation.defect}`);
  console.log(`    pass=${tally?.[1] ?? "?"} fail=${tally?.[3] ?? "?"}`);
  for (const l of failLines) console.log(`    ${l}`);
}

writeFileSync(process.argv[3] ?? "/tmp/T24R2-mutations.json", JSON.stringify(report, null, 2));
console.log("done");
