#!/usr/bin/env bun
// Flow 331, AC1 — build `bench/jev-review/dataset.json` deterministically
// from this repository's own review history: every review package under
// `.metaproject/reviews/*` and `.metaproject/flows/*/reviews/*`, each
// finding reduced to {severity, reviewer, file/line, disposition, PR ref,
// diff ref}, joined to its owning flow's frozen acceptance criteria and how
// many are confirmed.
//
// PUBLIC DATA ONLY (AC1): every source this reads is committed to this
// repository already — review packages, the disposition ledger, flow.json
// and acceptance-criteria.md. No network call, no credential, nothing under
// `~/work`.
//
// DETERMINISM: `problems`/`findings`/`flows`/`counts` are a pure function of
// the files on disk, sorted by id. `generatedAt` is a timestamp and is the
// one field two runs on the same tree may legitimately disagree on — see
// `build-dataset.test.ts`, which asserts everything else is byte-identical.
//
// LABEL MAPPING (mirrors `scripts/review-precision-baseline.ts`'s own
// precision ratio, restated in `types.ts`'s `labelFor` — that function is
// the single source of truth; this comment is a pointer to it, not a second
// copy of the rule):
//
//   true-positive  <- disposition.state === "acted-on"
//   false-positive <- disposition.state === "dismissed-incorrect"
//   unlabeled      <- everything else, including "unknown"
//
// DISPOSITION RESOLUTION (same three sources, same precedence, as the
// baseline script — reproduced here rather than imported because that
// script's functions are not exported and its `main()` runs on import):
//
//   0. record            — the finding's own `disposition` field.
//   1. report-closed-by  — a `closed by \`<sha>\`` marker in the package's
//      report.md, only when this repository actually has that commit.
//   2. ledger             — a row in `.metaproject/reviews/dispositions.json`.
//   3. none               — no disposition found; state is "unknown".
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { labelFor, type Dataset, type DatasetDisposition, type DatasetFinding, type DatasetFlowAc, type DispositionState } from "./types";

const DEFAULT_ROOT = path.resolve(import.meta.dir, "..", "..");

const DISPOSITION_STATES: readonly DispositionState[] = [
  "unknown",
  "acted-on",
  "dismissed-incorrect",
  "dismissed-wont-fix",
  "dismissed-out-of-scope",
  "dismissed-deprioritised",
  "answered-disagree",
];
function isDispositionState(value: unknown): value is DispositionState {
  return typeof value === "string" && (DISPOSITION_STATES as readonly string[]).includes(value);
}

interface OnDiskFinding {
  readonly id: string;
  readonly global_id?: string;
  readonly severity?: string;
  readonly reviewer?: string;
  readonly file?: string | null;
  readonly line?: number | null;
  readonly disposition?: { readonly state?: string; readonly evidence?: string };
}

interface Manifest {
  readonly reviewId: string;
  readonly status?: string;
  readonly target?: { readonly kind?: string; readonly ref?: string; readonly head?: string };
  readonly flow?: { readonly id?: string; readonly path?: string };
}

interface LedgerRow {
  readonly reviewId: string;
  readonly findingId: string;
  readonly category: string;
  readonly evidence: string;
}

function findingKey(reviewId: string, finding: OnDiskFinding): string {
  return typeof finding.global_id === "string" && finding.global_id !== "" ? finding.global_id : `${reviewId}#${finding.id}`;
}

/** Every directory holding a `manifest.json`, under both roots review packages are written to — mirrors `review-precision-baseline.ts`'s `packageDirs`. */
function packageDirs(root: string): string[] {
  const out: string[] = [];
  const standalone = path.join(root, ".metaproject", "reviews");
  if (existsSync(standalone)) {
    for (const entry of readdirSync(standalone)) {
      const dir = path.join(standalone, entry);
      if (statSync(dir).isDirectory() && existsSync(path.join(dir, "manifest.json"))) out.push(dir);
    }
  }
  const flows = path.join(root, ".metaproject", "flows");
  if (existsSync(flows)) {
    for (const flow of readdirSync(flows)) {
      const reviews = path.join(flows, flow, "reviews");
      if (!existsSync(reviews) || !statSync(reviews).isDirectory()) continue;
      for (const entry of readdirSync(reviews)) {
        const dir = path.join(reviews, entry);
        if (statSync(dir).isDirectory() && existsSync(path.join(dir, "manifest.json"))) out.push(dir);
      }
    }
  }
  return out.sort();
}

