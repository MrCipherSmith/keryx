import { useCallback, useRef, useState } from "react";
import { errMessage } from "../lib/format";

export type SaveChatImage = (mimeType: string, data: string) => Promise<string>;
export type SaveChatFile = (extension: string, data: string) => Promise<string>;
export interface LocalAttachment { kind: "file" | "folder"; label: string; path: string }
type ChatAttachment = LocalAttachment | { kind: "image"; path: string };
interface AttachmentDraft { items: readonly ChatAttachment[]; error?: string; pending?: boolean }
const EMPTY: AttachmentDraft = { items: [] };
const MAX_IMAGES = 4;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

async function fileBase64(file: File): Promise<string> {
  if (file.size > MAX_BYTES) throw new Error("Each attachment must be at most 5 MiB.");
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the attachment."));
    reader.onabort = () => reject(new Error("Reading the attachment was aborted."));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const prefix = /^data:[^,]*;base64,/.exec(result);
      if (!prefix) { reject(new Error("Could not read the attachment.")); return; }
      resolve(result.slice(prefix[0].length));
    };
    reader.readAsDataURL(file);
  });
}

async function storeFile(file: File, options: { saveImage?: SaveChatImage; saveFile?: SaveChatFile; imageOnly: boolean }): Promise<ChatAttachment> {
  if (options.saveImage && IMAGE_TYPES.has(file.type)) {
    const data = await fileBase64(file);
    const path = await options.saveImage(file.type, data);
    return { kind: "image", path };
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
  discardFile?: (path: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, AttachmentDraft>>({});
  const saving = useRef(new Set<string>());
  const draft = (sessionId && drafts[sessionId]) || EMPTY;
  /** Forget a session's chips without touching the saved files (the caller discards those). */
  const drop = useCallback((id: string) => setDrafts((all) => {
    if (!(id in all)) return all;
    const rest = { ...all };
    delete rest[id];
    return rest;
  }), []);
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
    if (!(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+/.test(path)) || /[\x00-\x1f\x7f]/.test(path)) throw new Error("Choose an absolute local folder path.");
    const value: LocalAttachment = { kind: "folder", path, label: path.split(/[\\/]/).filter(Boolean).pop() || path };
    return [{ status: "fulfilled", value }];
  });
  const remove = (paths: readonly string[]) => update((d) => ({ ...d, error: undefined, items: d.items.filter((item) => !paths.includes(item.path)) }));
  const discard = async (item: ChatAttachment) => {
    if (!sessionId || saving.current.has(sessionId)) return;
    if (item.kind === "folder" || !options.discardFile) { remove([item.path]); return; }
    saving.current.add(sessionId);
    update((d) => ({ ...d, pending: true, error: undefined }));
    try {
      await options.discardFile(item.path);
      remove([item.path]);
    } catch (error) {
      update((d) => ({ ...d, error: errMessage(error) }));
    } finally {
      saving.current.delete(sessionId);
      update((d) => ({ ...d, pending: false }));
    }
  };
  return { ...draft, addFiles, addFolder, remove, discard, drop, isSaving: () => !!sessionId && saving.current.has(sessionId) };
}
