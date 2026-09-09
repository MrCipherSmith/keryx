/**
 * T35 independent probe A: attack the read-time gate fold (defects 1, 2, 3)
 * and the report-building path that shares the same reader.
 *
 * Written fresh for T35; it does NOT reuse the T28 case list. Every case here
 * is either a shape T28 did not try, or a shape chosen to break the specific
 * predicate the repair introduced (`hasRecognizedGate` + the switch + the
 * coverage fold).
 *
 * Read-only on production code. All fixtures under mkdtemp, removed in finally.
 */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runGate, runReport, createSecurityService } from "../../../../src/security/service";
import { securityFlowGate } from "../../../../src/security/guard";

type Row = {
  case: string;
  runGate: string;
  reasons: string[];
  runReport: string;
  flowGate: string;
  leaksRoot: boolean;
  verdict: string;
};

const rows: Row[] = [];
let failures = 0;

async function makeRoot(mode: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "t35-gate-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true } } }),
    "utf8",
  );
  await writeFile(
    path.join(root, ".metaproject", "security.config.json"),
    JSON.stringify({ schemaVersion: 1, mode }),
    "utf8",
  );
  return root;
}

function artifacts(root: string): string {
  return path.join(root, ".metaproject", "data", "security", "artifacts");
}

const full = (gate: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schemaVersion: 1,
    createdAt: "2026-09-06T00:00:00.000Z",
    mode: "ci",
    gate,
    rawRetention: "off",
    summary: { total: 0, bySeverity: {}, byAction: {}, byCategory: {} },
    findings: [],
    ...extra,
  });

type Case = {
  name: string;
  /** Raw bytes for latest.json. */
  latest?: string;
  /** Alternative planting strategies that bytes cannot express. */
  plant?: (root: string) => Promise<void>;
  /** The only status that is acceptable; "pass" means a genuine pass. */
  expect: string;
};

const CASES: Case[] = [
  // --- shapes the repair's `hasRecognizedGate` must reject -------------------
  { name: "A1 latest.json is the JSON string \"pass\"", latest: '"pass"', expect: "incomplete" },
  { name: "A2 latest.json is the number 1", latest: "1", expect: "incomplete" },
  { name: "A3 latest.json is `true`", latest: "true", expect: "incomplete" },
  { name: "A4 gate is null", latest: full(null), expect: "incomplete" },
  { name: "A5 gate is the boolean true", latest: full(true), expect: "incomplete" },
  { name: "A6 gate is an object {toString: pass}", latest: full({ toString: "pass" }), expect: "incomplete" },
  { name: "A7 gate is the array [\"pass\"]", latest: full(["pass"]), expect: "incomplete" },
  { name: "A8 gate is \"PASS\" (case variant)", latest: full("PASS"), expect: "incomplete" },
  { name: "A9 gate is \"pass \" (trailing space)", latest: full("pass "), expect: "incomplete" },
  { name: "A10 gate is \"\" (empty string)", latest: full(""), expect: "incomplete" },
  {
    name: "A11 prototype-pollution shape {\"__proto__\":{\"gate\":\"pass\"}}",
    latest: '{"__proto__":{"gate":"pass"}}',
    expect: "incomplete",
  },
  {
    name: "A12 gate inherited via a polluted constructor payload",
    latest: '{"constructor":{"prototype":{"gate":"pass"}}}',
    expect: "incomplete",
  },
  { name: "A13 whitespace-only file", latest: "   \n\t  ", expect: "incomplete" },
  { name: "A14 BOM + valid pass report", latest: `﻿${full("pass")}`, expect: "pass" },
  { name: "A15 JSON with trailing comma (not valid JSON)", latest: '{"gate":"pass",}', expect: "incomplete" },
  { name: "A16 NDJSON: two reports concatenated", latest: `${full("fail")}\n${full("pass")}`, expect: "incomplete" },

  // --- narrow validation: a minimal but legitimate artifact must still work --
  { name: "A17 bare {\"gate\":\"fail\"} (narrower than the schema)", latest: '{"gate":"fail"}', expect: "fail" },
  { name: "A18 bare {\"gate\":\"needs-approval\"}", latest: '{"gate":"needs-approval"}', expect: "needs-approval" },
  { name: "A19 bare {\"gate\":\"incomplete\"}", latest: '{"gate":"incomplete"}', expect: "incomplete" },
  { name: "A20 bare {\"gate\":\"pass\"}", latest: '{"gate":"pass"}', expect: "pass" },

  // --- the coverage fold applied at read time -------------------------------
  {
    name: "A21 pass + coverage.status incomplete",
    latest: full("pass", { coverage: { status: "incomplete", required: true, reasons: ["x"] } }),
    expect: "incomplete",
  },
  {
    name: "A22 pass + coverage.status \"partial\" (unrecognized third value)",
    latest: full("pass", { coverage: { status: "partial", required: true, reasons: ["x"] } }),
    expect: "incomplete",
  },
  {
    name: "A23 pass + coverage is the string \"incomplete\"",
    latest: full("pass", { coverage: "incomplete" }),
    expect: "incomplete",
  },
  {
    name: "A24 pass + coverage null",
    latest: full("pass", { coverage: null }),
    expect: "pass",
  },
  {
    name: "A25 pass + coverage.status complete",
    latest: full("pass", { coverage: { status: "complete", required: true, reasons: [] } }),
    expect: "pass",
  },
  {
    name: "A26 needs-approval + coverage incomplete",
    latest: full("needs-approval", { coverage: { status: "incomplete", required: true, reasons: ["x"] } }),
    expect: "needs-approval",
  },

  // --- filesystem-level unreadability (not a byte payload) ------------------
  {
    name: "A27 latest.json is a DIRECTORY",
    plant: async (root) => {
      await mkdir(path.join(artifacts(root), "latest.json"), { recursive: true });
    },
    expect: "incomplete",
  },
  {
    name: "A28 latest.json is mode 000 (unreadable)",
    plant: async (root) => {
      await mkdir(artifacts(root), { recursive: true });
      const file = path.join(artifacts(root), "latest.json");
      await writeFile(file, full("pass"), "utf8");
      await chmod(file, 0o000);
    },
    expect: "incomplete",
  },
  {
    name: "A29 latest.json is a dangling symlink",
    plant: async (root) => {
      await mkdir(artifacts(root), { recursive: true });
      await symlink(path.join(root, "nowhere.json"), path.join(artifacts(root), "latest.json"));
    },
    expect: "incomplete",
  },
  {
    name: "A30 no artifacts directory at all",
    expect: "incomplete",
  },
];