const FINDING_HEADING = /^[ \t]*(?:#{1,6}|[-*+])[ \t]+\[?(F-\d{3,})\b/gm;
const CLOSED_BY = /[Cc]losed by [`"']?([0-9a-f]{7,40})[`"']?/;
const CELL_SHA = /[`"']([0-9a-f]{7,40})[`"']/;

/** `{findingId: sha}` for every finding a package's report.md says was closed — mirrors the baseline script's `reportDispositions`. */
function reportDispositions(report: string): Map<string, string> {
  const out = new Map<string, string>();
  const heads: Array<{ id: string; at: number }> = [];
  for (const match of report.matchAll(FINDING_HEADING)) heads.push({ id: (match[1] as string).toUpperCase(), at: match.index ?? 0 });
  for (const [index, head] of heads.entries()) {
    const end = heads[index + 1]?.at ?? report.length;
    const sha = report.slice(head.at, end).match(CLOSED_BY);
    if (sha?.[1]) out.set(head.id, sha[1]);
  }
  for (const line of report.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.replace(/^\||\|$/g, "").split("|");
    const ids = (cells[0] ?? "").match(/F-\d{3,}/g);
    const sha = (cells[1] ?? "").match(CELL_SHA);
    if (!ids || !sha?.[1]) continue;
    for (const id of ids) if (!out.has(id.toUpperCase())) out.set(id.toUpperCase(), sha[1]);
  }
  return out;
}

function commitExists(root: string, sha: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, stdio: "ignore" });
  return result.status === 0;
}

function loadLedger(file: string): LedgerRow[] {
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { rows?: LedgerRow[] };
  return parsed.rows ?? [];
}

function resolveDisposition(
  root: string,
  reviewId: string,
  finding: OnDiskFinding,
  reportDispositionsByFinding: Map<string, string>,
  ledgerByKey: Map<string, LedgerRow>,
  problems: string[],
): DatasetDisposition {
  const key = findingKey(reviewId, finding);

  const recordedState = finding.disposition?.state;
  if (recordedState !== undefined && recordedState !== "unknown") {
    if (!isDispositionState(recordedState)) {
      problems.push(`${key}: findings.json records disposition state "${recordedState}", which is not a known state`);
    } else {
      return {
        state: recordedState,
        source: "record",
        evidence: finding.disposition?.evidence ?? `${reviewId}/findings.json: disposition recorded without evidence`,
      };
    }
  }

  const sha = reportDispositionsByFinding.get(finding.id.toUpperCase());
  if (sha !== undefined && commitExists(root, sha)) {
    return { state: "acted-on", source: "report-closed-by", evidence: `${reviewId}/report.md: closed by ${sha}` };
  }
  if (sha !== undefined) {
    problems.push(`${key}: report names commit ${sha}, which this repository does not have`);
  }

  const row = ledgerByKey.get(key);
  if (row) {
    if (!isDispositionState(row.category)) {
      problems.push(`ledger: ${key} has unknown category "${row.category}"`);
    } else {
      return { state: row.category, source: "ledger", evidence: row.evidence };
    }
  }

  return { state: "unknown", source: "none", evidence: "no disposition recorded in the review package, its flow, or the ledger" };
}

interface FlowMeta {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly acChecksum: string | null;
  readonly criteria: string[];
  readonly confirmedCount: number;
}

function loadFlow(root: string, flowPath: string): FlowMeta | null {
  const flowJsonPath = path.join(root, flowPath, "flow.json");
  if (!existsSync(flowJsonPath)) return null;
  const flow = JSON.parse(readFileSync(flowJsonPath, "utf8")) as {
    id: string;
    title: string;
    status: string;
    acChecksum?: string;
    acConfirmed?: Record<string, unknown>;
  };
  const acPath = path.join(root, flowPath, "acceptance-criteria.md");
  const criteria: string[] = [];
  if (existsSync(acPath)) {
    for (const line of readFileSync(acPath, "utf8").split("\n")) {
      const match = /^- (AC\d+): (.*)$/.exec(line.trim());
      if (match) criteria.push(`${match[1]}: ${match[2]}`);
    }
  }
  return {
    id: flow.id,
    title: flow.title,
    status: flow.status,
    acChecksum: flow.acChecksum ?? null,
    criteria,
    confirmedCount: Object.keys(flow.acConfirmed ?? {}).length,
  };
}

export function buildDataset(root: string = DEFAULT_ROOT): Dataset {
  const dirs = packageDirs(root);
  const ledgerRows = loadLedger(path.join(root, ".metaproject", "reviews", "dispositions.json"));
  const ledgerByKey = new Map<string, LedgerRow>();
  const problems: string[] = [];
  for (const row of ledgerRows) {
    const key = `${row.reviewId}#${row.findingId}`;
    if (ledgerByKey.has(key)) {
      problems.push(`ledger: duplicate row for ${key}`);
      continue;
    }
    ledgerByKey.set(key, row);
  }

  const findings: DatasetFinding[] = [];
  const flowsById = new Map<string, FlowMeta>();
  const seenLedgerKeys = new Set<string>();

  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
    const findingsPath = path.join(dir, "findings.json");
    const onDisk: OnDiskFinding[] = existsSync(findingsPath) ? (JSON.parse(readFileSync(findingsPath, "utf8")) as OnDiskFinding[]) : [];
    const reportPath = path.join(dir, "report.md");
    const reportText = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const auto = reportDispositions(reportText);

    const flowId = manifest.flow?.id ?? null;
    if (flowId !== null && manifest.flow?.path !== undefined && !flowsById.has(flowId)) {
      const meta = loadFlow(root, manifest.flow.path);
      if (meta) flowsById.set(flowId, meta);
    }

    for (const finding of onDisk) {
      const key = findingKey(manifest.reviewId, finding);
      seenLedgerKeys.add(key);
      const disposition = resolveDisposition(root, manifest.reviewId, finding, auto, ledgerByKey, problems);
      findings.push({
        globalId: key,
        reviewId: manifest.reviewId,
        findingId: finding.id,
        flowId,
        prRef: manifest.target?.kind === "pr" ? (manifest.target.ref ?? null) : null,
        diffRef: manifest.target?.head ?? null,
        severity: finding.severity ?? "unknown",
        reviewer: finding.reviewer ?? "unknown",
        file: finding.file ?? null,
        line: finding.line ?? null,
        disposition,
        label: labelFor(disposition.state),
      });
    }
  }

  for (const key of ledgerByKey.keys()) {
    if (!seenLedgerKeys.has(key)) problems.push(`ledger: row for ${key}, which is not a finding on disk`);
  }

  findings.sort((a, b) => a.globalId.localeCompare(b.globalId));

  const flows: DatasetFlowAc[] = [...flowsById.values()]
    .map((meta): DatasetFlowAc => ({
      flowId: meta.id,
      title: meta.title,
      status: meta.status,
      acChecksum: meta.acChecksum,
      criteria: meta.criteria,
      confirmedCount: meta.confirmedCount,
      totalCount: meta.criteria.length,
    }))
    .sort((a, b) => a.flowId.localeCompare(b.flowId, undefined, { numeric: true }));

  const byLabel: Record<"true-positive" | "false-positive" | "unlabeled", number> = {
    "true-positive": 0,
    "false-positive": 0,
    unlabeled: 0,
  };
  for (const f of findings) byLabel[f.label] += 1;

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRepo: "keryx (this repository, public)",
    labelMapping: {
      "true-positive": 'disposition.state === "acted-on"',
      "false-positive": 'disposition.state === "dismissed-incorrect"',
      unlabeled: "every other disposition state, including \"unknown\" — excluded from precision/recall denominators, still counted",
    },
    findings,
    flows,
    counts: { packages: dirs.length, findings: findings.length, byLabel },
    problems: problems.sort(),
  };
}

function main(): void {
  const argv = Bun.argv.slice(2);
  const optionValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = path.resolve(optionValue("--root") ?? DEFAULT_ROOT);
  const out = path.resolve(optionValue("--out") ?? path.join(import.meta.dir, "dataset.json"));

  const dataset = buildDataset(root);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(dataset, null, 2) + "\n", "utf8");

  console.log(`bench/jev-review: wrote ${path.relative(root, out)}`);
  console.log(`  packages: ${dataset.counts.packages}`);
  console.log(`  findings: ${dataset.counts.findings}`);
  console.log(
    `  labels:   true-positive=${dataset.counts.byLabel["true-positive"]} false-positive=${dataset.counts.byLabel["false-positive"]} unlabeled=${dataset.counts.byLabel.unlabeled}`,
  );
  console.log(`  flows:    ${dataset.flows.length}`);
  if (dataset.problems.length > 0) {
    console.log(`  problems: ${dataset.problems.length}`);
    for (const problem of dataset.problems) console.log(`    - ${problem}`);
  }
  process.exit(dataset.problems.length > 0 ? 1 : 0);
}

if (import.meta.main) main();
