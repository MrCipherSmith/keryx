// T53 — false-positive sweep, re-measured independently, plus benign shapes of
// this reviewer's own.
//
// Row 4 of the T53 dispatch: the implementer measured 16684 files and reported
// the added findings falling only inside files that carry deliberate vectors.
// This probe re-measures the CURRENT tree rather than trusting that, and then
// adds a synthetic benign corpus the repository does not happen to contain —
// the shapes a documentation or tool-output payload realistically carries.
//
// Part A: sweep every text file in the checkout with the real detector and an
//         EMPTY allowlist, and classify each finding-bearing file as
//         "vector-carrying" (a security test, a flow probe/artifact, the
//         detector itself, an exfil fixture) or "benign". A finding in a benign
//         file is a false positive of this floor.
// Part B: 30 synthetic benign documents, each written the way a real README,
//         changelog, HTML template or tool response would be written. Any
//         finding here is reported with the shape that produced it.
//
// Read-only; nothing is written outside the out file.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { detectExfil } from "../../../../src/security/detect/exfil";

const ROOT = path.resolve(import.meta.dir, "../../../..");

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx",
  ".yml", ".yaml", ".html", ".htm", ".css", ".txt", ".toml", ".sh", ".log",
]);

const SKIP_DIRECTORIES = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo",
  "out", ".cache", ".bun",
]);

// A file whose PURPOSE is to carry attack vectors. Everything else is benign
// repository content and must not produce a finding.
function isVectorCarrying(relative: string): boolean {
  return (
    relative.includes("/flows/233-") ||
    relative.startsWith("src/security/detect/exfil") ||
    relative.startsWith("src/security/") && relative.endsWith(".test.ts") ||
    relative.startsWith("src/mcp/") && relative.endsWith(".test.ts") ||
    relative.startsWith("fixtures/exfil/") ||
    relative.includes("/data/gdctx/raw/") ||
    relative.includes("/data/security/")
  );
}

async function* walk(directory: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

interface FileResult {
  file: string;
  findings: number;
  policyIds: string[];
  vectorCarrying: boolean;
}

async function partA() {
  const results: FileResult[] = [];
  let filesScanned = 0;
  let unreadable = 0;
  let totalFindings = 0;
  const byPolicy: Record<string, number> = {};

  const started = Date.now();
  for await (const file of walk(ROOT)) {
    if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
    let info;
    try {
      info = await stat(file);
    } catch {
      unreadable += 1;
      continue;
    }
    if (info.size > 4 * 1024 * 1024) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      unreadable += 1;
      continue;
    }
    filesScanned += 1;
    const matches = detectExfil(content, []);
    if (matches.length === 0) continue;
    totalFindings += matches.length;
    for (const match of matches) byPolicy[match.policyId] = (byPolicy[match.policyId] ?? 0) + 1;
    const relative = path.relative(ROOT, file);
    results.push({
      file: relative,
      findings: matches.length,
      policyIds: [...new Set(matches.map((match) => match.policyId))],
      vectorCarrying: isVectorCarrying(relative),
    });
  }
  const elapsedMs = Date.now() - started;

  const benignFiles = results.filter((result) => !result.vectorCarrying);
  return {
    filesScanned,
    unreadable,
    totalFindings,
    filesWithFindings: results.length,
    byPolicy,
    elapsedMs,
    benignFilesWithFindings: benignFiles.length,
    benignFindings: benignFiles.reduce((sum, result) => sum + result.findings, 0),
    benignFiles,
    allFiles: results,
  };
}

// ---------------------------------------------------------------------------
// Part B — benign shapes of this reviewer's own.
// ---------------------------------------------------------------------------
const CDN = "cdn.example.org";

