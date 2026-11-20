import { useRef, useState } from "react";
import { basename, errMessage } from "../lib/format";

export type SaveChatImage = (mimeType: string, data: string) => Promise<string>;
export type SaveChatFile = (extension: string, data: string) => Promise<string>;
export interface LocalAttachment { kind: "file" | "folder"; label: string; path: string }
type ChatAttachment = LocalAttachment | { kind: "image"; path: string; src: string };
interface AttachmentDraft { items: readonly ChatAttachment[]; error?: string; pending?: boolean }
const EMPTY: AttachmentDraft = { items: [] };
const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function fileBase64(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error("Each attachment must be at most 5 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}

async function storeFile(file: File, options: { saveImage?: SaveChatImage; saveFile?: SaveChatFile; imageOnly: boolean }): Promise<ChatAttachment> {
  if (options.saveImage && IMAGE_TYPES.has(file.type)) {
    const data = await fileBase64(file);
    const path = await options.saveImage(file.type, data);
    return { kind: "image", path, src: `data:${file.type};base64,${data}` };
  }
  if (options.imageOnly || !options.saveFile) throw new Error("Paste a PNG, JPEG, GIF, or WebP image.");
  const extension = /\.([a-z0-9]{1,12})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "bin";
  const path = await options.saveFile(extension, await fileBase64(file));
  return { kind: "file", path, label: file.name };
}

export function useChatAttachments(sessionId: string | null, options: {
  saveImage?: SaveChatImage;
  saveFile?: SaveChatFile;
  pickFolder?: () => Promise<string | null>;
}) {
  const [drafts, setDrafts] = useState<Record<string, AttachmentDraft>>({});
  const saving = useRef(new Set<string>());
  const draft = (sessionId && drafts[sessionId]) || EMPTY;
  const update = (change: (current: AttachmentDraft) => AttachmentDraft) => {
    if (sessionId) setDrafts((all) => ({ ...all, [sessionId]: change(all[sessionId] ?? EMPTY) }));
  };
  const add = async (count: number, load: () => Promise<readonly PromiseSettledResult<ChatAttachment>[]>) => {
    if (!sessionId || !count) return;
    if (saving.current.has(sessionId)) {
      update((d) => ({ ...d, error: "Wait for the previous attachment to finish, then try again." }));
      return;
    }
    if (count + draft.items.length > MAX_IMAGES) {
      update((d) => ({ ...d, error: `Up to ${MAX_IMAGES} attachments per message.` }));
      return;
    }
    saving.current.add(sessionId);
    update((d) => ({ ...d, pending: true, error: undefined }));
    try {
      const results = await load();
      const items = results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
      const failed = results.find((r) => r.status === "rejected");
      update((d) => ({ items: [...new Map([...d.items, ...items].map((item) => [item.path, item])).values()], error: failed ? errMessage(failed.reason) : d.error }));
    } catch (error) {
      update((d) => ({ ...d, pending: false, error: errMessage(error) }));
    } finally {
      saving.current.delete(sessionId);
    }
  };
  const addFiles = (files: readonly File[], imageOnly = false) => add(files.length, () =>
    Promise.allSettled(files.map((file) => storeFile(file, { ...options, imageOnly }))));
  const addFolder = () => add(1, async () => {
    const path = await options.pickFolder?.();
    if (!path) return [];
    if (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Choose an absolute local folder path.");
    const value: LocalAttachment = { kind: "folder", path, label: basename(path.replace(/\/+$/, "")) || path };
    return [{ status: "fulfilled", value }];
  });
  const remove = (paths: readonly string[]) => update((d) => ({ ...d, error: undefined, items: d.items.filter((item) => !paths.includes(item.path)) }));
  return { ...draft, addFiles, addFolder, remove, isSaving: () => !!sessionId && saving.current.has(sessionId) };
}

// ACP is text-only: keryx receives local paths, and Desktop renders the suffix as attachments.
const IMAGE_HEADER = "[Local image attachments (use local tools to inspect):]";

export function withImagePaths(text: string, paths: readonly string[]): string {
  return paths.length ? [text, `${IMAGE_HEADER}\n${paths.join("\n")}`].filter(Boolean).join("\n\n") : text;
}

export function splitImagePaths(text: string): { text: string; paths: string[] } {
  const at = text.lastIndexOf(IMAGE_HEADER);
  if (at < 0 || (at > 0 && text.slice(at - 2, at) !== "\n\n")) return { text, paths: [] };
  const paths = text.slice(at + IMAGE_HEADER.length).trim().split("\n");
  return paths.length <= MAX_IMAGES && paths.every((p) => /^\/(?:[^\r\n]*\/)?keryx-chat-images-[\w.-]+\/[\w.-]+\.(png|jpg|gif|webp)$/.test(p))
    ? { text: text.slice(0, at).trimEnd(), paths } : { text, paths: [] };
}

export function withLocalAttachments(text: string, attachments: readonly LocalAttachment[]): string {
  if (!attachments.length) return text;
  const lines = attachments.map(({ kind, label, path }) => `${kind === "folder" ? "Folder" : "File"} ${JSON.stringify(label)}: ${JSON.stringify(path)}`);
  return [text, `[Local attachments (use local tools to inspect):]\n${lines.join("\n")}`].filter(Boolean).join("\n\n");
}
