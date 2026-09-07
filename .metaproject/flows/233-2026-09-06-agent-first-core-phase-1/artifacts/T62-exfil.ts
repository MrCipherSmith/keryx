// T62 probe — row 6 and the judgement call. Attacks T63's new
// "suppress a <base href> finding inside a CLOSED inert span" rule.
//
// The question the dispatch asks: can the suppression be abused by an attacker
// who writes a construct that looks CLOSED to this code but NOT to a renderer?
//
// Two renderer models are relevant, and this file's own header commits to the
// second:
//   (A) a raw HTML tokenizer — adjudicated here by Bun's `HTMLRewriter`
//       (lol-html), an independent, spec-derived implementation;
//   (B) a markdown client with raw-HTML passthrough — CommonMark decides which
//       bytes reach (A) at all.
//
// Cases marked `oracle: lol-html` are decided by (A) and need no reasoning.
// Cases marked `oracle: commonmark-rule` are decided by (B) and cite the rule.
//
// Read-only.
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const out = (row: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(row)}\n`);

const ATTACKER = "attacker.invalid";
const CDN = "cdn.example.org";
const RENDERER_BASES = [
  "https://client.example.org/chat/thread",
  "http://client.example.org/chat/thread",
  "app://client.example.org/index.html",
];

// --- oracle (A): does a spec-derived HTML tokenizer see a LIVE <base href>? ---
async function liveBaseHrefPerHtmlTokenizer(html: string): Promise<string | null> {
  let first: string | null = null;
  await new HTMLRewriter()
    .on("base", {
      element(element: { getAttribute(name: string): string | null }) {
        const href = element.getAttribute("href");
        if (first === null && href !== null) first = href;
      },
    })
    .transform(new Response(html))
    .text();
  return first;
}

function baseReachesAttacker(href: string | null): boolean {
  if (href === null) return false;
  for (const rendererBase of RENDERER_BASES) {
    try {
      const resolved = new URL(href, rendererBase);
      if (
        (resolved.protocol === "http:" || resolved.protocol === "https:") &&
        resolved.hostname.toLowerCase() === ATTACKER
      ) {
        return true;
      }
    } catch {
      /* unresolvable */
    }
  }
  return false;
}

type Oracle = "lol-html" | "commonmark-rule";

interface Case {
  id: string;
  kind: "hostile" | "benign";
  oracle: Oracle;
  // For `commonmark-rule` cases: the rule that makes the base live/inert, and
  // whether it IS live under model (B).
  rule?: string;
  liveUnderCommonMark?: boolean;
  html: string;
}

const CASES: Case[] = [
  // ---- controls that must NOT move: T63's own two suppression targets ------
  {
    id: "c01.cdnBaseInFence",
    kind: "benign",
    oracle: "commonmark-rule",
    rule: "a closed fenced code block is literal text",
    liveUnderCommonMark: false,
    html: "Set the document base:\n\n```html\n<base href=\"https://" + CDN + "/docs/\">\n```\n",
  },
  {
    id: "c02.cdnBaseInComment",
    kind: "benign",
    oracle: "lol-html",
    html: `<!-- <base href="https://${CDN}/docs/"> -->`,
  },
  // ---- controls that must STILL fire: unterminated spans -------------------
  {
    id: "c03.unterminatedComment",
    kind: "hostile",
    oracle: "lol-html",
    html: `<!-- oops <base href="https://${ATTACKER}/x/"><img src="p.png">`,
  },
  {
    id: "c04.unterminatedFence",
    kind: "hostile",
    oracle: "commonmark-rule",
    rule: "an unclosed fence runs to the end of the document",
    liveUnderCommonMark: false,
    html: "```html\n<base href=\"https://" + ATTACKER + "/x/\">\n",
  },
  {
    id: "c05.plainHostileBase",
    kind: "hostile",
    oracle: "lol-html",
    html: `<base href="https://${ATTACKER}/x/"><img src="p.png">`,
  },

  // ---- ATTACKS on the comment half ---------------------------------------
  // `<!-->` is an ABRUPT-CLOSING-OF-EMPTY-COMMENT: the HTML tokenizer emits the
  // comment at the `>` immediately after `<!--`, so everything after it is live
  // markup. The detector's `/<!--[\s\S]*?-->/` instead runs to the LATER `-->`.
  {
    id: "x01.abruptEmptyComment",
    kind: "hostile",
    oracle: "lol-html",
    html: `<!--><base href="https://${ATTACKER}/x/"><img src="p.png">-->`,
  },
  {
    id: "x02.abruptDashComment",
    kind: "hostile",
    oracle: "lol-html",
    html: `<!---><base href="https://${ATTACKER}/x/"><img src="p.png">-->`,
  },
  // `--!>` also closes a comment (comment-end-bang state).
  {
    id: "x03.commentEndBang",
    kind: "hostile",
    oracle: "lol-html",
    html: `<!-- note --!><base href="https://${ATTACKER}/x/"><img src="p.png"> -->`,
  },
  // A comment closed normally, followed by a live base, followed by a SECOND
  // `-->` with no opener. The greedy-to-first `-->` pairing is per-match, so
  // this one is the control that the simple case is handled.
  {
    id: "x04.commentThenBaseThenStrayClose",
    kind: "hostile",
    oracle: "lol-html",
    html: `<!-- a --><base href="https://${ATTACKER}/x/"><img src="p.png"> -->`,
  },

  // ---- ATTACKS on the fence half (model B) --------------------------------
  // A `<!--` that lives INSIDE a closed fenced code block is literal text to a
  // markdown renderer, so it never opens a comment; the later bare `-->` is
  // also text. The `<base>` between them is an HTML block (CommonMark's
  // type-6 tag list contains `base`) and is passed through live. The detector
  // pairs the two literal delimiters into a comment span and suppresses it.
  {
    id: "x05.commentDelimitersQuotedInFences",
    kind: "hostile",
    oracle: "commonmark-rule",
    rule: "CommonMark: fenced code content is literal; `base` is an HTML-block tag",
    liveUnderCommonMark: true,
    html:
      "```\n<!--\n```\n\n<base href=\"https://" + ATTACKER + "/x/\">\n\n```\n-->\n```\n",
  },
  // The same trick with inline code spans — the shape a page documenting HTML
  // comments actually takes.
  {
    id: "x06.commentDelimitersInCodeSpans",
    kind: "hostile",
    oracle: "commonmark-rule",
    rule: "CommonMark: inline code spans are literal text",
    liveUnderCommonMark: true,
    html:
      "A comment starts with `<!--`.\n\n<base href=\"https://" + ATTACKER + "/x/\">\n\nand ends with `-->`.\n",
  },
  // A fence marker quoted INSIDE an HTML comment. To a renderer the comment is
  // lines 1-3 and the `<base>` after it is live. To the detector the two
  // literal fence lines pair into a code-block span that swallows the base.
  {
    id: "x07.fenceMarkersQuotedInsideAComment",
    kind: "hostile",
    oracle: "commonmark-rule",
    rule: "CommonMark: an HTML comment block ends at the line containing `-->`",
    liveUnderCommonMark: true,
    html:
      "<!--\n```\n-->\n\n<base href=\"https://" + ATTACKER + "/x/\">\n\n```\n",
  },
  // Two fences whose pairing differs: an opening fence of 3 backticks, a
  // closing fence of 3 backticks, then a THIRD fence line. The detector pairs
  // 1-2 and then holds 3 open; a renderer does the same. Control.
  {
    id: "x08.threeFenceLines",
    kind: "hostile",
    oracle: "commonmark-rule",
    rule: "CommonMark: third fence opens an unclosed block",
    liveUnderCommonMark: true,
    html: "```\nx\n```\n\n<base href=\"https://" + ATTACKER + "/x/\">\n\n```\n",
  },
];

