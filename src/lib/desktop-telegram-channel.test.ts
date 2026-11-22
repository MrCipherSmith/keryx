import { expect, test } from "bun:test";
import { desktopTelegramChannel, readDesktopChannelRequest } from "./desktop-telegram-channel";

test("rejects unrecognised fields and oversized stdin without reflecting content", async () => {
  expect(await desktopTelegramChannel({ action: "begin", token: "secret", expectedRevision: null, extra: true })).toEqual({ ok: false, code: "invalid" });
  expect(await readDesktopChannelRequest((async function* () { yield '{"action":"status"}'; })())).toEqual({ action: "status" });
  await expect(readDesktopChannelRequest((async function* () { yield "x".repeat(16_385); })())).rejects.toThrow("Invalid channel request.");
});
