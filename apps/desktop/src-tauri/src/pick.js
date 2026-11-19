// The element picker of the browser panel (Phase 0 of docs/requirements/desktop-browser/analysis.md).
//
// The body of an async function run by `callAsyncJavaScript` in the client content world: it shares
// the DOM with the page but not the page's globals, so the page can neither read the result nor
// cancel or spoof it. It highlights the element under the pointer, swallows the page's own pointer
// events while active, and returns (as a JSON string) a description of the element clicked, or
// `{cancelled: true}` on Escape or `__kxPick.cancel()` (from another client-world call).
const prev = globalThis.__kxPick;
if (prev) prev.cancel();

const MAX_HTML = 1500;
const MAX_TEXT = 300;
const STYLE_KEYS = [
  "display", "position", "box-sizing", "width", "height", "margin", "padding", "color", "background-color",
  "font-family", "font-size", "font-weight", "line-height", "text-align", "border", "border-radius",
  "gap", "flex-direction", "justify-content", "align-items", "opacity", "z-index",
];
const ATTRS = ["id", "class", "name", "type", "role", "href", "src", "alt", "title", "placeholder", "aria-label", "data-testid", "data-test", "data-cy", "for"];

const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
const esc = (s) => (globalThis.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, (c) => "\\" + c));
const unique = (sel, el) => {
  try {
    const hits = document.querySelectorAll(sel);
    return hits.length === 1 && hits[0] === el;
  } catch {
    return false;
  }
};

/** A short CSS selector that matches only `el` in its document. */
const selectorOf = (el) => {
  if (el.id && unique(`#${esc(el.id)}`, el)) return `#${esc(el.id)}`;
  for (const a of ["data-testid", "data-test", "data-cy"]) {
    const v = el.getAttribute(a);
    if (v && unique(`[${a}="${v.replace(/"/g, '\\"')}"]`, el)) return `[${a}="${v.replace(/"/g, '\\"')}"]`;
  }
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    if (node.id && unique(`#${esc(node.id)}`, node)) {
      parts.unshift(`#${esc(node.id)}`);
      break;
    }
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
    }
    parts.unshift(part);
    const sel = parts.join(" > ");
    if (unique(sel, el)) return sel;
    node = parent;
  }
  return parts.join(" > ");
};

const roleOf = (el) => {
  const r = el.getAttribute("role");
  if (r) return r;
  const t = el.tagName.toLowerCase();
  if (t === "a" && el.hasAttribute("href")) return "link";
  if (t === "button" || t === "summary") return "button";
  if (t === "select") return "combobox";
  if (t === "textarea") return "textbox";
  if (/^h[1-6]$/.test(t)) return "heading";
  if (t === "img") return "img";
  if (t === "input") {
    const ty = (el.getAttribute("type") || "text").toLowerCase();
    if (ty === "checkbox" || ty === "radio") return ty;
    if (/^(submit|button|reset|image)$/.test(ty)) return "button";
    return "textbox";
  }
  return "";
};

const nameOf = (el) => {
  const by = el.getAttribute("aria-labelledby");
  const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((n) => n.textContent).join(" ") : "";
  return clean(
    el.getAttribute("aria-label") || labelled || (el.labels && el.labels[0] && el.labels[0].textContent)
      || el.getAttribute("alt") || el.getAttribute("title") || el.getAttribute("placeholder") || el.textContent,
  ).slice(0, 120);
};

/** The UI component that rendered `el` and its source location, when a dev build exposes them. */
const componentOf = (el) => {
  const out = [];
  for (let node = el; node && out.length === 0; node = node.parentElement) {
    const fiberKey = Object.keys(node).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    if (fiberKey) {
      for (let f = node[fiberKey]; f && out.length < 3; f = f.return) {
        const type = f.type;
        if (typeof type !== "function" && !(type && typeof type === "object" && (type.render || type.type))) continue;
        const inner = typeof type === "function" ? type : type.render || type.type;
        const name = (type && type.displayName) || (inner && (inner.displayName || inner.name));
        if (!name) continue;
        const src = f._debugSource;
        out.push({ framework: "react", name, file: src ? src.fileName : undefined, line: src ? src.lineNumber : undefined });
      }
      break;
    }
    const vue = node.__vueParentComponent;
    if (vue) {
      for (let c = vue; c && out.length < 3; c = c.parent) {
        const t = c.type || {};
        const name = t.name || t.__name || (t.__file ? t.__file.split("/").pop().replace(/\.vue$/, "") : "");
        if (name) out.push({ framework: "vue", name, file: t.__file });
      }
      break;
    }
    const svelte = node.__svelte_meta;
    if (svelte && svelte.loc) {
      out.push({ framework: "svelte", file: svelte.loc.file, line: svelte.loc.line + 1 });
      break;
    }
  }
  return out;
};

const htmlOf = (el) => {
  const copy = el.cloneNode(true);
  const hide = (n) => {
    if (n.tagName === "INPUT" && (n.getAttribute("type") || "").toLowerCase() === "password") n.removeAttribute("value");
  };
  hide(copy);
  if (copy.querySelectorAll) copy.querySelectorAll("input").forEach(hide);
  const html = copy.outerHTML || "";
  return html.length > MAX_HTML ? html.slice(0, MAX_HTML) + "…" : html;
};

