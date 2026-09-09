// T46 — the FALSE-POSITIVE side of the surface decision, measured.
//
// Part A sweeps this checkout and counts, per enumerated site, the files that
// carry that construct with an EXTERNAL destination — i.e. the benign instances
// an empty allowlist would newly flag if the site were covered. Files are
// attributed as VECTOR-CARRYING (this flow's probes and artifacts, the security
// detector and its tests, gdctx logs of those probes) or BENIGN.
//
// The dispatch is right that this repository is a poor guide, so Part B adds a
// synthetic benign corpus of the shapes a Keryx tool output realistically
// carries and this repository happens to lack — a quoted HTML page, a quoted
// CSS file, a README with an embedded video, a docs page with an iframe embed.
//
// METHOD NOTE, stated because it bounds the claim: this probe uses its OWN small
// start-tag walker (below), independent of the detector's, plus regexes for the
// CSS spellings. It measures INCIDENCE, not security — an approximation here
// costs a slightly wrong count, never a wrong verdict about a bypass. Every
// security verdict in this task comes from T46-surfaces.ts, which drives the
// real detector and the real boundaries.
//
// Read-only. Usage: bun T46-corpus.ts <out.json>
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

const EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".mdx",
  ".html", ".htm", ".css", ".scss", ".svg", ".vue", ".txt", ".yml", ".yaml",
  ".log",
]);
const SKIP_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next"]);

// A file whose PURPOSE is to carry attack vectors. Counting its hits as false
// positives would make every round of this floor look worse the more it tested.
function isVectorCarrying(relative: string): boolean {
  return (
    relative.startsWith(".metaproject/flows/233-") ||
    relative.startsWith("src/security/detect/") ||
    relative.startsWith("fixtures/exfil") ||
    relative.startsWith(".metaproject/data/gdctx/") ||
    relative.includes("/T4") === true && relative.includes("artifacts/") ||
    relative.startsWith("src/mcp/structural-redaction.test.ts") ||
    relative.startsWith("src/security/persistence-sinks.test.ts")
  );
}

// ------------------------------------------------------- a start-tag walker --
// Independent of the detector's. Deliberately simple: it is counting, not
// classifying.
interface Tag {
  name: string;
  attributes: Record<string, string>;
}

const TAG_OPEN = /<([a-zA-Z][a-zA-Z0-9:-]*)(?=[\s/>]|$)/g;

function isSpace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r" || character === "\f";
}

function walkTags(content: string): Tag[] {
  const tags: Tag[] = [];
  TAG_OPEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_OPEN.exec(content)) !== null) {
    const name = (match[1] ?? "").toLowerCase();
    let index = match.index + match[0].length;
    const attributes: Record<string, string> = {};
    while (index < content.length) {
      while (index < content.length && (isSpace(content[index] as string) || content[index] === "/")) index += 1;
      if (index >= content.length || content[index] === ">") { index += 1; break; }
      let nameEnd = index + 1;
      while (nameEnd < content.length) {
        const character = content[nameEnd] as string;
        if (isSpace(character) || character === "/" || character === ">" || character === "=") break;
        nameEnd += 1;
      }
      const attributeName = content.slice(index, nameEnd).toLowerCase();
      index = nameEnd;
      let cursor = index;
      while (cursor < content.length && isSpace(content[cursor] as string)) cursor += 1;
      if (cursor >= content.length || content[cursor] !== "=") { attributes[attributeName] = ""; continue; }
      cursor += 1;
      while (cursor < content.length && isSpace(content[cursor] as string)) cursor += 1;
      const quote = content[cursor];
      if (quote === '"' || quote === "'") {
        const valueStart = cursor + 1;
        const close = content.indexOf(quote, valueStart);
        const valueEnd = close === -1 ? content.length : close;
        attributes[attributeName] = content.slice(valueStart, valueEnd);
        index = close === -1 ? content.length : close + 1;
        continue;
      }
      const valueStart = cursor;
      let valueEnd = valueStart;
      while (valueEnd < content.length && !isSpace(content[valueEnd] as string) && content[valueEnd] !== ">") valueEnd += 1;
      attributes[attributeName] = content.slice(valueStart, valueEnd);
      index = valueEnd;
    }
    tags.push({ name, attributes });
    TAG_OPEN.lastIndex = Math.max(index, match.index + match[0].length);
  }
  return tags;
}

