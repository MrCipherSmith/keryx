#!/usr/bin/env bun
// Recompute the review-precision baseline from the review packages on disk.
//
// WHY THIS EXISTS
//
// Flow 202 changes the review pipeline: a deterministic pre-filter, and a
// verifier that deletes findings. A precision figure taken after those land
// proves nothing without a before. Every justification in that plan is somebody
// else's measurement — 30-42% valid comments over 22,326 industry comments,
// ~12.5% useful in the one independent field study. This script produces ours,
// from our own records, and is the reason the after-figure will be comparable
// rather than re-estimated.
//
// WHAT PRECISION MEANS HERE
//
//   precision = acted-on / (acted-on + dismissed-incorrect)
//
// Only those two categories say anything about reviewer accuracy. A finding
// nobody acted on because it was out of scope is not a false positive, so
// `dismissed-wont-fix`, `dismissed-out-of-scope` and `dismissed-deprioritised`
// are counted separately and stay OUT of the denominator. Conflating them into
// one "dismissed" bucket is what makes a dismissal rate meaningless.
//
// A finding with no evidence either way is `unknown`. It is never `acted-on`
// and never `dismissed-incorrect`: an unknown counted as valid inflates the
// very number we are about to measure ourselves against.
//
// WHERE THE DISPOSITIONS COME FROM
//
// `review-finding.schema.json` gained a `disposition` property in flow 202, but
// no finding written before that carries one. Three sources are used, in
// descending strength, and every classified finding carries which one answered:
//
//   0. `record` — the finding's own `disposition` field, written by an
//      instrumented review (`keryx review complete --finding <id> --disposition
//      <state> --evidence <ref>`, or the `--refuted` ingest channel). Outranks
//      everything below, because it is the only source that is a decision
//      rather than an inference. Nothing on disk carries it yet — all 83
//      findings predate the field — but without this branch an instrumented
//      review would still classify as `unknown` and the number could never move.
//   1. `report-closed-by` — AUTOMATIC. The report block for a finding, or a row
//      of a `# Disposition` table in the same report, carries a
//      `closed by \`<sha>\`` marker. The sha is resolved against git, so a
//      marker naming a commit this repository does not have is not evidence.
//   2. `ledger` — CURATED. A row in the disposition ledger (default
//      `.metaproject/reviews/dispositions.json`), each carrying the category,
//      the file the evidence is in, and a quotation from it. Rows exist for
//      findings whose disposition is recorded in prose the extractor cannot
//      reach — a fix-round review record that resolves a prior finding, or an
//      owning flow's description and journal.
//
// Everything else is `unknown`, by omission rather than by judgement.
//
// USAGE
//
//   bun run baseline:review-precision
//   bun run baseline:review-precision -- --json
//   bun scripts/review-precision-baseline.ts --ledger <path> --root <repo>
//
// Exit code is 1 when the ledger and the inventory disagree — a ledger row for
// a finding that is not on disk, or a duplicate row. A measurement that quietly
// tolerates a stale ledger is not a measurement.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const DEFAULT_ROOT = path.resolve(import.meta.dir, "..");

/** The categories. Only the first two are in the precision ratio. */
const CATEGORIES = [
  "acted-on",
  "dismissed-incorrect",
  "dismissed-wont-fix",
  "dismissed-out-of-scope",
  "dismissed-deprioritised",
  "unknown",
] as const;
type Category = (typeof CATEGORIES)[number];

type OnDiskFinding = {
  id: string;
  /**
   * The join key, when the record carries one: `<mintingReviewId>#<id>`.
   *
   * READ, not recomputed. `assignGlobalIds` mints only when the key is absent,
   * so a finding carried into round 2 through `prior_findings` keeps
   * `rev-round1#F-001` — and recomputing `${reviewId}#${id}` here would look for
   * `rev-round2#F-001`, classify a dispositioned finding as `unknown` AND
   * report the ledger row as stale. That case is exactly what the field exists
   * to serve, so the measurement has to key on it.
   */
  global_id?: string;
  severity: string;
  reviewer: string;
  summary?: string;
  disposition?: { state?: string; evidence?: string };
};

/** The key this measurement joins on, agreeing with `mintGlobalFindingId`. */
function findingKey(reviewId: string, finding: OnDiskFinding): string {
  return typeof finding.global_id === "string" && finding.global_id !== ""
    ? finding.global_id
    : `${reviewId}#${finding.id}`;
}

