import { randomUUID } from "node:crypto";
import { mkdtemp, open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";

export interface ChatOwner { closed: boolean }
type Json = Record<string, unknown>;
const CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

export function createChatAttachmentStore({ maxFiles = 512, maxBytes = 256 * 1024 * 1024, onRoot }: {
  maxFiles?: number;
  maxBytes?: number;
  onRoot: (path: string) => void;
}) {
  // 192 KiB raw corresponds to 256 KiB of base64, without split quanta.
  const RAW_CHUNK = 192 * 1024;
  const BASE64_CHUNK = 4 * (RAW_CHUNK / 3);

  interface ChatAttachment {
    owner: ChatOwner;
    path: string;
    size: number;
    mimeType?: string;
    deleting: boolean;
    committed: boolean;
    /** The project of the connection that sent it (set on commit): only that project's connections may preview it. */
    root?: string;
  }

  const MAX_CHAT_PREVIEWS = 8;
  let activeChatPreviews = 0;
  const MAX_CHAT_SAVES = 3;
  let activeChatSaves = 0;

  const chatAttachments = new Map<string, ChatAttachment>();
  let chatAttachmentBytes = 0;
  let chatAttachmentCount = 0;
  let chatImageRoot: Promise<string> | undefined;

  async function createChatImageRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "keryx-chat-images-"));
    onRoot(dir);
    return dir;
  }

  async function getChatImageRoot(): Promise<string> {
    const pending = chatImageRoot ??= createChatImageRoot();
    try {
      return await pending;
    } catch (error) {
      if (chatImageRoot === pending) chatImageRoot = undefined;
      throw error;
    }
  }

  function decodedAttachmentSize(data: string): number {
    if (data.length % 4 !== 0 || data.length > 4 * Math.ceil(CHAT_IMAGE_BYTES / 3)) {
      throw new Error("Invalid or oversized attachment");
    }
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    const size = data.length / 4 * 3 - padding;
    if (size > CHAT_IMAGE_BYTES) throw new Error("Invalid or oversized attachment");
    return size;
  }

  async function decodeChatAttachment(data: string, size: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    for (let start = 0; start < data.length; start += BASE64_CHUNK) {
      const end = Math.min(start + BASE64_CHUNK, data.length);
      const chunk = data.slice(start, end);
      const decoded = Buffer.from(chunk, "base64");
      if ((end < data.length && chunk.endsWith("=")) || decoded.toString("base64") !== chunk) {
        throw new Error("Invalid attachment data");
      }
      decoded.copy(bytes, offset);
      offset += decoded.length;
      if (end < data.length) await yieldToLoop();
    }
    if (offset !== size) throw new Error("Invalid attachment data");
    return bytes;
  }

  function chatImageExtension(mimeType: unknown, bytes: Buffer): string {
    if (mimeType === "image/png" && bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a") return "png";
    if (mimeType === "image/jpeg" && bytes.subarray(0, 3).toString("hex") === "ffd8ff") return "jpg";
    if (mimeType === "image/gif" && /^(GIF87a|GIF89a)$/.test(bytes.subarray(0, 6).toString())) return "gif";
    if (mimeType === "image/webp" && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
    throw new Error("Unsupported or invalid pasted image");
  }

  type AttachmentTarget = { extension: string } | { mimeType: string };

  async function saveChatFile(owner: ChatOwner, { extension, data }: Json): Promise<string> {
    if (typeof extension !== "string" || !extension || extension.length > 12 || /[^a-z0-9]/i.test(extension)) {
      throw new Error("Invalid attachment extension");
    }
    return writeChatAttachment(owner, data, { extension });
  }

  async function saveChatImage(owner: ChatOwner, { mimeType, data }: Json): Promise<string> {
    if (typeof mimeType !== "string") throw new Error("Unsupported pasted image");
    return writeChatAttachment(owner, data, { mimeType });
  }

  function releaseChatReservation(size: number): void {
    chatAttachmentCount--;
    chatAttachmentBytes -= size;
  }

  async function removeChatFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  async function writeChatAttachment(owner: ChatOwner, data: unknown, target: AttachmentTarget): Promise<string> {
    if (activeChatSaves >= MAX_CHAT_SAVES) throw new Error("busy: Chat attachments are busy; try again");
    activeChatSaves++;
    try {
      return await writeChatAttachmentUncapped(owner, data, target);
    } finally {
      activeChatSaves--;
    }
  }

  async function writeChatAttachmentUncapped(owner: ChatOwner, data: unknown, target: AttachmentTarget): Promise<string> {
    if (typeof data !== "string") throw new Error("Invalid attachment data");
    const size = decodedAttachmentSize(data);
    if (chatAttachmentCount >= maxFiles || chatAttachmentBytes + size > maxBytes) {
      throw new Error("Temporary chat attachment storage is full. Remove drafts to free space or restart the dev bridge. Sent attachments are not removed automatically.");
    }
    chatAttachmentCount++;
    chatAttachmentBytes += size;

    let created: string | undefined;
    try {
      const bytes = await decodeChatAttachment(data, size);
      const mimeType = "mimeType" in target ? target.mimeType : undefined;
      const extension = "extension" in target ? target.extension : chatImageExtension(mimeType, bytes);
      const path = join(await getChatImageRoot(), `${mimeType ? "image" : "file"}-${randomUUID()}.${extension}`);
      const file = await open(path, "wx", 0o600);
      created = path; // Never unlink a path if exclusive creation failed.
      try {
        await file.writeFile(bytes);
      } finally {
        await file.close();
      }
      // No await between this check and set(): the close handler cannot miss this entry. If the
      // connection closed during the save, throwing here makes the catch unlink the file and release quota.
      if (owner.closed) throw new Error("Connection closed before the attachment was saved");
      chatAttachments.set(path, { owner, path, size, mimeType, deleting: false, committed: false });
      return path;
    } catch (error) {
      try {
        if (created) await removeChatFile(created);
        releaseChatReservation(size);
      } catch (cleanupError) {
        // A possible leftover remains charged until process exit.
        throw new Error("Could not save or clean up chat attachment", {
          cause: new AggregateError([error, cleanupError]),
        });
      }
      throw new Error("Could not save chat attachment", { cause: error });
    }
  }

  async function discardChatAttachment(owner: ChatOwner, path: unknown): Promise<null> {
    const entry = typeof path === "string" ? chatAttachments.get(path) : undefined;
    if (!entry || entry.owner !== owner || entry.deleting) {
      throw new Error("Chat attachment is not available to this connection");
    }
    entry.deleting = true;
    try {
      await removeChatFile(entry.path);
    } catch (error) {
      entry.deleting = false;
      throw new Error("Could not discard chat attachment", { cause: error });
    }
    chatAttachments.delete(entry.path);
    releaseChatReservation(entry.size);
    return null;
  }

  function commitChatAttachments(owner: ChatOwner, paths: unknown, root: string | null): null {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== "string")) {
      throw new Error("Invalid attachment paths");
    }
    const entries: ChatAttachment[] = [];
    for (const path of paths as string[]) {
      const entry = chatAttachments.get(path);
      if (!entry || entry.owner !== owner || entry.deleting || owner.closed || (entry.committed && entry.root !== (root ?? undefined))) {
        throw new Error("Chat attachment is not available to this connection");
      }
      entries.push(entry);
    }
    for (const entry of entries) {
      if (entry.committed) continue;
      entry.committed = true;
      entry.root = root ?? undefined;
    }
    return null;
  }

  /** Mark the connection closed and delete its uncommitted (draft) files, releasing their quota. */
  async function cleanupChatOwner(owner: ChatOwner): Promise<void> {
    owner.closed = true;
    const drafts = [...chatAttachments.values()].filter((e) => e.owner === owner && !e.committed && !e.deleting);
    await Promise.all(
      drafts.map(async (entry) => {
        entry.deleting = true;
        try {
          await removeChatFile(entry.path);
        } catch {
          entry.deleting = false; // leftover stays charged until process exit
          return;
        }
        chatAttachments.delete(entry.path);
        releaseChatReservation(entry.size);
      }),
    );
  }

  async function previewChatImage(entry: ChatAttachment, mimeType: string): Promise<string> {
    const file = await open(entry.path, "r");
    const bytes = Buffer.allocUnsafe(entry.size + 1);
    let size = 0;
    try {
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
    } finally {
      await file.close();
    }
    if (size !== entry.size) throw new Error("The chat image has changed");
    const chunks: string[] = [];
    for (let start = 0; start < size; start += RAW_CHUNK) {
      const end = Math.min(start + RAW_CHUNK, size);
      chunks.push(bytes.toString("base64", start, end));
      if (end < size) await yieldToLoop();
    }
    return `data:${mimeType};base64,${chunks.join("")}`;
  }

  async function localImage(owner: ChatOwner, root: string | null, path: unknown): Promise<string> {
    const entry = typeof path === "string" ? chatAttachments.get(path) : undefined;
    // A draft is owner-only; a sent attachment may be previewed from any connection of the same project.
    const sameProject = entry?.committed === true && entry.root !== undefined && entry.root === root;
    if (!root || !entry?.mimeType || entry.deleting || (entry.owner !== owner && !sameProject)) {
      throw new Error("The chat image is no longer available");
    }
    if (activeChatPreviews >= MAX_CHAT_PREVIEWS) throw new Error("busy: Chat attachments are busy; try again");
    activeChatPreviews++;
    try {
      return await previewChatImage(entry, entry.mimeType);
    } finally {
      activeChatPreviews--;
    }
  }

  return { saveChatFile, saveChatImage, discardChatAttachment, commitChatAttachments, cleanupChatOwner, localImage };
}
