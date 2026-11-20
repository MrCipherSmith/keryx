import { isGithubRepository } from "../lib/githubPr";

export interface PrLinks {
  repository?: string;
  openExternal: (url: string) => void;
  openInternal?: (url: string) => void;
}

// Cheap pre-check on the raw HTML: tags may sit between "PR" and "#" (`<strong>PR</strong> #1`).
const POSSIBLE_REFERENCE = /PR[^#]{0,64}#[1-9]/i;
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

/** Link plain references only after sanitizing the Markdown; don't touch code or existing anchors. */
export function decoratePrReferences(html: string, repository: string | undefined): string {
  if (!repository || !isGithubRepository(repository) || !POSSIBLE_REFERENCE.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;
  for (const run of textRuns(template.content)) {
    // Match on the run's concatenated text, then link each text-node piece the match covers
    // (one anchor when it sits in a single node, one per node when inline elements split it).
    const starts: number[] = [];
    let text = "";
    for (const n of run) {
      starts.push(text.length);
      text += n.data;
    }
    const pieces = new Map<Text, Array<{ from: number; to: number; href: string }>>();
    for (const match of text.matchAll(REFERENCE)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      const href = `https://github.com/${repository}/pull/${match[1]}`;
      run.forEach((n, i) => {
        const s = starts[i] ?? 0;
        const a = Math.max(from, s);
        const b = Math.min(to, s + n.data.length);
        if (a >= b) return;
        const list = pieces.get(n) ?? [];
        list.push({ from: a - s, to: b - s, href });
        pieces.set(n, list);
      });
    }
    for (const [node, list] of pieces) {
      let end = 0;
      const replacement = document.createDocumentFragment();
      for (const p of list) {
        if (p.from > end) replacement.append(node.data.slice(end, p.from));
        const link = document.createElement("a");
        link.href = p.href;
        link.textContent = node.data.slice(p.from, p.to);
        link.title = "Open pull request in browser · right-click for options";
        replacement.append(link);
        end = p.to;
      }
      if (end < node.data.length) replacement.append(node.data.slice(end));
      node.replaceWith(replacement);
      changed = true;
    }
  }
  return changed ? template.innerHTML : html;
}