const describe = (el) => {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const styles = {};
  for (const k of STYLE_KEYS) {
    const v = cs.getPropertyValue(k);
    if (v) styles[k] = v.length > 80 ? v.slice(0, 80) + "…" : v;
  }
  const attributes = {};
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v != null && v !== "") attributes[a] = v.slice(0, 200);
  }
  return {
    url: location.href,
    title: document.title,
    tag: el.tagName.toLowerCase(),
    selector: selectorOf(el),
    role: roleOf(el),
    name: nameOf(el),
    text: clean(el.innerText !== undefined ? el.innerText : el.textContent).slice(0, MAX_TEXT),
    attributes,
    html: htmlOf(el),
    styles,
    components: componentOf(el),
    rect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewport: { width: innerWidth, height: innerHeight, scale: devicePixelRatio || 1 },
  };
};

// ---- the overlay ----------------------------------------------------------------------------

const host = document.createElement("keryx-picker");
host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
const root = host.attachShadow ? host.attachShadow({ mode: "closed" }) : host;
root.innerHTML = `<style>
  .box{position:fixed;pointer-events:none;background:rgba(56,132,255,.18);outline:2px solid #3884ff;border-radius:2px;display:none}
  .tip{position:fixed;pointer-events:none;font:12px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:#1d2733;
    padding:3px 7px;border-radius:5px;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis;display:none}
  .hint{position:fixed;left:50%;top:8px;transform:translateX(-50%);pointer-events:none;font:12px/1.4 -apple-system,system-ui,sans-serif;
    color:#fff;background:rgba(29,39,51,.92);padding:4px 10px;border-radius:6px}
  .dim{opacity:.7}
</style><div class="box"></div><div class="tip"></div><div class="hint">Click an element to add it to the message · Esc to cancel</div>`;
const box = root.querySelector(".box");
const tip = root.querySelector(".tip");
const hint = root.querySelector(".hint");
const style = document.createElement("style");
style.textContent = "*{cursor:crosshair!important}";
(document.documentElement || document.body).appendChild(host);
(document.head || document.documentElement).appendChild(style);

let current = null;
const targetOf = (e) => {
  const path = e.composedPath ? e.composedPath() : [];
  const t = path.find((n) => n && n.nodeType === 1 && n !== host) || e.target;
  return t && t.nodeType === 1 && t !== host && t !== document.documentElement ? t : null;
};
const show = (el) => {
  current = el;
  if (!el) {
    box.style.display = tip.style.display = "none";
    return;
  }
  const r = el.getBoundingClientRect();
  Object.assign(box.style, { display: "block", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
  const id = el.id ? "#" + el.id : "";
  const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
  tip.innerHTML = "";
  tip.append(el.tagName.toLowerCase() + id + cls);
  const size = document.createElement("span");
  size.className = "dim";
  size.textContent = `  ${Math.round(r.width)}×${Math.round(r.height)}`;
  tip.append(size);
  tip.style.display = "block";
  const below = r.bottom + 28 < innerHeight;
  tip.style.left = Math.max(4, Math.min(r.left, innerWidth - 240)) + "px";
  tip.style.top = (below ? r.bottom + 6 : Math.max(4, r.top - 26)) + "px";
  hint.style.display = r.top < 40 && r.left < innerWidth / 2 + 200 && r.right > innerWidth / 2 - 200 ? "none" : "block";
};

// Only the user's own input counts: events the page dispatches itself (isTrusted false) cannot pick
// an element or end the picker. (`__kxPickTrustAll` lives in this isolated world, out of the page's
// reach; only the picker's own tests set it, because a test DOM cannot make trusted events.)
const trusted = (e) => e.isTrusted === true || globalThis.__kxPickTrustAll === true;

return await new Promise((resolve) => {
  const swallow = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const finish = (value) => {
    removeEventListener("mousemove", onMove, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", onScroll, true);
    for (const t of SWALLOWED) removeEventListener(t, swallow, true);
    removeEventListener("click", onClick, true);
    host.remove();
    style.remove();
    if (globalThis.__kxPick === api) delete globalThis.__kxPick;
    resolve(JSON.stringify(value));
  };
  const onMove = (e) => {
    if (!trusted(e)) return;
    const el = targetOf(e);
    if (el !== current) show(el);
  };
  const onScroll = () => show(current);
  const onKey = (e) => {
    if (trusted(e) && e.key === "Escape") {
      swallow(e);
      finish({ cancelled: true });
    }
  };
  const onClick = (e) => {
    swallow(e);
    if (!trusted(e)) return;
    const el = targetOf(e) || current;
    if (!el) return;
    let picked;
    try {
      picked = describe(el);
    } catch (err) {
      finish({ error: "Could not read the element: " + (err && err.message ? err.message : err) });
      return;
    }
    finish(picked);
  };
  const SWALLOWED = ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "contextmenu", "auxclick"];
  const api = { cancel: () => finish({ cancelled: true }) };
  globalThis.__kxPick = api;
  addEventListener("mousemove", onMove, true);
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", onScroll, true);
  for (const t of SWALLOWED) addEventListener(t, swallow, true);
  addEventListener("click", onClick, true);
});
