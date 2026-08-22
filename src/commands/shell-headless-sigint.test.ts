// SESS-09 (0.2.55 live-testing campaign, flow 198): a headless/piped
// `keryx shell` process (stdin is not a TTY, e.g. `printf ... | keryx shell`)
// did not exit on a single SIGINT — confirmed live, still alive 15+ seconds
// later — while SIGTERM exited immediately. That's an interactive readline
// "press again to confirm exit" trap firing on a process that can never
// supply the confirming second signal. `shellCommand` (`shell.ts`) now
// installs an immediate-exit SIGINT handler specifically when
// `!process.stdin.isTTY`. This test spawns a real, piped `keryx shell`
// process and asserts SIGINT alone is enough to end it promptly — no real
// provider call is needed, since the SIGINT handler is installed at readline
// setup, before any model dispatch.
import { expect, test } from "bun:test";
import path from "node:path";

const cli = path.join(import.meta.dir, "..", "cli.ts");

test("a headless (piped) keryx shell process exits promptly on a single SIGINT", async () => {
  const child = Bun.spawn([process.execPath, cli, "shell", "--no-tui"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  // Give the process a moment to reach the readline setup (where the SIGINT
  // handler is installed) before signaling — matches the live repro's own
  // timing (signals sent seconds after launch, not instantly at spawn).
  await new Promise((resolve) => setTimeout(resolve, 500));
  child.kill("SIGINT");
  const exited = await Promise.race([
    child.exited.then(() => "exited" as const),
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  if (exited === "timeout") {
    child.kill("SIGKILL"); // don't leak the process even if the assertion below fails
  }
  expect(exited).toBe("exited");
});
