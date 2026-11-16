import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useDeferredValue, useMemo } from "react";

marked.setOptions({ gfm: true, breaks: false });

// Agent output is untrusted: an explicit allow-list, no <style>, forms, form controls, ids or inline styles.
const SANITIZE = {
  ALLOWED_TAGS: [
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li", "a", "table", "thead", "tbody", "tr", "th", "td", "span",
  ],
  ALLOWED_ATTR: ["href", "title", "class", "align", "start"],
  FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select", "iframe", "object", "embed", "img", "svg", "math", "script"],
  FORBID_ATTR: ["style", "id", "action", "formaction", "src", "srcset", "name", "target"],
  ALLOW_DATA_ATTR: false,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
};
const LANG_CLASS = /^language-[\w+#.-]+$/;
const ALIGN = /^(?:left|right|center)$/;

DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
  const tag = node.nodeName.toLowerCase();
  if (data.attrName === "class") {
    if (!((tag === "code" || tag === "pre") && LANG_CLASS.test(data.attrValue))) data.keepAttr = false;
  } else if (data.attrName === "align") {
    if (!((tag === "th" || tag === "td") && ALIGN.test(data.attrValue))) data.keepAttr = false;
  } else if (data.attrName === "start") {
    if (tag !== "ol" || !/^\d{1,6}$/.test(data.attrValue)) data.keepAttr = false;
  }
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE) as string;
}

export function renderInline(src: string): string {
  const html = marked.parseInline(src, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE) as string;
}

/** Never navigate the app's web view away; links are inert (the model's links are untrusted). */
function blockLinks(e: React.MouseEvent<HTMLElement>) {
  if ((e.target as HTMLElement).closest("a")) e.preventDefault();
}

function onClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  blockLinks(e);
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
  return <div className={`md${className ? ` ${className}` : ""}`} onClick={onClick} onAuxClick={blockLinks} dangerouslySetInnerHTML={{ __html: html }} />;
});

export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderInline(text), [text]);
  // Same guard as Markdown: a link must never navigate the web view.
  return <span className="md-inline" onClick={blockLinks} onAuxClick={blockLinks} dangerouslySetInnerHTML={{ __html: html }} />;
});
