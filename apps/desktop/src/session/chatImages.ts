import { useCallback, useRef, useState } from "react";
import { busyDelay, busyMessage, isBusy } from "../lib/busy";
import { errMessage } from "../lib/format";
import type { LineComment } from "./lineComments";

export type SaveChatImage = (mimeType: string, data: string) => Promise<string>;
export type SaveChatFile = (extension: string, data: string) => Promise<string>;
export interface LocalAttachment { kind: "file" | "folder"; label: string; path: string }
/** A remark on a changed line: kept in the draft like a chip, but it is not a saved file (`path` is only its key). */
export interface LineCommentAttachment { kind: "line-comment"; path: string; comment: LineComment }
export type ChatAttachment = LocalAttachment | { kind: "image"; path: string } | LineCommentAttachment;
interface AttachmentDraft { items: readonly ChatAttachment[]; error?: string; pending?: boolean }
const EMPTY: AttachmentDraft = { items: [] };
const MAX_IMAGES = 4;
const MAX_COMMENTS = 50;
let commentSeq = 0;
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

const shown = (reason: unknown): string => busyMessage(reason) ?? errMessage(reason);

/** The host admits only a few saves at once: wait and retry a busy refusal, but stop as soon as the draft is gone. */
async function withBusyRetry<T>(run: () => Promise<T>, alive: () => boolean): Promise<T> {
  for (let n = 0; ; n++) {
    if (!alive()) throw new Error("The draft was closed.");
    try {
      return await run();
    } catch (error) {
      const delay = isBusy(error) ? busyDelay(n) : undefined;
      if (delay === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/** Read and encode a file once; the returned function only asks the host to store it, so a busy retry re-sends, not re-encodes. */
async function prepareFile(file: File, options: { saveImage?: SaveChatImage; saveFile?: SaveChatFile; imageOnly: boolean }): Promise<() => Promise<ChatAttachment>> {
  const { saveImage, saveFile } = options;
  if (saveImage && IMAGE_TYPES.has(file.type)) {
    const data = await fileBase64(file);
    return async () => ({ kind: "image", path: await saveImage(file.type, data) });
  }
  if (options.imageOnly || !saveFile) throw new Error("Paste a PNG, JPEG, GIF, or WebP image.");
  const extension = /\.([a-z0-9]{1,12})$/i.exec(file.name)?.[1]?.toLowerCase() ?? "bin";
  const data = await fileBase64(file);
  return async () => ({ kind: "file", path: await saveFile(extension, data), label: file.name });
}

export function useChatAttachments(sessionId: string | null, options: {
  saveImage?: SaveChatImage;
  saveFile?: SaveChatFile;
  pickFolder?: () => Promise<string | null>;
  discardFile?: (path: string) => Promise<void>;
}) {
  const [drafts, setDrafts] = useState<Record<string, AttachmentDraft>>({});
  const saving = useRef(new Set<string>());
  // Bumped when a session's draft is dropped: a save that started before then must not write into the new draft.
  const epochs = useRef(new Map<string, number>());
  const draft = (sessionId && drafts[sessionId]) || EMPTY;
  /** Forget a session's chips without touching the saved files (the caller discards those). */
  const drop = useCallback((id: string) => {
    epochs.current.set(id, (epochs.current.get(id) ?? 0) + 1);
    setDrafts((all) => {
      if (!(id in all)) return all;
      const rest = { ...all };
      delete rest[id];
      return rest;
    });
  }, []);
  const update = (change: (current: AttachmentDraft) => AttachmentDraft) => {
    if (sessionId) setDrafts((all) => ({ ...all, [sessionId]: change(all[sessionId] ?? EMPTY) }));
  };
  const add = async (count: number, load: (alive: () => boolean) => Promise<readonly PromiseSettledResult<ChatAttachment>[]>) => {
    if (!sessionId || !count) return;
    if (saving.current.has(sessionId)) {
      update((d) => ({ ...d, error: "Wait for the previous attachment to finish, then try again." }));
      return;
    }
    if (count + draft.items.filter((item) => item.kind !== "line-comment").length > MAX_IMAGES) {
      update((d) => ({ ...d, error: `Up to ${MAX_IMAGES} attachments per message.` }));
      return;
    }
    const epoch = epochs.current.get(sessionId) ?? 0;
    const alive = () => (epochs.current.get(sessionId) ?? 0) === epoch;
    saving.current.add(sessionId);
    update((d) => ({ ...d, pending: true, error: undefined }));
    try {
      const results = await load(alive);
      const items = results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []);
      if (!alive()) {
        // The draft was dropped while this ran (session switched, view closed): nothing will ever show or discard these.
        for (const item of items) if (item.kind !== "folder" && item.kind !== "line-comment") void options.discardFile?.(item.path)?.catch(() => {});
        return;
      }
      const failed = results.find((r) => r.status === "rejected");
      const skipped = count - results.length;
      const reason = failed ? `${shown(failed.reason)}${skipped > 0 ? ` ${skipped} more not added.` : ""}` : undefined;
      // The final state replaces any transient notice (such as "wait for the previous attachment").
      update((d) => ({ items: [...new Map([...d.items, ...items].map((item) => [item.path, item])).values()], error: reason }));
    } catch (error) {
      if (alive()) update((d) => ({ ...d, pending: false, error: shown(error) }));
    } finally {
      saving.current.delete(sessionId);
    }
  };
  // One at a time: a batch of four must not trip the host's cap of three concurrent saves. After the first busy
  // refusal that outlasts the retries, the rest are not attempted (the user is told how many were left out).
  const addFiles = (files: readonly File[], imageOnly = false) => add(files.length, async (alive) => {
    const results: PromiseSettledResult<ChatAttachment>[] = [];
    for (const file of files) {
      if (!alive()) break;
      try {
        const save = await prepareFile(file, { ...options, imageOnly });
        results.push({ status: "fulfilled", value: await withBusyRetry(save, alive) });
      } catch (reason) {
        results.push({ status: "rejected", reason });
        if (isBusy(reason)) break;
      }
    }
    return results;
  });
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
    if (item.kind === "folder" || item.kind === "line-comment" || !options.discardFile) { remove([item.path]); return; }
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
  /** Add a remark on a changed line. It needs no save, so it works while a file is being saved. */
  const addLineComment = (comment: LineComment): boolean => {
    if (!sessionId) return false;
    if (draft.items.filter((item) => item.kind === "line-comment").length >= MAX_COMMENTS) {
      update((d) => ({ ...d, error: `Up to ${MAX_COMMENTS} line comments per message.` }));
      return false;
    }
    const item: LineCommentAttachment = { kind: "line-comment", path: `line-comment:${++commentSeq}`, comment };
    update((d) => ({ ...d, items: [...d.items, item] }));
    return true;
  };
  /** A notice in the composer's status line (for example "wait for the attachments"). */
  const warn = (message: string) => update((d) => ({ ...d, error: message }));
  return { ...draft, addFiles, addFolder, addLineComment, remove, discard, drop, warn, isSaving: () => !!sessionId && saving.current.has(sessionId) };
}
