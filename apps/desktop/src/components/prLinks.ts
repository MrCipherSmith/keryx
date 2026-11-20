import { isGithubRepository } from "../lib/githubPr";

export interface PrLinks {
  repository?: string;
  openExternal: (url: string) => void;
  openInternal?: (url: string) => void;
}

const POSSIBLE_REFERENCE = /PR(?:[ \t\u00a0]|&nbsp;)+#/i;
const REFERENCE = /(?<![\p{L}\p{N}_])PR[ \t\u00a0]+#([1-9]\d{0,11})(?![\p{L}\p{N}_])/giu;

/** Link plain references only after sanitizing the Markdown; don't touch code or existing anchors. */
export function decoratePrReferences(html: string, repository: string | undefined): string {
  if (!repository || !isGithubRepository(repository) || !POSSIBLE_REFERENCE.test(html)) return html;
  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  let changed = false;
  for (const node of nodes) {
    if (node.parentElement?.closest("a, pre, code")) continue;
    let end = 0;
    const replacement = document.createDocumentFragment();
    for (const match of node.data.matchAll(REFERENCE)) {
      replacement.append(node.data.slice(end, match.index));
      const link = document.createElement("a");
      link.href = `https://github.com/${repository}/pull/${match[1]}`;
      link.textContent = match[0];
      link.title = "Open pull request in browser · right-click for options";
      replacement.append(link);
      end = match.index + match[0].length;
    }
    if (end) {
      node.replaceWith(replacement, node.data.slice(end));
      changed = true;
    }
  }
  return changed ? template.innerHTML : html;
}