// An "external" destination for incidence purposes: it carries its own
// authority. Deliberately crude — see the method note.
const EXTERNAL = /^\s*(?:(?:https?|HTTPS?):)?\/\/[^/\s]/;
function isExternal(value: string): boolean {
  const trimmed = value.trim();
  return EXTERNAL.test(trimmed) || /^https?:[^/\s]/i.test(trimmed);
}
function firstSrcsetCandidate(value: string): string {
  return (value.split(",")[0] ?? "").trim().split(/\s+/)[0] ?? "";
}

// ------------------------------------------------------------- the site set --
type SiteId =
  | "C3.imgSrc" | "C4.imgSrcset" | "C5.baseHref"
  | "U01.inputImage" | "U02.metaRefresh" | "U03.videoPoster" | "U04.videoSrc"
  | "U05.audioSrc" | "U06.sourceSrc" | "U07.sourceSrcset" | "U08.trackSrc"
  | "U09.embedSrc" | "U10.objectData" | "U11.iframeSrc" | "U12.iframeSrcdoc"
  | "U13.scriptSrc" | "U14.linkHref" | "U15.linkImagesrcset" | "U16.background"
  | "U17.frameSrc" | "U18.styleAttrUrl" | "U19.styleBlockUrl" | "U20.cssImport"
  | "U21.fontFaceSrc" | "U22.imageSet" | "U23.svgImageHref" | "U24.svgFeImageHref"
  | "U25.svgScriptHref" | "U26.svgUseHref";

const BACKGROUND_ELEMENTS = new Set(["body", "table", "td", "th", "tr", "tbody", "thead", "tfoot"]);

