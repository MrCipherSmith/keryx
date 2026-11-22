import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { consumeChannelToken, stageChannelToken } from "./channel-staging";

test("staged credential is private, opaque and consumed once", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "channel-stage-"));
  try {
    const token = "123456:abcdefghijklmnopqrstuv";
    const staged = stageChannelToken(token, dir);
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(staged.value).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(path.join(dir, "remote", "staged", staged.value)).mode & 0o777).toBe(0o600);
    expect(consumeChannelToken(staged.value, dir)).toEqual({ ok: true, value: token });
    expect(consumeChannelToken(staged.value, dir).ok).toBe(false);
    expect(consumeChannelToken("../config.json", dir).ok).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
