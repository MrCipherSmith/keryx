import { test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
test("Project Settings lists, adds (folder picker) and removes linked projects through keryx ref", () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../test/linked-projects.fixture.tsx", import.meta.url))], { timeout: 10000, stdio: "pipe" });
});