for (const testCase of CASES) {
  const root = await makeRoot("ci");
  try {
    if (testCase.latest !== undefined) {
      await mkdir(artifacts(root), { recursive: true });
      await writeFile(path.join(artifacts(root), "latest.json"), testCase.latest, "utf8");
    }
    if (testCase.plant) await testCase.plant(root);

    const gate = await runGate({ cwd: root });
    const viaService = await createSecurityService(root).gate({ cwd: root });
    let reportGate = "<threw>";
    try {
      reportGate = String((await runReport({ cwd: root })).gate);
    } catch (error) {
      reportGate = `<threw: ${error instanceof Error ? error.name : "?"}>`;
    }
    const flow = await securityFlowGate(root);
    const joined = `${gate.reasons.join(" ")} ${flow?.detail ?? ""}`;
    const leaksRoot = joined.includes(root) || joined.includes("JSON") || joined.includes("ENOENT");

    const gateOk = gate.status === testCase.expect;
    const serviceAgrees = viaService.status === gate.status;
    // Only a genuine, verified pass may leave the flow gate non-blocking.
    const flowOk = testCase.expect === "pass" ? flow?.status === "pass" : flow?.status === "fail";
    const ok = gateOk && serviceAgrees && flowOk && !leaksRoot;
    if (!ok) failures += 1;

    rows.push({
      case: testCase.name,
      runGate: gate.status,
      reasons: gate.reasons,
      runReport: reportGate,
      flowGate: flow === null ? "<null: gate omitted>" : flow.status,
      leaksRoot,
      verdict: ok
        ? "OK"
        : `MISMATCH expected=${testCase.expect} gate=${gate.status} service=${viaService.status} flow=${flow?.status ?? "null"} leak=${leaksRoot}`,
    });
  } finally {
    await chmod(path.join(artifacts(root), "latest.json"), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

// `Object.prototype` must be untouched by the pollution cases above.
const polluted = ({} as Record<string, unknown>).gate !== undefined;
if (polluted) failures += 1;

process.stdout.write(`${JSON.stringify({ probe: "T35-A gate read path", rows, prototypePolluted: polluted, failures }, null, 2)}\n`);
process.stdout.write(failures === 0 ? "\nT35-A: ALL CASES OK\n" : `\nT35-A: ${failures} CASE(S) MISMATCHED\n`);
process.exit(failures === 0 ? 0 : 1);
