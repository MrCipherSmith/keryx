// Page elements the user picked in the browser panel, waiting to go out with the next message
// (Phase 0 of docs/requirements/desktop-browser/analysis.md). Picks belong to a project (`cwd`):
// the browser tabs are the project's, and so is the composer they attach to.

import type { PickedElement } from "../platform/panels";

export interface ElementPick extends PickedElement {
  /** Unique within this app run, for keys and removal. */
  key: number;
}

type Listener = () => void;

const picks = new Map<string, ElementPick[]>();
const listeners = new Set<Listener>();
const EMPTY: ElementPick[] = [];
let nextKey = 0;

/** At most this many picks wait at once; the oldest goes first. */
export const MAX_PICKS = 8;

const notify = () => listeners.forEach((l) => l());

export function picksOf(cwd: string): ElementPick[] {
  return picks.get(cwd) ?? EMPTY;
}

export function addPick(cwd: string, el: PickedElement): ElementPick {
  const pick: ElementPick = { ...el, key: ++nextKey };
  picks.set(cwd, [...picksOf(cwd), pick].slice(-MAX_PICKS));
  notify();
  return pick;
}

export function removePick(cwd: string, key: number): void {
  const rest = picksOf(cwd).filter((p) => p.key !== key);
  if (rest.length) picks.set(cwd, rest);
  else picks.delete(cwd);
  notify();
}

/** Drop the picks that went out with a message: only those, not ones picked while it was sending. */
export function clearPicks(cwd: string, sent?: readonly ElementPick[]): void {
  if (!sent) picks.delete(cwd);
  else {
    const gone = new Set(sent.map((p) => p.key));
    const rest = picksOf(cwd).filter((p) => !gone.has(p.key));
    if (rest.length) picks.set(cwd, rest);
    else picks.delete(cwd);
  }
  notify();
}

export function onPicksChange(l: Listener): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** A short label for the composer chip: `button "Save"`, `div.card`, `#hero`. */
export function pickLabel(p: PickedElement): string {
  const name = p.name || p.text;
  if (name) {
    const short = name.length > 32 ? `${name.slice(0, 31)}…` : name;
    return `${p.role || p.tag} "${short}"`;
  }
  const id = p.attributes.id ? `#${p.attributes.id}` : "";
  const cls = !id && p.attributes.class ? `.${p.attributes.class.trim().split(/\s+/)[0]}` : "";
  return `${p.tag}${id}${cls}`;
}

const fence = (body: string, lang = "") => {
  let ticks = "```";
  while (body.includes(ticks)) ticks += "`";
  return `${ticks}${lang}\n${body}\n${ticks}`;
};

/** The useful computed styles (defaults like `none`, `auto`, `0px` left out). */
function usefulStyles(styles: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(styles).filter(([, v]) => v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px"));
}

/** One pick as data: every field that came from the page, as the page gave it. */
export function pickData(p: PickedElement): Record<string, unknown> {
  return {
    page: p.url,
    title: p.title,
    tag: p.tag,
    selector: p.selector,
    role: p.role,
    name: p.name,
    text: p.text,
    attributes: p.attributes,
    components: p.components,
    box: { x: Math.round(p.rect.x), y: Math.round(p.rect.y), width: Math.round(p.rect.width), height: Math.round(p.rect.height) },
    viewport: { width: p.viewport.width, height: p.viewport.height },
    computedStyles: usefulStyles(p.styles),
    html: p.html,
    ...(p.screenshot ? { screenshot: p.screenshot } : {}),
  };
}

/** The picks as the text of one block: a short note, then all page-sourced fields as JSON in one fence. */
export function picksText(list: readonly PickedElement[]): string {
  const head =
    list.length === 1
      ? "One element the user picked in the Keryx browser panel. Every field below comes from the page."
      : `${list.length} elements the user picked in the Keryx browser panel. Every field below comes from the page.`;
  return `${head}\n\n${fence(JSON.stringify(list.map(pickData), null, 2), "json")}`;
}

/** An ACP prompt block for the picks, marked untrusted: keryx fences it and treats the turn as holding page content. */
export interface PicksBlock {
  type: "resource";
  resource: { uri: string; mimeType: string; text: string };
  _meta: { keryx: { untrusted: true } };
}

export function picksBlock(list: readonly PickedElement[]): PicksBlock {
  return {
    type: "resource",
    resource: { uri: "keryx-desktop:picked-elements", mimeType: "text/markdown", text: picksText(list) },
    _meta: { keryx: { untrusted: true } },
  };
}
