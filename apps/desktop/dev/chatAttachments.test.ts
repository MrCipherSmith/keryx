import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createChatAttachmentStore } from "./chatAttachments";

test("a full store declines new saves without losing a sent image", async () => {
  const owner = { closed: false };
  const other = { closed: false };
  const image = { mimeType: "image/png", data: "iVBORw0KGgo=" };
  let dir: string | undefined;
  const store = createChatAttachmentStore({ maxFiles: 1, onRoot: (path) => { dir = path; } });
  try {
    const sent = await store.saveChatImage(owner, image);
    store.commitChatAttachments(owner, [sent], "/project/a");
    store.commitChatAttachments(owner, [sent], "/project/a");
    expect(() => store.commitChatAttachments(owner, [sent], "/project/b")).toThrow("not available");
    await expect(store.saveChatImage(other, image)).rejects.toThrow("storage is full");
    expect(await store.localImage(other, "/project/a", sent)).toBe(`data:image/png;base64,${image.data}`);
    await expect(store.localImage(other, "/project/b", sent)).rejects.toThrow("no longer available");
  } finally { if (dir) await rm(dir, { recursive: true, force: true }); }
});