type PackageRecord = {
  reviewId: string;
  dir: string;
  mode: string;
  status: string;
  target: { kind: string; ref: string };
  flowId: string | null;
  createdAt: string;
  findings: OnDiskFinding[];
  /** The report carries a NUL byte, so it is not text this tool can trust whole. */
  reportIsBinary: boolean;
  reportBytes: number;
};

/**
 * Where a classification came from, strongest first.
 *
 * One list, read by both the classifier and the report. When the report kept its
 * own hand-written copy the two drifted the moment `record` was added, and the
 * printed totals stopped adding up to the findings counted.
 */
const EVIDENCE_SOURCES = ["record", "report-closed-by", "ledger", "none"] as const;
type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];

type Classified = {
  reviewId: string;
  findingId: string;
  severity: string;
  category: Category;
  evidence: string;
  source: EvidenceSource;
};

type LedgerRow = {
  reviewId: string;
  findingId: string;
  category: Category;
  evidence: string;
};

type Ledger = { rows: LedgerRow[] };

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

/** Every directory holding a `manifest.json`, under both roots managed.ts writes. */
function packageDirs(root: string): string[] {
  const out: string[] = [];
  const standalone = path.join(root, ".metaproject", "reviews");
  if (existsSync(standalone)) {
    for (const entry of readdirSync(standalone)) {
      const dir = path.join(standalone, entry);
      if (statSync(dir).isDirectory() && existsSync(path.join(dir, "manifest.json"))) {
        out.push(dir);
      }
    }
  }
  const flows = path.join(root, ".metaproject", "flows");
  if (existsSync(flows)) {
    for (const flow of readdirSync(flows)) {
      const reviews = path.join(flows, flow, "reviews");
      if (!existsSync(reviews) || !statSync(reviews).isDirectory()) {
        continue;
      }
      for (const entry of readdirSync(reviews)) {
        const dir = path.join(reviews, entry);
        if (statSync(dir).isDirectory() && existsSync(path.join(dir, "manifest.json"))) {
          out.push(dir);
        }
      }
    }
  }
  return out.sort();
}

