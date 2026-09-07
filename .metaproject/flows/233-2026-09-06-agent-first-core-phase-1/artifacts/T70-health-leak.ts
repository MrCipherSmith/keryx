// T70 probe — row 4: the health "reason leak" repair (T62 F-005 / T69).
//
// Measured ON THE ARTIFACT, not on the in-memory return value: every assertion
// below reads `.metaproject/data/health/artifacts/latest.json` and `latest.md`
// back from disk after `runHealth()` wrote them, and then re-reads the gate
// through the REAL `createCodeHealthService().gate({cwd})` — the exact value
// `src/flow/service.ts:640`'s `healthGateOutcome` folds into `flow.json`.
//
// Evidence-failure guards this probe is built against:
//   1. "a pure function cannot observe a fix at its call site" — the fix is in
//      `runAdapter`, the consumer is `computeGate`; this probe never calls
//      either directly, only `runHealth()` and the service's `gate()`.
//   2. "a regression whose fixtures differ in an irrelevant way passes
//      regardless of the code" — row P1 is a POSITIVE control that plants the
//      same bytes through a producer T69 did NOT change (`validation.error`,
//      `run.ts:356-357`). If P1 does not leak, this probe is not capable of
//      seeing a leak at all and every clean row below is worthless.
//   3. "a claim about an artifact must be tested on the artifact" — see above.
import { mock } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const ROOT = "/Users/Goodea/goodea/keryx";
const SOURCES = path.join(ROOT, "src/health/sources/index.ts");

const PLANTED_PATH = "/Users/attacker/.ssh/id_rsa";
const PLANTED_CRED = "AKIAIOSFODNN7EXAMPLE";
const PLANTED = `${PLANTED_PATH} ${PLANTED_CRED}`;

const realSources = (await import(SOURCES)) as Record<string, unknown>;

type Site = "detect" | "import" | "parse" | "validate" | "none";
let SITE: Site = "none";
let CODE: string | undefined;

function boom(): never {
  const err = new Error(`spawn failed reading ${PLANTED}`) as Error & { code?: string };
  if (CODE !== undefined) err.code = CODE;
  throw err;
}

const raw = {
  content: "[]",
  command: "synthetic",
  toolVersion: null,
  exitCode: 0,
  imported: true,
  format: "json",
};

const adapter = {
  id: "eslint",
  async detect() {
    if (SITE === "detect") boom();
    return "available";
  },
  async run() {
    if (SITE === "import") boom();
    return raw;
  },
  async import() {
    if (SITE === "import") boom();
    return raw;
  },
  parse() {
    if (SITE === "parse") boom();
    return [];
  },
  validate() {
    if (SITE === "validate") {
      // The one `error:` producer in run.ts that T69 did NOT touch: an
      // adapter-supplied validation error, interpolated verbatim at :356-357.
      return { valid: false, error: `synthetic validation failure ${PLANTED}` };
    }
    return { valid: true, format: "json" };
  },
};

mock.module(SOURCES, () => ({ ...realSources, FINDING_ADAPTERS: [adapter] }));

const { runHealth } = await import(path.join(ROOT, "src/health/run.ts"));
const { createCodeHealthService } = await import(path.join(ROOT, "src/health/service.ts"));

function scan(text: string) {
  return {
    path: text.includes(PLANTED_PATH),
    cred: text.includes(PLANTED_CRED),
    message: text.includes("spawn failed"),
  };
}

const out = (o: unknown) => console.log(JSON.stringify(o));

async function ws(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "t70-health-"));
  await mkdir(path.join(dir, ".metaproject"), { recursive: true });
  await mkdir(path.join(dir, "src"), { recursive: true });
  await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n", "utf8");
  return dir;
}

type Row = { id: string; site: Site; code?: string; note: string };
const ROWS: Row[] = [
  { id: "H1 detect throws (run.ts:279)", site: "detect", note: "site 1" },
  { id: "H2 import/run throws (run.ts:314)", site: "import", note: "site 2" },
  { id: "H3 parse throws (run.ts:336)", site: "parse", note: "site 3" },
  {
    id: "H4 detect throws WITH a legal errno code",
    site: "detect",
    code: "ENOENT",
    note: "the closed-vocabulary suffix must appear, and nothing else",
  },
  {
    id: "H5 detect throws with a code that smuggles the payload",
    site: "detect",
    code: `EACCES ${PLANTED}`,
    note: "safeErrorCode's /^[A-Z][A-Z0-9]{2,15}$/ must reject it",
  },
  {
    id: "H6 detect throws with a long all-caps code",
    site: "detect",
    code: "A".repeat(64),
    note: "length bound",
  },
  {
    id: "P1 POSITIVE CONTROL: adapter validate() error (run.ts:356, untouched by T69)",
    site: "validate",
    note: "must LEAK, or this probe cannot see a leak at all",
  },
  { id: "C0 control: no throw", site: "none", note: "clean baseline" },
];

for (const row of ROWS) {
  SITE = row.site;
  CODE = row.code;
  const cwd = await ws();
  try {
    const result = await runHealth({ cwd });

    const jsonPath = path.join(
      cwd, ".metaproject", "data", "health", "artifacts", "latest.json",
    );
    const mdPath = path.join(
      cwd, ".metaproject", "data", "health", "artifacts", "latest.md",
    );
    const jsonBytes = await readFile(jsonPath, "utf8");
    let mdBytes = "";
    try {
      mdBytes = await readFile(mdPath, "utf8");
    } catch {
      mdBytes = "";
    }

    // The value flow.json's completion-failed history is built from.
    const serviceGate = await createCodeHealthService().gate({ cwd });

    const eslint = (result.report.sources as Array<{ source: string; error?: string }>)
      .find((s) => s.source === "eslint");
    const reasons = (result.report.gate.reasons as string[]).join("\n");

    out({
      id: row.id,
      note: row.note,
      sourceError: eslint?.error ?? null,
      gateStatusInMemory: result.report.gate.status,
      gateStatusOnDisk: (JSON.parse(jsonBytes) as { gate: { status: string } }).gate.status,
      serviceGateStatus: serviceGate.status,
      serviceGateReasons: serviceGate.reasons,
      namesTheStage:
        typeof eslint?.error === "string" &&
        /(detection|execution|parse) failed/.test(eslint.error),
      LEAK_inMemoryReasons: scan(reasons),
      LEAK_committableArtifactJson: scan(jsonBytes),
      LEAK_committableArtifactMd: scan(mdBytes),
      LEAK_serviceGateReasons: scan(serviceGate.reasons.join("\n")),
      artifactPathOnDisk: jsonPath.startsWith(cwd),
    });
  } catch (e) {
    out({ id: row.id, ERROR: String(e).slice(0, 200) });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
