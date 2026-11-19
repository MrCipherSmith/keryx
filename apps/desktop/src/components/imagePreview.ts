// Local images the agent links to (a screenshot it took, an image in the project): a thumbnail
// under the link in the message, and a full-size preview on click. The host reads the file
// (`local_image`, images inside the project only); nothing here opens a file or follows a URL.

const IMAGE = /\.(?:png|jpe?g|webp|gif)$/i;

/** A link to a local image file: a relative path, an absolute path, or `file:///…`. Never a URL with a scheme or host. */
export function isLocalImageLink(href: string): boolean {
  const h = href.trim();
  if (!IMAGE.test(h.split(/[?#]/)[0] ?? "")) return false;
  if (h.startsWith("file:///")) return true;
  if (h.startsWith("//")) return false;
  if (h.startsWith("/")) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(h);
}

const cache = new Map<string, Promise<string>>();

/** Load an image once per link (a streaming message re-renders its tail every frame). */
export function loadCached(href: string, load: (href: string) => Promise<string>): Promise<string> {
  let p = cache.get(href);
  if (!p) {
    p = load(href);
    // A failure is not cached: the file may appear later (a screenshot being written).
    p.catch(() => cache.delete(href));
    cache.set(href, p);
  }
  return p;
}

/** Put a thumbnail after every local-image link in `root` that has none yet. */
export function decorateImageLinks(root: HTMLElement, load: (href: string) => Promise<string>): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (a.dataset.thumb || !isLocalImageLink(href)) continue;
    a.dataset.thumb = "1";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "md-thumb";
    btn.dataset.href = href;
    btn.title = "Open image";
    btn.hidden = true;
    const img = document.createElement("img");
    img.alt = a.textContent?.trim() || "Image";
    btn.append(img);
    a.after(btn);
    loadCached(href, load)
      .then((src) => {
        img.src = src;
        btn.hidden = false;
      })
      .catch(() => btn.remove());
  }
}

/** The local-image link a click landed on (the link itself or its thumbnail), if any. */
export function clickedImageLink(target: HTMLElement): string | null {
  const thumb = target.closest<HTMLElement>(".md-thumb");
  if (thumb?.dataset.href) return thumb.dataset.href;
  const href = target.closest("a")?.getAttribute("href") ?? null;
  return href && isLocalImageLink(href) ? href : null;
}

/** Show `src` full size over the window; a click or Esc closes it. */
export function openImagePreview(src: string, alt: string): () => void {
  const overlay = document.createElement("div");
  overlay.className = "img-preview";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", alt || "Image");
  const img = document.createElement("img");
  img.src = src;
  img.alt = alt;
  overlay.append(img);
  const close = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  overlay.addEventListener("click", close);
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  return close;
}