function inventory(root: string): PackageRecord[] {
  return packageDirs(root).map((dir) => {
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
      reviewId: string;
      mode: string;
      status: string;
      target: { kind: string; ref: string };
      flow?: { id: string };
      createdAt: string;
    };
    const findingsPath = path.join(dir, "findings.json");
    const findings = existsSync(findingsPath)
      ? (JSON.parse(readFileSync(findingsPath, "utf8")) as OnDiskFinding[])
      : [];
    const reportPath = path.join(dir, "report.md");
    const reportRaw = existsSync(reportPath) ? readFileSync(reportPath) : Buffer.alloc(0);
    return {
      reviewId: manifest.reviewId,
      dir: path.relative(root, dir),
      mode: manifest.mode,
      status: manifest.status,
      target: manifest.target,
      flowId: manifest.flow?.id ?? null,
      createdAt: manifest.createdAt,
      findings,
      reportIsBinary: reportRaw.includes(0),
      reportBytes: reportRaw.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Automatic disposition extraction
// ---------------------------------------------------------------------------

/** A line that opens a finding in a report: a heading or list marker, then the id. */
const FINDING_HEADING = /^[ \t]*(?:#{1,6}|[-*+])[ \t]+\[?(F-\d{3,})\b/gm;
/** The marker that says a finding was closed, and by which commit. */
const CLOSED_BY = /[Cc]losed by [`"']?([0-9a-f]{7,40})[`"']?/;
/** ``` `<sha>` ``` anywhere in a table cell. */
const CELL_SHA = /[`"']([0-9a-f]{7,40})[`"']/;

/**
 * `{findingId: sha}` for every finding this report says was closed.
 *
 * Two shapes, because the six PR #220 rounds used both: an inline
 * `closed by \`<sha>\`` inside the finding's own block, and a `# Disposition`
 * table whose first column names one or more ids and whose second names the
 * commit. The table is read only when its ids also appear in `findings.json`,
 * so a table row about some other round's numbering cannot leak in.
 */
function reportDispositions(report: string): Map<string, string> {
  const out = new Map<string, string>();

  const heads: Array<{ id: string; at: number }> = [];
  for (const match of report.matchAll(FINDING_HEADING)) {
    heads.push({ id: (match[1] as string).toUpperCase(), at: match.index ?? 0 });
  }
  for (const [index, head] of heads.entries()) {
    const end = heads[index + 1]?.at ?? report.length;
    const sha = report.slice(head.at, end).match(CLOSED_BY);
    if (sha?.[1]) {
      out.set(head.id, sha[1]);
    }
  }

  for (const line of report.split("\n")) {
    if (!line.startsWith("|")) {
      continue;
    }
    const cells = line.replace(/^\||\|$/g, "").split("|");
    const ids = (cells[0] ?? "").match(/F-\d{3,}/g);
    const sha = (cells[1] ?? "").match(CELL_SHA);
    if (!ids || !sha?.[1]) {
      continue;
    }
    for (const id of ids) {
      if (!out.has(id.toUpperCase())) {
        out.set(id.toUpperCase(), sha[1]);
      }
    }
  }
  return out;
}

/** Whether this repository actually has the commit a `closed by` marker names. */
function commitExists(root: string, sha: string): boolean {
  const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function loadLedger(file: string): Ledger {
  if (!existsSync(file)) {
    return { rows: [] };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { rows?: LedgerRow[] };
  return { rows: parsed.rows ?? [] };
}

function classify(
  root: string,
  packages: PackageRecord[],
  ledger: Ledger,
): { rows: Classified[]; problems: string[] } {
  const problems: string[] = [];

  const byKey = new Map<string, LedgerRow>();
  for (const row of ledger.rows) {
    const key = `${row.reviewId}#${row.findingId}`;
    if (byKey.has(key)) {
      problems.push(`ledger: duplicate row for ${key}`);
      continue;
    }
    if (!CATEGORIES.includes(row.category)) {
      problems.push(`ledger: ${key} has unknown category "${row.category}"`);
      continue;
    }
    byKey.set(key, row);
  }

  const rows: Classified[] = [];
  const seen = new Set<string>();
  for (const pkg of packages) {
    const reportPath = path.join(root, pkg.dir, "report.md");
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : "";
    const auto = reportDispositions(report);
    for (const finding of pkg.findings) {
      // The record's OWN key when it has one — see `findingKey`. A ledger row
      // therefore names the package the finding was MINTED in, not the round
      // that re-reported it, which is the only join that stays stable across
      // rounds.
      const key = findingKey(pkg.reviewId, finding);
      seen.add(key);

      // The record itself, when it has one, outranks both heuristics below.
      // Nothing on disk carries this today — all 83 findings predate the field —
      // but an instrumented review writes it, and without this branch such a
      // review would still classify as `unknown` and the number could never
      // move. Absent reads as `unknown` and falls through, so the pre-contract
      // corpus is unaffected.
      const recorded = finding.disposition;
      if (recorded?.state !== undefined && recorded.state !== "unknown") {
        if (!CATEGORIES.includes(recorded.state as Category)) {
          problems.push(`${key}: findings.json records disposition state "${recorded.state}", which is not a category`);
          continue;
        }
        rows.push({
          reviewId: pkg.reviewId,
          findingId: finding.id,
          severity: finding.severity,
          category: recorded.state as Category,
          evidence: recorded.evidence ?? `${pkg.dir}/findings.json: disposition recorded without evidence`,
          source: "record",
        });
        continue;
      }

      const sha = auto.get(finding.id.toUpperCase());
      if (sha !== undefined && commitExists(root, sha)) {
        rows.push({
          reviewId: pkg.reviewId,
          findingId: finding.id,
          severity: finding.severity,
          category: "acted-on",
          evidence: `${pkg.dir}/report.md: closed by ${sha}`,
          source: "report-closed-by",
        });
        continue;
      }
      if (sha !== undefined) {
        problems.push(`${key}: report names commit ${sha}, which this repository does not have`);
      }
      const row = byKey.get(key);
      if (row) {
        rows.push({
          reviewId: pkg.reviewId,
          findingId: finding.id,
          severity: finding.severity,
          category: row.category,
          evidence: row.evidence,
          source: "ledger",
        });
        continue;
      }
      rows.push({
        reviewId: pkg.reviewId,
        findingId: finding.id,
        severity: finding.severity,
        category: "unknown",
        evidence: "no disposition recorded in the review package, its flow, or the ledger",
        source: "none",
      });
    }
  }

  for (const key of byKey.keys()) {
    if (!seen.has(key)) {
      problems.push(`ledger: row for ${key}, which is not a finding on disk`);
    }
  }

  return { rows, problems };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function counts(rows: Classified[]): Record<Category, number> {
  const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0])) as Record<Category, number>;
  for (const row of rows) {
    out[row.category] += 1;
  }
  return out;
}

/**
 * The figure, or null when it has no denominator.
 *
 * Returned alongside the denominator's composition on purpose. A precision of
 * 100% built from a denominator with zero `dismissed-incorrect` is not a
 * measurement of accuracy — it is a restatement of the fact that nothing in
 * this corpus can record a finding as wrong. The caller prints both or neither.
 */
function precision(c: Record<Category, number>): number | null {
  const denominator = c["acted-on"] + c["dismissed-incorrect"];
  return denominator === 0 ? null : c["acted-on"] / denominator;
}

function main(): void {
  const argv = Bun.argv.slice(2);
  const optionValue = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const root = path.resolve(optionValue("--root") ?? DEFAULT_ROOT);
  const ledgerPath = path.resolve(
    optionValue("--ledger") ?? path.join(root, ".metaproject", "reviews", "dispositions.json"),
  );
  const asJson = argv.includes("--json");

  const packages = inventory(root);
  const ledger = loadLedger(ledgerPath);
  const { rows, problems } = classify(root, packages, ledger);
  const c = counts(rows);
  const p = precision(c);

  const dates = packages.map((pkg) => pkg.createdAt).sort();
  const summary = {
    packages: packages.length,
    packagesWithFindings: packages.filter((pkg) => pkg.findings.length > 0).length,
    findings: rows.length,
    dateRange: { first: dates[0] ?? null, last: dates[dates.length - 1] ?? null },
    counts: c,
    precision: p,
    denominator: c["acted-on"] + c["dismissed-incorrect"],
    ledgerPath: path.relative(root, ledgerPath),
    problems,
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, packages, rows }, null, 2));
  } else {
    console.log("# Review precision baseline\n");
    console.log(`packages:               ${summary.packages}`);
    console.log(`packages with findings: ${summary.packagesWithFindings}`);
    console.log(`findings:               ${summary.findings}`);
    console.log(`date range:             ${summary.dateRange.first} .. ${summary.dateRange.last}`);
    console.log("\n## Classification\n");
    for (const category of CATEGORIES) {
      console.log(`${category.padEnd(24)} ${String(c[category]).padStart(4)}`);
    }
    console.log("\n## By evidence source\n");
    // Every source the type declares, derived from it rather than listed again.
    // `record` was added to `Classified.source` and to the classifier and not to
    // this loop, so a run with one recorded disposition printed a classification
    // totalling 3 against a source table totalling 1 — a report whose two halves
    // disagree can be used to check nothing.
    for (const source of EVIDENCE_SOURCES) {
      console.log(`${source.padEnd(24)} ${String(rows.filter((r) => r.source === source).length).padStart(4)}`);
    }
    console.log("\n## Figure\n");
    if (p === null) {
      console.log("precision: NOT COMPUTABLE — the denominator is empty.");
    } else {
      console.log(`precision = acted-on / (acted-on + dismissed-incorrect)`);
      console.log(`          = ${c["acted-on"]} / ${summary.denominator} = ${(p * 100).toFixed(1)}%`);
      if (c["dismissed-incorrect"] === 0) {
        // The refusal, argued from what is true NOW. The original wording cited
        // three defects — no `disposition` property, a template `decisions.md`,
        // `classification` set from the ingest mode — and flow 202 fixed the
        // first two on this branch. A refusal that argues from facts that have
        // stopped being true reads as an unmaintained artifact, and AC1 is
        // satisfied by this refusal rather than by the figure above it.
        console.log(
          "\nNOT A BASELINE. `dismissed-incorrect` is 0, so the denominator equals\n" +
            "the numerator and this ratio is 100% whatever the reviewers actually got\n" +
            "right. The instrumentation that can record a wrong finding now exists —\n" +
            "`disposition` on the finding record, the `--refuted` ingest channel, and\n" +
            "`keryx review complete --finding <id> --disposition <state> --evidence <ref>`\n" +
            "— but nothing has been written through it for this corpus, and an\n" +
            "unwritten outcome reads as `unknown`, never as correct. The figure becomes\n" +
            "a baseline when rounds start closing with their dispositions recorded, not\n" +
            "before. See the flow 202 journal.",
        );
      }
    }
    if (problems.length > 0) {
      console.log("\n## Problems\n");
      for (const problem of problems) {
        console.log(`- ${problem}`);
      }
    }
  }

  process.exit(problems.length > 0 ? 1 : 0);
}

main();
