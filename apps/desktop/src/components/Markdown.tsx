import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useDeferredValue, useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });

const SANITIZE = { USE_PROFILES: { html: true }, ADD_ATTR: ["data-lang"] };

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE);
}

export function renderInline(src: string): string {
  const html = marked.parseInline(src, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE);
}

function onClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  // Never navigate the app's web view away; links are inert (the model's links are untrusted).
  if (target.closest("a")) e.preventDefault();
  const copy = target.closest<HTMLButtonElement>("button.code-copy");
  if (copy) {
    const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    void navigator.clipboard.writeText(code).then(() => {
      copy.dataset.copied = "true";
      copy.textContent = "Copied";
      window.setTimeout(() => {
        copy.dataset.copied = "false";
        copy.textContent = "Copy";
      }, 1200);
    });
  }
}

/** Wrap every fenced block with a header carrying its language and a copy button. */
function decorateCodeBlocks(html: string): string {
  if (!html.includes("<pre>")) return html;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  const root = doc.body.firstElementChild;
  if (!root) return html;
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    const code = pre.querySelector("code");
    const lang = /language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1] ?? "";
    const wrap = doc.createElement("div");
    wrap.className = "code-block";
    const head = doc.createElement("div");
    head.className = "code-head";
    const label = doc.createElement("span");
    label.className = "code-lang";
    label.textContent = lang || "text";
    const btn = doc.createElement("button");
    btn.className = "code-copy";
    btn.type = "button";
    btn.textContent = "Copy";
    head.append(label, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
  return root.innerHTML;
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const deferred = useDeferredValue(text);
  const html = useMemo(() => decorateCodeBlocks(renderMarkdown(deferred)), [deferred]);
  return <div className={`md${className ? ` ${className}` : ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});

export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderInline(text), [text]);
  return <span className="md-inline" dangerouslySetInnerHTML={{ __html: html }} />;
});