let bypasses = 0;
for (const testCase of CASES) {
  const matches = detectExfil(testCase.html, []);
  const baseFindings = matches.filter((m) => m.policyId === "egress.html-base-href-exfil");
  const redacted = applyRedaction(testCase.html, matches);

  const liveBefore = await liveBaseHrefPerHtmlTokenizer(testCase.html);
  const liveAfter = await liveBaseHrefPerHtmlTokenizer(redacted);

  const rendererSeesLiveAttackerBase =
    testCase.oracle === "lol-html"
      ? baseReachesAttacker(liveBefore)
      : (testCase.liveUnderCommonMark ?? false) && testCase.html.includes(ATTACKER);

  const stillReachesAfter =
    testCase.oracle === "lol-html"
      ? baseReachesAttacker(liveAfter)
      : rendererSeesLiveAttackerBase && redacted.includes(`https://${ATTACKER}`);

  const bypass = testCase.kind === "hostile" && rendererSeesLiveAttackerBase && stillReachesAfter;
  if (bypass) bypasses += 1;

  out({
    id: testCase.id,
    kind: testCase.kind,
    oracle: testCase.oracle,
    rule: testCase.rule ?? null,
    baseFindings: baseFindings.length,
    allPolicyIds: matches.map((m) => m.policyId),
    lolHtmlLiveBaseHref: liveBefore,
    rendererSeesLiveAttackerBase,
    attackerHostStillInRedactedOutput: redacted.includes(ATTACKER),
    stillReachesAfterRedaction: stillReachesAfter,
    BYPASS: bypass,
    redacted,
  });
}

out({ label: "SUMMARY", cases: CASES.length, bypasses });
