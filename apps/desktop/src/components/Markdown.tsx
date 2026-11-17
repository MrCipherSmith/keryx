import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { emptyCache, renderStreaming, type RenderTokens, type StreamFrame } from "./markdownStream";

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

function sanitize(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE) as string;
}

export function renderMarkdown(src: string): string {
  return sanitize(marked.parse(src, { async: false }) as string);
}

export function renderInline(src: string): string {
  const html = marked.parseInline(src, { async: false }) as string;
  return DOMPurify.sanitize(html, SANITIZE) as string;
}

/** Never navigate the app's web view away; links are inert (the model's links are untrusted), and get no context menu ("Open Link"). */
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

/** The final rendering: what every finished message shows. */
function renderFinal(src: string): string {
  return decorateCodeBlocks(renderMarkdown(src));
}

/** A run of streamed blocks, rendered exactly as the final pass renders them (chrome included). */
const renderTokens: RenderTokens = (tokens) => decorateCodeBlocks(sanitize(marked.parser(tokens)));

/** What the message element currently shows. */
interface View {
  mode: "final" | "stream";
  epoch: number;
  /** Streamed blocks already in the element. */
  shown: number;
  /** The nodes of the open tail, the only ones replaced per frame. */
  tail: ChildNode[];
}

function fragment(html: string): DocumentFragment {
  const t = document.createElement("template");
  t.innerHTML = html;
  return t.content;
}

/** Append the newly completed blocks and swap only the tail; rebuild when the cache started over. */
function showFrame(el: HTMLElement, v: View, f: StreamFrame): void {
  if (v.mode !== "stream" || v.epoch !== f.epoch || f.blocks.length < v.shown) {
    el.replaceChildren();
    v.mode = "stream";
    v.epoch = f.epoch;
    v.shown = 0;
    v.tail = [];
  }
  for (const n of v.tail) n.remove();
  if (v.shown < f.blocks.length) {
    el.append(fragment(f.blocks.slice(v.shown).join("")));
    v.shown = f.blocks.length;
  }
  const tail = fragment(f.tail);
  v.tail = Array.from(tail.childNodes);
  el.append(tail);
}

function showFinal(el: HTMLElement, v: View, html: string): void {
  el.innerHTML = html;
  v.mode = "final";
  v.tail = [];
}

/** A message whose text has not changed for this long is final: render it whole, in one pass. */
const SETTLE_MS = 250;

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const r = useRef({
    shown: null as string | null,
    latest: text,
    // Kept across a settle: the text usually keeps growing from where it was.
    cache: emptyCache(),
    raf: 0,
    settle: 0,
    view: { mode: "final", epoch: 0, shown: 0, tail: [] } as View,
  });

  // The element's children are owned here, not by React: completed blocks stay in place while the
  // message streams and only the open tail is replaced each frame.
  useLayoutEffect(() => {
    const st = r.current;
    const el = ref.current;
    if (!el) return;
    st.latest = text;
    if (st.shown === null) {
      st.shown = text;
      showFinal(el, st.view, renderFinal(text));
      return;
    }
    if (text === st.shown) return;
    // At most one parse per animation frame while the text keeps changing.
    if (!st.raf) {
      st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        st.shown = st.latest;
        showFrame(el, st.view, renderStreaming(st.latest, st.cache, renderTokens));
      });
    }
    window.clearTimeout(st.settle);
    // The settle pass makes the result exactly the one-shot rendering, even when a later block (a
    // reference definition, say) changes an earlier one.
    st.settle = window.setTimeout(() => {
      st.settle = 0;
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      st.shown = st.latest;
      showFinal(el, st.view, renderFinal(st.latest));
    }, SETTLE_MS);
  }, [text]);

  useEffect(
    () => () => {
      const st = r.current;
      if (st.raf) cancelAnimationFrame(st.raf);
      window.clearTimeout(st.settle);
      st.raf = 0;
      st.settle = 0;
    },
    [],
  );

  return <div ref={ref} className={`md${className ? ` ${className}` : ""}`} onClick={onClick} onAuxClick={blockLinks} onContextMenu={blockLinks} />;
});

export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderInline(text), [text]);
  // Same guard as Markdown: a link must never navigate the web view, from a click or its context menu.
  return <span className="md-inline" onClick={blockLinks} onAuxClick={blockLinks} onContextMenu={blockLinks} dangerouslySetInnerHTML={{ __html: html }} />;
});