const BENIGN: Array<{ id: string; text: string }> = [
  { id: "readmeBadge", text: `# Project\n\n![build](https://img.shields.io/badge/build-passing-green)\n` },
  { id: "readmeBadgeAllowlisted", text: `![build](https://${CDN}/badge.svg)` },
  { id: "publicLink", text: "See the [documentation](https://docs.example.org/guide) for details." },
  { id: "relativeImage", text: `<img src="./assets/logo.png" alt="logo">` },
  { id: "relativeImageSrcset", text: `<img srcset="./a.png 1x, ./b.png 2x" src="./a.png">` },
  { id: "dataUriImage", text: `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">` },
  { id: "svgInline", text: `<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>` },
  { id: "htmlTemplateRelativeBase", text: `<!doctype html><base href="/app/"><img src="logo.png">` },
  { id: "changelogEntry", text: "## 0.2.80\n\n- fix: `<img>` handling in the exfil detector\n" },
  { id: "codeFenceImgExample", text: "Render an image:\n\n```html\n<img src=\"/static/logo.png\">\n```\n" },
  { id: "codeFenceRemoteImgExample", text: "Render a remote image:\n\n```html\n<img src=\"https://" + CDN + "/logo.png\">\n```\n" },
  { id: "codeFenceBaseExample", text: "Set a document base:\n\n```html\n<base href=\"https://" + CDN + "/docs/\">\n```\n" },
  { id: "htmlCommentImg", text: `<!-- <img src="https://${CDN}/logo.png"> -->` },
  { id: "scriptStringImg", text: `<script>const t = '<img src="https://${CDN}/logo.png">';</script>` },
  { id: "jsxSrcProp", text: `const El = () => <img src={logoUrl} alt="logo" />;` },
  { id: "tsSourceMentioningSrc", text: `// the src attribute is read from the name position only\nconst src = attribute.value;` },
  { id: "proseWithAngleBrackets", text: "Use `a > b` and `src=` in prose; neither is markup." },
  { id: "markdownRefDefRelative", text: "![logo][l]\n\n[l]: ./assets/logo.png\n" },
  { id: "markdownRefDefRemote", text: `![logo][l]\n\n[l]: https://${CDN}/logo.png\n` },
  { id: "mailtoLink", text: "[mail us](mailto:support@example.org)" },
  { id: "anchorRelative", text: `<a href="/docs/guide">Guide</a>` },
  { id: "anchorRemote", text: `<a href="https://${CDN}/docs/guide">Guide</a>` },
  { id: "openApiSnippet", text: `{"servers":[{"url":"https://api.example.org/v1"}]}` },
  { id: "packageJsonRepo", text: `{"repository":{"url":"https://github.example.org/a/b.git"}}` },
  { id: "imageTagInPre", text: `<pre><code>&lt;img src="https://${CDN}/x.png"&gt;</code></pre>` },
  { id: "imgurWord", text: "Uploaded to imgur; see <imgur> in the log." },
  { id: "basedWord", text: `<based href="https://${CDN}/x/"> is not a base element.` },
  { id: "sqlLike", text: "SELECT src FROM images WHERE width > 100;" },
  { id: "diffHunk", text: `-<img src="/old.png">\n+<img src="/new.png">` },
  { id: "cssUrlRelative", text: `.logo { background: url(/assets/logo.png); }` },
];

function partB() {
  return BENIGN.map((entry) => {
    const matches = detectExfil(entry.text, []);
    return {
      id: entry.id,
      findings: matches.length,
      policyIds: matches.map((match) => match.policyId),
      values: matches.map((match) => match.value),
    };
  });
}

const a = await partA();
const b = partB();
const bFlagged = b.filter((row) => row.findings > 0);

const summary = {
  partA: {
    filesScanned: a.filesScanned,
    unreadable: a.unreadable,
    totalFindings: a.totalFindings,
    filesWithFindings: a.filesWithFindings,
    byPolicy: a.byPolicy,
    benignFilesWithFindings: a.benignFilesWithFindings,
    benignFindings: a.benignFindings,
    elapsedMs: a.elapsedMs,
  },
  partB: {
    benignShapes: BENIGN.length,
    flagged: bFlagged.length,
    flaggedIds: bFlagged.map((row) => row.id),
  },
};

console.log(JSON.stringify(summary, null, 2));
console.log("--- benign repository files carrying a finding ---");
for (const file of a.benignFiles) {
  console.log(`${file.findings}  ${file.file}  ${JSON.stringify(file.policyIds)}`);
}
console.log("--- synthetic benign shapes that were flagged ---");
for (const row of bFlagged) {
  console.log(`${row.id}  ${JSON.stringify(row.policyIds)}  ${JSON.stringify(row.values)}`);
}

const out = process.argv[2];
if (out) await Bun.write(out, JSON.stringify({ summary, partA: a, partB: b }, null, 2));
