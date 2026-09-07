// T52 — false-positive sweep of the auto-fetch detector over the repository's own
// content. "Do not close bypasses by widening the net until benign text trips it"
// is only checkable against real text, so this runs the detector over every text
// file in the checkout and reports what it flags, per policy id and per file.
//
// Run it twice — once against the current detector and once against a copy of an
// older revision — and diff the two reports: a repair must not add a finding on
// the repository's own content, and it may legitimately REMOVE one (a false
// positive it closes).
//
// Read-only: nothing is written except the report. No network, no model call.
//
// Usage: bun T52-corpus.ts <out.json> [detectorModulePath]

import { Glob } from "bun";
import path from "node:path";
import type { DetectorMatch } from "../../../../src/security/types";

const REPO = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

const DEFAULT_DETECTOR = path.join(REPO, "src/security/detect/exfil.ts");
const detectorPath = process.argv[3] ?? DEFAULT_DETECTOR;
const { detectExfil } = (await import(detectorPath)) as {
  detectExfil: (content: string, allowlist?: string[]) => DetectorMatch[];
};

const EXTENSIONS = new Set([
  ".md",
  ".mdc",
  ".markdown",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".html",
  ".htm",
  ".css",
  ".yml",
  ".yaml",
  ".toml",
]);
const SKIP_DIRECTORIES = [
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "coverage/",
  ".next/",
  ".turbo/",
];
const MAX_BYTES = 2_000_000;

const glob = new Glob("**/*");
const files: string[] = [];
for await (const relative of glob.scan({ cwd: REPO, onlyFiles: true, dot: true })) {
  if (SKIP_DIRECTORIES.some((directory) => relative.includes(directory))) continue;
  if (!EXTENSIONS.has(path.extname(relative).toLowerCase())) continue;
  files.push(relative);
}
files.sort();

type Finding = { file: string; policyId: string; value: string };

const findings: Finding[] = [];
const perPolicy: Record<string, number> = {};
let scanned = 0;
let skippedTooLarge = 0;
let unreadable = 0;

for (const relative of files) {
  const handle = Bun.file(path.join(REPO, relative));
  if (handle.size > MAX_BYTES) {
    skippedTooLarge += 1;
    continue;
  }
  let text: string;
  try {
    text = await handle.text();
  } catch {
    unreadable += 1;
    continue;
  }
  scanned += 1;
  for (const match of detectExfil(text, [])) {
    perPolicy[match.policyId] = (perPolicy[match.policyId] ?? 0) + 1;
    findings.push({
      file: relative,
      policyId: match.policyId,
      value: match.value.length > 160 ? `${match.value.slice(0, 160)}…` : match.value,
    });
  }
}

const report = {
  detector: detectorPath,
  filesScanned: scanned,
  filesSkippedTooLarge: skippedTooLarge,
  filesUnreadable: unreadable,
  totalFindings: findings.length,
  filesWithFindings: new Set(findings.map((f) => f.file)).size,
  perPolicy,
  findings,
};

const out = process.argv[2];
if (out) await Bun.write(out, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      detector: report.detector,
      filesScanned: report.filesScanned,
      filesSkippedTooLarge: report.filesSkippedTooLarge,
      filesUnreadable: report.filesUnreadable,
      totalFindings: report.totalFindings,
      filesWithFindings: report.filesWithFindings,
      perPolicy: report.perPolicy,
    },
    null,
    2,
  ),
);
