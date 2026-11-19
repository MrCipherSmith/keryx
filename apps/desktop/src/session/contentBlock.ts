// What a non-text ACP content block shows. Pure: the view and its tests share it.
import type { ContentBlock } from "../acp/types";
import { languageForPath } from "../components/highlight";

/** Raster types a web view shows safely from a data URI. SVG is left out: it is a document, not a picture. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** A `data:` URI for an inline image, or null when its type or payload is not one the app shows. */
export function imageDataUri(mimeType: unknown, data: unknown): string | null {
  if (typeof mimeType !== "string" || typeof data !== "string") return null;
  const mime = mimeType.toLowerCase().split(";")[0]!.trim();
  if (!IMAGE_TYPES.has(mime)) return null;
  const payload = data.replace(/\s+/g, "");
  if (payload === "" || !BASE64.test(payload)) return null;
  return `data:${mime};base64,${payload}`;
}

export type BlockView =
  | { kind: "image"; src: string; alt: string }
  | { kind: "link"; name: string; uri: string; detail: string | null }
  | { kind: "file"; uri: string; text: string; lang: string }
  | { kind: "binary"; uri: string; detail: string }
  | { kind: "text"; text: string }
  | { kind: "unknown"; label: string };

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** The last path segment of a URI, for a label. */
export function uriName(uri: string): string {
  const path = uri.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return decodeURIComponentSafe(path.slice(path.lastIndexOf("/") + 1)) || uri;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function blockView(block: ContentBlock): BlockView {
  const b = block as Record<string, unknown>;
  switch (block.type) {
    case "text":
      return { kind: "text", text: typeof b.text === "string" ? b.text : "" };
    case "image": {
      const src = imageDataUri(b.mimeType, b.data);
      const uri = str(b.uri);
      if (src) return { kind: "image", src, alt: uri ? uriName(uri) : "image" };
      return { kind: "unknown", label: `image${str(b.mimeType) ? ` (${String(b.mimeType)})` : ""} not shown` };
    }
    case "resource_link": {
      const uri = str(b.uri) ?? "";
      const name = str(b.title) ?? str(b.name) ?? uriName(uri);
      const parts = [str(b.mimeType), typeof b.size === "number" ? formatSize(b.size) : null].filter((p): p is string => p !== null);
      return { kind: "link", name, uri, detail: parts.length > 0 ? parts.join(" · ") : null };
    }
    case "resource": {
      const r = (b.resource ?? {}) as Record<string, unknown>;
      const uri = str(r.uri) ?? "resource";
      if (typeof r.text === "string") return { kind: "file", uri, text: r.text, lang: languageForPath(uri) };
      const src = imageDataUri(r.mimeType, r.blob);
      if (src) return { kind: "image", src, alt: uriName(uri) };
      const size = typeof r.blob === "string" ? formatSize(Math.floor((r.blob.length * 3) / 4)) : null;
      return { kind: "binary", uri, detail: [str(r.mimeType), size].filter(Boolean).join(" · ") || "binary" };
    }
    default:
      return { kind: "unknown", label: `${block.type} content not shown` };
  }
}

/** A Markdown fence around `text` that no backtick run inside it can close. */
export function fenced(text: string, lang: string): string {
  const longest = Math.max(2, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n$/, "")}\n${fence}`;
}
