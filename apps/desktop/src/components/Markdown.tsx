import DOMPurify from "dompurify";
import { marked } from "marked";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Menu } from "./Menu";
import { decoratePrReferences, type PrLinks } from "./prLinks";
import { githubPrUrl } from "../lib/githubPr";
import { codeBlockCopyText, revealCodeBlock } from "./codeBlock";
import { highlightToHtml } from "./highlight";
import { diffLines, diffStats, looksLikeUnifiedDiff } from "./unifiedDiff";
import { emptyCache, renderStreaming, type RenderTokens, type StreamFrame } from "./markdownStream";
import { isShellLang, runInTerminal, runnableCommand } from "../panels/panelBus";
import { localImage } from "../platform/commands";
import { clickedImageLink, decorateImageLinks, loadCached, openImagePreview } from "./imagePreview";

marked.setOptions({ gfm: true, breaks: false });

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// An image in a message is shown as a link (images are not rendered from markup); a local one then gets a
// thumbnail from the host (see imagePreview.ts).
marked.use({
  renderer: {
    image({ href, text }: { href: string; text: string }) {
      return `<a href="${escapeHtml(href ?? "")}">${escapeHtml(text || href || "image")}</a>`;
    },
  },
});

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
  // Links: web, mail, anchors, and local image files (shown as thumbnails; nothing else local is linked).
  ALLOWED_URI_REGEXP:
    /^(?:https?:|mailto:|#|file:\/\/\/[^?#]*\.(?:png|jpe?g|webp|gif)$|\/(?!\/)[^?#]*\.(?:png|jpe?g|webp|gif)$|(?![a-z][a-z0-9+.-]*:)[^/?#][^?#]*\.(?:png|jpe?g|webp|gif)$)/i,
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

/** Prevent native WebView navigation; only explicitly handled links can open a browser. */
function blockLinks(e: React.MouseEvent<HTMLElement>) {
  if ((e.target as HTMLElement).closest("a")) e.preventDefault();
}

function onClick(e: React.MouseEvent<HTMLDivElement>) {
  const target = e.target as HTMLElement;
  blockLinks(e);
  const image = clickedImageLink(target);
  if (image) {
    const alt = target.closest(".md-thumb")?.querySelector("img")?.alt ?? target.textContent ?? "";
    void loadCached(image, localImage)
      .then((src) => openImagePreview(src, alt))
      .catch(() => {});
    return;
  }
  const run = target.closest<HTMLButtonElement>("button.code-run");
  if (run) {
    const block = run.closest<HTMLElement>(".code-block");
    const command = runnableCommand(codeBlockCopyText(block ?? null, block?.querySelector("code") ?? null));
    if (command) runInTerminal(command);
    return;
  }
  const copy = target.closest<HTMLButtonElement>("button.code-copy");
  if (copy) {
    const block = copy.closest<HTMLElement>(".code-block");
    // Copy keeps the raw text; a block that shows escapes carries it aside.
    const code = codeBlockCopyText(block ?? null, block?.querySelector("code") ?? null);
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
    const fenceLang = /language-([\w+#.-]+)/.exec(code?.className ?? "")?.[1] ?? "";
    const rawText = (code ?? pre).textContent ?? "";
    const isDiff = /^(?:diff|patch|udiff)$/i.test(fenceLang) || (fenceLang === "" && looksLikeUnifiedDiff(rawText));
    const lang = isDiff ? "diff" : fenceLang;
    const wrap = doc.createElement("div");
    wrap.className = isDiff ? "code-block is-diff" : "code-block";
    revealCodeBlock(code ?? pre, wrap);
    // A block that had hidden characters revealed is shown as escaped text, uncoloured.
    const revealed = wrap.dataset.raw !== undefined;
    let stats: { added: number; removed: number } | null = null;
    if (code && isDiff) {
      const lines = diffLines(code.textContent ?? "");
      stats = diffStats(lines);
      if (!revealed) wrap.dataset.raw = rawText;
      code.replaceChildren(
        ...lines.map((l) => {
          const row = doc.createElement("span");
          row.className = `diff-line diff-${l.kind}`;
          row.textContent = l.text || " ";
          return row;
        }),
      );
    } else if (code && !revealed && lang) {
      const html = highlightToHtml(rawText, lang);
      if (html !== null) {
        code.innerHTML = html;
        code.classList.add("hljs");
      }
    }
    const head = doc.createElement("div");
    head.className = "code-head";
    const label = doc.createElement("span");
    label.className = "code-lang";
    label.textContent = lang || "text";
    const btn = doc.createElement("button");
    btn.className = "code-copy";
    btn.type = "button";
    btn.textContent = "Copy";
    head.append(label);
    if (stats) {
      const st = doc.createElement("span");
      st.className = "code-diff-stat";
      const add = doc.createElement("span");
      add.className = "diff-stat add";
      add.textContent = `+${stats.added}`;
      const del = doc.createElement("span");
      del.className = "diff-stat del";
      del.textContent = `\u2212${stats.removed}`;
      st.append(add, del);
      head.append(st);
    }
    // One shell command gets Run (D-13): it is typed into the side panel's terminal. A block that
    // had hidden characters revealed never does.
    if (isShellLang(lang) && wrap.dataset.raw === undefined && runnableCommand(code?.textContent ?? "") !== null) {
      const runBtn = doc.createElement("button");
      runBtn.className = "code-run";
      runBtn.type = "button";
      runBtn.title = "Run in the terminal panel";
      runBtn.textContent = "Run";
      head.append(runBtn);
    }
    head.append(btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
  return root.innerHTML;
}

/** The final rendering: what every finished message shows. */
function renderFinal(src: string, repository?: string): string {
  return decorateCodeBlocks(decoratePrReferences(renderMarkdown(src), repository));
}

/** What the message element currently shows. */
interface View {
  mode: "final" | "stream";
  finalHtml?: string;
  completed?: readonly string[];
  epoch: number;
  /** Streamed blocks already in the element. */
  blocksShown: number;
  /** The open tail's HTML as last rendered; an unchanged tail is left alone. */
  tailHtml: string;
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
  if (v.mode === "final" && v.finalHtml === f.blocks.join("") + f.tail) return;
  if (v.mode !== "stream" || v.completed !== f.blocks || v.epoch !== f.epoch || f.blocks.length < v.blocksShown) {
    el.replaceChildren();
    v.mode = "stream";
    v.epoch = f.epoch;
    v.completed = f.blocks;
    v.blocksShown = 0;
    v.tail = [];
    v.tailHtml = "";
  }
  const grew = v.blocksShown < f.blocks.length;
  // An unchanged open tail keeps its nodes (a selection or a clicked Copy button inside it survives).
  if (!grew && f.tail === v.tailHtml) return;
  for (const n of v.tail) n.remove();
  if (grew) {
    el.append(fragment(f.blocks.slice(v.blocksShown).join("")));
    v.blocksShown = f.blocks.length;
  }
  const tail = fragment(f.tail);
  v.tail = Array.from(tail.childNodes);
  v.tailHtml = f.tail;
  el.append(tail);
}

function showFinal(el: HTMLElement, v: View, html: string): void {
  const shown = v.mode === "final" ? v.finalHtml : (v.completed?.slice(0, v.blocksShown).join("") ?? "") + v.tailHtml;
  if (shown === html) return;
  el.innerHTML = html;
  v.mode = "final";
  v.finalHtml = html;
  v.completed = undefined;
  v.tail = [];
  v.tailHtml = "";
}

/** A message whose text has not changed for this long is final: render it whole, in one pass. */
const SETTLE_MS = 250;

export const Markdown = memo(function Markdown({ text, className, prLinks }: { text: string; className?: string; prLinks?: PrLinks }) {
  const ref = useRef<HTMLDivElement>(null);
  const [prMenu, setPrMenu] = useState<{ anchor: HTMLAnchorElement; url: string } | null>(null);
  const menuRef = useRef(prMenu);
  const closePrMenu = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return;
    menuRef.current = null;
    setPrMenu(null);
    const el = ref.current;
    if (el?.isConnected) (el.contains(menu.anchor) ? menu.anchor : el).focus({ preventScroll: true });
  }, []);
  const closeDetachedMenu = useCallback(() => {
    if (menuRef.current && !ref.current?.contains(menuRef.current.anchor)) closePrMenu();
  }, [closePrMenu]);
  const repository = prLinks?.repository;
  const renderTokens = useMemo<RenderTokens>(() => (tokens) =>
    decorateCodeBlocks(decoratePrReferences(sanitize(marked.parser(tokens)), repository)), [repository]);
  const r = useRef({
    renderedText: null as string | null,
    repository,
    latest: text,
    // Kept across a settle: the text usually keeps growing from where it was.
    cache: emptyCache(),
    raf: 0,
    settle: 0,
    view: { mode: "final", epoch: 0, blocksShown: 0, tailHtml: "", tail: [] } as View,
  });

  // The element's children are owned here, not by React: completed blocks stay in place while the
  // message streams and only the open tail is replaced each frame.
  useLayoutEffect(() => {
    const st = r.current;
    const el = ref.current;
    if (!el) return;
    st.latest = text;
    if (st.renderedText === null || st.repository !== repository) {
      if (st.raf) cancelAnimationFrame(st.raf);
      window.clearTimeout(st.settle);
      st.raf = 0;
      st.settle = 0;
      st.repository = repository;
      st.cache = emptyCache();
      st.renderedText = text;
      showFinal(el, st.view, renderFinal(text, repository));
      closeDetachedMenu();
      return;
    }
    if (text === st.renderedText) return;
    // At most one parse per animation frame while the text keeps changing.
    if (!st.raf) {
      st.raf = requestAnimationFrame(() => {
        st.raf = 0;
        st.renderedText = st.latest;
        showFrame(el, st.view, renderStreaming(st.latest, st.cache, renderTokens));
        closeDetachedMenu();
      });
    }
    window.clearTimeout(st.settle);
    // The settle pass makes the result exactly the one-shot rendering, even when a later block (a
    // reference definition, say) changes an earlier one.
    st.settle = window.setTimeout(() => {
      st.settle = 0;
      if (st.raf) cancelAnimationFrame(st.raf);
      st.raf = 0;
      st.renderedText = st.latest;
      const final = renderFinal(st.latest, repository);
      // When the streamed view already reads exactly like the one-shot rendering, keep its nodes: a
      // pause must not replace the message under the user's selection.
      const frame = renderStreaming(st.latest, st.cache, renderTokens);
      if (st.view.mode === "stream" && frame.blocks.join("") + frame.tail === final) showFrame(el, st.view, frame);
      else showFinal(el, st.view, final);
      closeDetachedMenu();
    }, SETTLE_MS);
  }, [text, repository, renderTokens, closeDetachedMenu]);

  // Local-image links get thumbnails, also as the message streams in (throttled to a frame).
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof MutationObserver === "undefined") return;
    let raf = 0;
    const run = () => {
      raf = 0;
      decorateImageLinks(el, localImage);
    };
    run();
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(run);
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

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

  const showPrMenu = (target: EventTarget) => {
    if (!(target instanceof Element) || !prLinks) return false;
    const anchor = target.closest<HTMLAnchorElement>("a");
    const url = githubPrUrl(anchor?.getAttribute("href") ?? null, prLinks.repository);
    if (!anchor || !url) return false;
    const menu = { anchor, url };
    menuRef.current = menu;
    setPrMenu(menu);
    return true;
  };

  return <>
    <div ref={ref} tabIndex={-1} className={`md${className ? ` ${className}` : ""}`} onAuxClick={blockLinks}
      onClick={(e) => {
        const url = githubPrUrl((e.target as HTMLElement).closest("a")?.getAttribute("href") ?? null, prLinks?.repository);
        if (prLinks && url) {
          e.preventDefault();
          prLinks.openExternal(url);
        } else onClick(e);
      }}
      onContextMenu={(e) => { if (showPrMenu(e.target)) e.preventDefault(); else blockLinks(e); }}
      onKeyDown={(e) => {
        if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && showPrMenu(e.target)) e.preventDefault();
      }} />
    {prMenu && prLinks ? <Menu anchor={prMenu.anchor} label="Pull request link" width={255} placement="auto" closeOnScroll onClose={closePrMenu} items={[
      { id: "system", icon: "external", label: "Open in default browser", onSelect: () => { if (ref.current?.contains(prMenu.anchor)) prLinks.openExternal(prMenu.url); } },
      { id: "internal", icon: "globe", label: "Open in Keryx Browser", disabled: !prLinks.openInternal,
        description: prLinks.openInternal ? undefined : "Available in the native app",
        onSelect: () => { if (ref.current?.contains(prMenu.anchor)) prLinks.openInternal?.(prMenu.url); } },
    ]} /> : null}
  </>;
});

export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  const html = useMemo(() => renderInline(text), [text]);
  // Same guard as Markdown: a link must never navigate the web view, from a click or its context menu.
  return <span className="md-inline" onClick={blockLinks} onAuxClick={blockLinks} onContextMenu={blockLinks} dangerouslySetInnerHTML={{ __html: html }} />;
});
