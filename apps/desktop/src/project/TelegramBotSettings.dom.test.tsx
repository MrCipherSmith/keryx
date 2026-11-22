import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Telegram pairing keeps credentials transient and gates activation", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../test/telegram-bot-settings.fixture.tsx", import.meta.url))], { timeout: 10000, stdio: "pipe" });
});
