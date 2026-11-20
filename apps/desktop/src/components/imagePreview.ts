// Local images the agent links to (a screenshot it took, an image in the project): a thumbnail
// under the link in the message, and a full-size preview on click. The host reads the file
// (`local_image`, images inside the project only); nothing here opens a file or follows a URL.

import { busyDelay, isBusy } from "../lib/busy";
import { schedulePreview } from "../lib/previewQueue";
import { createImageCache } from "../session/imageCache";

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

const urls = createImageCache(16, 32 * 1024 * 1024);
const inflight = new Map<string, Promise<string>>();

/**
 * Load an image once per link (a streaming message re-renders its tail every frame). Resolved data URLs are kept in a
 * bounded cache (they can be megabytes), concurrent callers share one read, and a failure is never cached: the file
 * may appear later (a screenshot being written).
 */
export function loadCached(href: string, load: (href: string) => Promise<string>): Promise<string> {
  const hit = urls.get(href);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(href);
  if (!p) {
    p = load(href)
      .then((src) => { urls.set(href, src); return src; })
      .finally(() => { inflight.delete(href); });
    inflight.set(href, p);
  }
  return p;
}

// A link that failed is not asked again for a while, whatever happens to its DOM node: a re-render of a streaming
// message creates fresh anchors, and each must not start the whole retry ladder over. After the TTL it may retry
// (the screenshot may be written by now).
const FAILED_TTL_MS = 15_000;
const failedAt = new Map<string, number>();
const recentlyFailed = (href: string): boolean => {
  const at = failedAt.get(href);
  return at !== undefined && Date.now() - at < FAILED_TTL_MS;
};

/** Put a thumbnail after every local-image link in `root` that has none yet. */
export function decorateImageLinks(root: HTMLElement, load: (href: string) => Promise<string>): void {
  const queued = (href: string): Promise<string> =>
    loadCached(href, (h) => new Promise<string>((resolve, reject) => {
      schedulePreview(async () => {
        try { resolve(await load(h)); } catch (e) { reject(e); }
      }, false);
    }));
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"))) {
    const href = a.getAttribute("href") ?? "";
    if (a.dataset.thumb === "1" || !isLocalImageLink(href)) continue;
    // A thumbnail still waiting on a busy retry sits right after the link: do not add a second one.
    if (a.nextElementSibling?.classList.contains("md-thumb")) continue;
    if (recentlyFailed(href)) { a.dataset.thumb = "failed"; continue; }
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
    const attempt = (n: number): void => {
      queued(href)
        .then((src) => {
          img.src = src;
          btn.hidden = false;
          a.dataset.thumb = "1";
        })
        .catch((err: unknown) => {
          const delay = isBusy(err) ? busyDelay(n) : undefined;
          if (delay === undefined) {
            // Terminal for now: the link is remembered as failed (see FAILED_TTL_MS), so no ladder restarts.
            if (failedAt.size > 200) failedAt.clear();
            failedAt.set(href, Date.now());
            a.dataset.thumb = "failed";
            btn.remove();
            return;
          }
          setTimeout(() => {
            if (btn.isConnected && a.isConnected) attempt(n + 1);
            else btn.remove();
          }, delay);
        });
    };
    attempt(0);
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
