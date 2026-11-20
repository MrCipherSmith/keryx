import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Settings tabs, drafts, closure and independent mode palettes work through the project UI", () => {
  const fixture = fileURLToPath(new URL("../test/settings-view.fixture.tsx", import.meta.url));
  execFileSync(process.execPath, [fixture], { timeout: 5000, stdio: "pipe" });
});