function sitesInContent(content: string): Map<SiteId, number> {
  const hits = new Map<SiteId, number>();
  const bump = (id: SiteId, by = 1): void => hits.set(id, (hits.get(id) ?? 0) + by);

  for (const tag of walkTags(content)) {
    const a = tag.attributes;
    const has = (key: string): boolean => typeof a[key] === "string" && isExternal(a[key] as string);
    const hasSrcset = (key: string): boolean =>
      typeof a[key] === "string" && isExternal(firstSrcsetCandidate(a[key] as string));

    switch (tag.name) {
      case "img": case "image": {
        if (has("src")) bump("C3.imgSrc");
        if (hasSrcset("srcset")) bump("C4.imgSrcset");
        if (has("href") || has("xlink:href")) bump("U23.svgImageHref");
        break;
      }
      case "base": if (has("href")) bump("C5.baseHref"); break;
      case "input":
        if ((a["type"] ?? "").trim().toLowerCase() === "image" && has("src")) bump("U01.inputImage");
        break;
      case "meta":
        if ((a["http-equiv"] ?? "").trim().toLowerCase() === "refresh") {
          const url = /url\s*=\s*['"]?([^'";\s]+)/i.exec(a["content"] ?? "");
          if (url && isExternal(url[1] as string)) bump("U02.metaRefresh");
        }
        break;
      case "video":
        if (has("poster")) bump("U03.videoPoster");
        if (has("src")) bump("U04.videoSrc");
        break;
      case "audio": if (has("src")) bump("U05.audioSrc"); break;
      case "source":
        if (has("src")) bump("U06.sourceSrc");
        if (hasSrcset("srcset")) bump("U07.sourceSrcset");
        break;
      case "track": if (has("src")) bump("U08.trackSrc"); break;
      case "embed": if (has("src")) bump("U09.embedSrc"); break;
      case "object": if (has("data")) bump("U10.objectData"); break;
      case "iframe":
        if (has("src")) bump("U11.iframeSrc");
        if (typeof a["srcdoc"] === "string" && a["srcdoc"].length > 0) bump("U12.iframeSrcdoc");
        break;
      case "script":
        if (has("src")) bump("U13.scriptSrc");
        if (has("href") || has("xlink:href")) bump("U25.svgScriptHref");
        break;
      case "link":
        if (has("href")) bump("U14.linkHref");
        if (hasSrcset("imagesrcset")) bump("U15.linkImagesrcset");
        break;
      case "frame": if (has("src")) bump("U17.frameSrc"); break;
      case "feimage": if (has("href") || has("xlink:href")) bump("U24.svgFeImageHref"); break;
      case "use": if (has("href") || has("xlink:href")) bump("U26.svgUseHref"); break;
      default: break;
    }
    if (BACKGROUND_ELEMENTS.has(tag.name) && has("background")) bump("U16.background");
    if (typeof a["style"] === "string" && /url\(\s*['"]?\s*(?:https?:)?\/\//i.test(a["style"])) {
      bump("U18.styleAttrUrl");
    }
    if (typeof a["style"] === "string" && /image-set\(\s*['"]?\s*(?:https?:)?\/\//i.test(a["style"])) {
      bump("U22.imageSet");
    }
  }

  // CSS spellings: in <style> blocks, and in whole .css/.scss files (the probe
  // caller passes those in as content too).
  const styleBlocks = [...content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? "");
  const cssBodies = styleBlocks.length > 0 ? styleBlocks : [];
  for (const css of cssBodies) {
    for (const _ of css.matchAll(/url\(\s*['"]?\s*(?:https?:)?\/\//gi)) bump("U19.styleBlockUrl");
    for (const _ of css.matchAll(/@import\s+(?:url\(\s*)?['"]?\s*(?:https?:)?\/\//gi)) bump("U20.cssImport");
    for (const _ of css.matchAll(/@font-face[\s\S]{0,400}?src\s*:[^;}]*url\(\s*['"]?\s*(?:https?:)?\/\//gi)) bump("U21.fontFaceSrc");
    for (const _ of css.matchAll(/image-set\(\s*['"]?\s*(?:https?:)?\/\//gi)) bump("U22.imageSet");
  }
  return hits;
}

function cssFileSites(css: string): Map<SiteId, number> {
  const hits = new Map<SiteId, number>();
  const bump = (id: SiteId): void => hits.set(id, (hits.get(id) ?? 0) + 1);
  for (const _ of css.matchAll(/url\(\s*['"]?\s*(?:https?:)?\/\//gi)) bump("U19.styleBlockUrl");
  for (const _ of css.matchAll(/@import\s+(?:url\(\s*)?['"]?\s*(?:https?:)?\/\//gi)) bump("U20.cssImport");
  for (const _ of css.matchAll(/@font-face[\s\S]{0,400}?src\s*:[^;}]*url\(\s*['"]?\s*(?:https?:)?\/\//gi)) bump("U21.fontFaceSrc");
  for (const _ of css.matchAll(/image-set\(\s*['"]?\s*(?:https?:)?\/\//gi)) bump("U22.imageSet");
  return hits;
}

// ---------------------------------------------------------------- Part A: sweep --
const perSite = new Map<SiteId, { hits: number; benignFiles: Set<string>; vectorFiles: Set<string> }>();
function record(site: SiteId, count: number, relative: string): void {
  let entry = perSite.get(site);
  if (!entry) { entry = { hits: 0, benignFiles: new Set(), vectorFiles: new Set() }; perSite.set(site, entry); }
  entry.hits += count;
  (isVectorCarrying(relative) ? entry.vectorFiles : entry.benignFiles).add(relative);
}

let filesScanned = 0;
let filesUnreadable = 0;

async function sweep(directory: string): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await sweep(full);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    let content: string;
    try {
      const info = await stat(full);
      if (info.size > 4_000_000) continue;
      content = await readFile(full, "utf8");
    } catch { filesUnreadable += 1; continue; }
    filesScanned += 1;
    const relative = path.relative(ROOT, full);
    const extension = path.extname(entry.name).toLowerCase();
    const hits =
      extension === ".css" || extension === ".scss"
        ? cssFileSites(content)
        : sitesInContent(content);
    for (const [site, count] of hits) record(site, count, relative);
  }
}

const started = Date.now();
await sweep(ROOT);
const elapsedMs = Date.now() - started;

const partA = Object.fromEntries(
  [...perSite.entries()]
    .sort((a, b) => b[1].benignFiles.size - a[1].benignFiles.size)
    .map(([site, entry]) => [
      site,
      {
        hits: entry.hits,
        benignFileCount: entry.benignFiles.size,
        vectorFileCount: entry.vectorFiles.size,
        benignFiles: [...entry.benignFiles].sort().slice(0, 12),
      },
    ]),
);

// ------------------------------------------------- Part B: synthetic benign --
// The shapes a Keryx tool output realistically carries and this checkout lacks.
const syntheticBenign: Array<{ id: string; carrier: string; text: string }> = [
  { id: "quotedHtmlPage", carrier: "ctx read of an index.html", text:
    `<!doctype html>\n<html><head>\n<link rel="stylesheet" href="https://cdn.example.org/site.css">\n` +
    `<link rel="icon" href="https://cdn.example.org/favicon.ico">\n` +
    `<script src="https://cdn.example.org/app.js"></script>\n</head>\n<body>\n` +
    `<img src="https://cdn.example.org/logo.png">\n</body></html>\n` },
  { id: "quotedCssFile", carrier: "ctx read of a site.css", text:
    `@import url("https://fonts.example.org/reset.css");\n` +
    `@font-face{font-family:Inter;src:url("https://fonts.example.org/inter.woff2")}\n` +
    `.hero{background-image:url(https://cdn.example.org/hero.jpg)}\n` },
  { id: "readmeWithVideo", carrier: "a README with an embedded demo", text:
    `# Demo\n\n<video src="https://media.example.org/demo.mp4" controls poster="https://media.example.org/cover.png"></video>\n` },
  { id: "docsPageWithIframe", carrier: "a docs page embedding a player", text:
    `## Walkthrough\n\n<iframe src="https://player.example.org/embed/abc" width="560"></iframe>\n` },
  { id: "readmeBadges", carrier: "a README badge row (this repo has these)", text:
    `[![build](https://img.example.org/badge.svg)](https://ci.example.org/x)\n` },
  { id: "picturePolyfill", carrier: "a responsive-image snippet in docs", text:
    `<picture><source srcset="https://cdn.example.org/a.avif" type="image/avif"><img src="https://cdn.example.org/a.png"></picture>\n` },
  { id: "audioSample", carrier: "docs with an audio sample", text:
    `<audio src="https://media.example.org/sample.mp3" controls></audio>\n` },
  { id: "svgSpriteUse", carrier: "an inline SVG icon sprite", text:
    `<svg><use href="/assets/sprite.svg#icon-check"/></svg>\n` },
  { id: "svgInlineImage", carrier: "an inline SVG embedding a raster", text:
    `<svg><image href="https://cdn.example.org/photo.png" width="10" height="10"/></svg>\n` },
  { id: "metaRefreshRedirectPage", carrier: "a quoted redirect stub page", text:
    `<meta http-equiv="refresh" content="0;url=https://docs.example.org/new-home">\n` },
  { id: "imageSubmitButton", carrier: "a quoted legacy form", text:
    `<form action="/search"><input type="image" src="https://cdn.example.org/go.png" alt="go"></form>\n` },
  { id: "legacyTableBackground", carrier: "a quoted legacy HTML table", text:
    `<table><tr><td background="https://cdn.example.org/cell.png">x</td></tr></table>\n` },
  { id: "objectPdfEmbed", carrier: "docs embedding a PDF", text:
    `<object data="https://docs.example.org/spec.pdf" type="application/pdf"></object>\n` },
  { id: "trackCaptions", carrier: "docs with a captioned video", text:
    `<video controls><source src="https://media.example.org/d.mp4"><track default src="https://media.example.org/d.vtt" kind="captions"></video>\n` },
  { id: "relativeOnlyPage", carrier: "a fully-relative page (must stay clean everywhere)", text:
    `<link rel="stylesheet" href="/site.css"><script src="/app.js"></script><img src="/logo.png">\n` +
    `<video poster="/cover.png" src="/demo.mp4"></video><input type="image" src="/go.png">\n` +
    `<meta http-equiv="refresh" content="0;url=/next">\n<svg><image href="/photo.png"/></svg>\n` },
];

const partB = syntheticBenign.map((shape) => ({
  id: shape.id,
  carrier: shape.carrier,
  sites: [...sitesInContent(shape.text).keys()].sort(),
}));

const summary = {
  filesScanned,
  filesUnreadable,
  elapsedMs,
  sitesWithAnyBenignFile: [...perSite.entries()]
    .filter(([, entry]) => entry.benignFiles.size > 0)
    .map(([site, entry]) => `${site}:${entry.benignFiles.size}`)
    .sort(),
  sitesWithNoBenignFile: [...perSite.entries()]
    .filter(([, entry]) => entry.benignFiles.size === 0)
    .map(([site]) => site)
    .sort(),
};

console.log("=== PART A: benign-file count per site (empty allowlist would flag these) ===");
for (const [site, entry] of Object.entries(partA)) {
  const e = entry as { hits: number; benignFileCount: number; vectorFileCount: number; benignFiles: string[] };
  console.log(
    `${site.padEnd(24)} hits=${String(e.hits).padStart(5)} benignFiles=${String(e.benignFileCount).padStart(4)} vectorFiles=${String(e.vectorFileCount).padStart(3)}  ${e.benignFiles.slice(0, 4).join(", ")}`,
  );
}
console.log("\n=== PART B: synthetic benign carriers ===");
for (const shape of partB) console.log(`${shape.id.padEnd(26)} ${shape.sites.join(", ") || "(none)"}`);
console.log("\n" + JSON.stringify(summary, null, 2));

const out = process.argv[2];
if (out) await Bun.write(out, JSON.stringify({ summary, partA, partB }, null, 2));
