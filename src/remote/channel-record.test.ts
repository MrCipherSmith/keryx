import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveBotToken, saveRemoteConfig } from "./config";
import { commitChannelRecord, disconnectChannelRecord, loadChannelRecord, migrateLegacyChannelRecord } from "./channel-record";

const dirs: string[] = [];
const dir = (): string => { const value = mkdtempSync(path.join(tmpdir(), "channel-record-")); dirs.push(value); return value; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const token = "123456:abcdefghijklmnopqrstuv";
const config = { schemaVersion: 1 as const, chatId: -42, allowedUserIds: [12], orphanMs: 1234, runTimeoutMs: 0, permissionMode: "ask" as const, approvalTimeoutMs: 30000, rendering: "plain" as const };

describe("channel record", () => {
  test("migrates full legacy config once and tombstone prevents resurrection", async () => {
    const d = dir();
    expect(saveBotToken(token, d).ok).toBe(true);
    expect(saveRemoteConfig(config, d).ok).toBe(true);
    const migrated = await migrateLegacyChannelRecord(d);
    expect(migrated.ok && migrated.value?.state).toBe("connected");
    expect(migrated.ok && migrated.value?.state === "connected" && migrated.value.config).toEqual(config);
    expect(await disconnectChannelRecord(1, d)).toEqual({ ok: true, value: { schemaVersion: 1, revision: 2, state: "disconnected" } });
    expect((await migrateLegacyChannelRecord(d))).toEqual(loadChannelRecord(d));
    const file = path.join(d, "remote", "channel.json");
    expect(readFileSync(file, "utf8")).not.toContain(token);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
  test("concurrent writes use revision CAS", async () => {
    const d = dir();
    const candidate = { token, bot: { id: 123456, username: "example_bot" }, config };
    const [a, b] = await Promise.all([commitChannelRecord(null, candidate, d), commitChannelRecord(null, candidate, d)]);
    expect([a, b].filter((result) => result.ok)).toHaveLength(1);
    expect([a, b].filter((result) => !result.ok && "code" in result && result.code === "conflict")).toHaveLength(1);
    expect(loadChannelRecord(d).ok).toBe(true);
  });
});

test("the operation fence is checked inside the revision lock", async () => {
  const d = dir();
  let checks = 0;
  const candidate = { token, bot: { id: 123456 }, config };
  const result = await commitChannelRecord(null, candidate, d, () => { checks += 1; return false; });
  expect(checks).toBe(1);
  expect(result.ok).toBe(false);
  expect(loadChannelRecord(d)).toEqual({ ok: true, value: null });
});
