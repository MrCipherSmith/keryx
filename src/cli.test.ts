import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import path from "node:path";

test("dash alias is advertised in CLI help", async () => {
  const cliPath = path.join(import.meta.dir, "cli.ts");
  const output = await runBun([cliPath, "--help"]);

  expect(output).toContain("gd-metapro dash");
  expect(output).toContain("dash      Rebuild and open .metaproject/gd-metapro-dashboard.html");
});

function runBun(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: path.join(import.meta.dir, ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `bun exited with ${code}`));
    });
  });
}
