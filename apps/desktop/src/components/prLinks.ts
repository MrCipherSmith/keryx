import { isGithubRepository } from "../lib/githubPr";

export interface PrLinks {
  repository?: string;
  openExternal: (url: string) => void;
  openInternal?: (url: string) => void;
}

// Cheap pre-check on the raw HTML: tags may sit between "PR" and "#" (`<strong>PR</strong> #1`).
const TAG_GAP = 64;
const POSSIBLE_REFERENCE = new RegExp(`\\bPR[^#]{0,${TAG_GAP}}#[1-9]`, "i");
const REFERENCE = /(?<![\p{L}\p{N}_])PR[ \t\r\n\u00a0]+#([1-9]\d{0,11})(?![\p{L}\p{N}_])/giu;
/** Elements that end a run of inline text (a reference never spans them); a/pre/code are also never linked into. */
const BREAKS = /^(?:A|ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|BUTTON|CODE|DD|DETAILS|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|HR|IMG|INPUT|LI|MAIN|MATH|NAV|OL|P|PRE|SECTION|SUMMARY|SVG|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

function blockOf(node: Node): Element | null {
  for (let e = node.parentElement; e; e = e.parentElement) if (BREAKS.test(e.tagName)) return e;
  return null;
}

/** Text nodes grouped into runs that read as one line of text: same block, no break element between, never inside a/pre/code. */
function textRuns(root: DocumentFragment): Text[][] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  const runs: Text[][] = [];
  let run: Text[] = [];
  let block: Element | null = null;
  const flush = () => {
    if (run.length) runs.push(run);
    run = [];
  };
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (BREAKS.test((node as Element).tagName)) flush();
      continue;
    }
    if (node.parentElement?.closest("a, pre, code")) continue;
    const b = blockOf(node);
    if (run.length && b !== block) flush();
    block = b;
    run.push(node as Text);
  }
  flush();
  return runs;
}

interface Piece {
  from: number;
  to: number;
  href: string;
  /** True for the first anchor of a reference; later anchors (split across inline nodes) are hidden from tab order and AT. */
  primary: boolean;
  /** The whole matched reference, whitespace collapsed (the accessible name of the primary anchor of a split reference). */
  label: string;
}

/**
 * Match references on the run's concatenated text and map each one onto the text-node pieces it covers
 * (one piece when it sits in a single node, one per node when inline elements split it).
 * Matches are ordered and disjoint, so a single forward node cursor suffices.
 */
function referencePieces(run: Text[], repository: string): Map<Text, Piece[]> {
  const starts: number[] = [];
  let text = "";
  for (const n of run) {
    starts.push(text.length);
    text += n.data;
  }
  const pieces = new Map<Text, Piece[]>();
  let cursor = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    const href = `https://github.com/${repository}/pull/${match[1]}`;
    while (cursor < run.length && (starts[cursor] ?? 0) + (run[cursor]?.data.length ?? 0) <= from) cursor++;
    let primary = true;
    for (let i = cursor; i < run.length; i++) {
      const n = run[i];
      const s = starts[i] ?? 0;
      if (!n || s >= to) break;
      const a = Math.max(from, s);
      const b = Math.min(to, s + n.data.length);
      if (a >= b) continue;
      const list = pieces.get(n) ?? [];
      list.push({ from: a - s, to: b - s, href, primary, label: match[0].replace(/\s+/g, " ") });
      pieces.set(n, list);
      primary = false;
    }
  }
  return pieces;
}

/** Build the replacement for one text node: plain text interleaved with anchors for its pieces. */
function linkPieces(node: Text, pieces: Piece[]): DocumentFragment {
  let end = 0;
  const replacement = document.createDocumentFragment();
  for (const p of pieces) {
    if (p.from > end) replacement.append(node.data.slice(end, p.from));
    const link = document.createElement("a");
    link.href = p.href;
    link.textContent = node.data.slice(p.from, p.to);
    link.title = "Open pull request in browser · right-click for options";
    if (p.primary && p.label !== link.textContent) link.setAttribute("aria-label", p.label);
    if (!p.primary) {
      link.setAttribute("tabindex", "-1");
      link.setAttribute("aria-hidden", "true");
    }
    replacement.append(link);
    end = p.to;
  }
  if (end < node.data.length) replacement.append(node.data.slice(end));
  return replacement;
}

/** Link plain references only after sanitizing the Markdown; don't touch code or existing anchors. */
export function decoratePrReferences(html: string, repository: string | undefined): string {
  if (!repository || !isGithubRepository(repository) || !POSSIBLE_REFERENCE.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;
  for (const run of textRuns(template.content)) {
    for (const [node, pieces] of referencePieces(run, repository)) {
      node.replaceWith(linkPieces(node, pieces));
      changed = true;
    }
  }
  return changed ? template.innerHTML : html;
}
