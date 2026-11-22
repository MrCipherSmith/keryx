import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Telegram service settings respect ownership and setup consent", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../test/telegram-serve-settings.fixture.tsx", import.meta.url))], { timeout: 10000, stdio: "pipe" });
});
