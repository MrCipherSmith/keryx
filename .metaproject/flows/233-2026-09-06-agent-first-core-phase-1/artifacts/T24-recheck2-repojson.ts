// T24 recheck 2 — re-measure the false-rejection blast radius over the
// repository's own JSON files, and additionally measure the NEW outcome the
// second approach introduces: byte-changing canonical normalization of a file
// that carries nothing sensitive. Read-only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { validateSerializedContentForTransport } from "../../../../src/security/output-validation";

const ROOT = process.argv[3] ?? process.cwd();
const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".metaproject") {
      if (SKIP.has(entry.name)) continue;
    }
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".json")) out.push(full);
  }
}

const files: string[] = [];
walk(ROOT, files);

const rejected: Array<{ file: string; reasons: string[] }> = [];
const normalized: Array<{ file: string; reasons: string[]; bytesBefore: number; bytesAfter: number }> = [];
const redactedForContent: Array<{ file: string; reasons: string[] }> = [];
let preserved = 0;
let unparseable = 0;

for (const file of files) {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  try {
    JSON.parse(content);
  } catch {
    unparseable += 1;
    continue;
  }
  const r = validateSerializedContentForTransport(content);
  const rel = path.relative(ROOT, file);
  if (!r.ok) {
    rejected.push({ file: rel, reasons: r.redaction.reasons });
    continue;
  }
  if (r.redaction.state === "none") {
    preserved += 1;
    continue;
  }
  if (r.redaction.reasons.length === 1 && r.redaction.reasons[0] === "serialized-content-normalized") {
    normalized.push({
      file: rel,
      reasons: r.redaction.reasons,
      bytesBefore: content.length,
      bytesAfter: r.text.length,
    });
  } else {
    redactedForContent.push({ file: rel, reasons: r.redaction.reasons });
  }
}

const summary = {
  root: ROOT,
  filesScanned: files.length,
  unparseable,
  bytePreserved: preserved,
  rejected: rejected.length,
  normalizedOnly: normalized.length,
  redactedForContent: redactedForContent.length,
};

const { writeFileSync } = await import("node:fs");
const out = process.argv[2] ?? "/tmp/T24-recheck2-repojson.json";
writeFileSync(
  out,
  JSON.stringify({ summary, rejected, normalized, redactedForContent }, null, 2),
);
console.log(JSON.stringify(summary));
console.log(`rejected: ${rejected.length ? rejected.map((r) => `${r.file} [${r.reasons.join("|")}]`).join(", ") : "(none)"}`);
console.log(
  `normalized-only (bytes rewritten, nothing sensitive): ${
    normalized.length ? normalized.slice(0, 25).map((r) => r.file).join(", ") : "(none)"
  }`,
);
console.log(
  `redacted-for-content: ${
    redactedForContent.length
      ? redactedForContent.slice(0, 25).map((r) => `${r.file} [${r.reasons.join("|")}]`).join(", ")
      : "(none)"
  }`,
);
console.log(`wrote ${out}`);
