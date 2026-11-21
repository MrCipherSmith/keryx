import { memo, useMemo } from "react";
import type { IssueRef } from "../../../../src/integrations/issues-contract";
import { renderRepositoryMarkdown } from "../components/Markdown";

export function webUrl(raw: string | null, base?: string) {
  if (!raw) return null;
  try {
    const url = new URL(raw, base);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export const IssueMarkdown = memo(function IssueMarkdown({ body, issue }: { body: string; issue: IssueRef }) {
  const markup = useMemo(() => {
    const template = document.createElement("template");
    template.innerHTML = renderRepositoryMarkdown(body);
    const repo = "https://" + issue.host + "/" + issue.owner + "/" + issue.repo;
    for (const anchor of template.content.querySelectorAll("a")) {
      const raw = anchor.getAttribute("href");
      const url = webUrl(raw, raw?.startsWith("#") ? issue.url : repo + "/blob/HEAD/");
      if (!url) anchor.replaceWith(...anchor.childNodes);
      else { anchor.href = url; anchor.rel = "noreferrer"; }
    }
    const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_TEXT);
    const text: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest("a,code,pre") && /(?:^|\s)#\d+\b/.test(node.textContent ?? "")) text.push(node);
    }
    for (const node of text) {
      const content = node.textContent ?? "";
      const fragment = document.createDocumentFragment();
      let start = 0;
      for (const match of content.matchAll(/(^|\s)#(\d+)\b/g)) {
        fragment.append(content.slice(start, match.index) + match[1]);
        const link = document.createElement("a");
        link.href = repo + "/issues/" + match[2]; link.textContent = "#" + match[2]; link.rel = "noreferrer";
        fragment.append(link); start = match.index + match[0].length;
      }
      fragment.append(content.slice(start)); node.parentNode?.replaceChild(fragment, node);
    }
    return { __html: template.innerHTML };
  }, [body, issue]);
  return <div className="md discussion-markdown" dangerouslySetInnerHTML={markup} />;
});
