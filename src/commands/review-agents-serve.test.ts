import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderPort } from "../harness/provider/types";
import type { ReviewV3Host, ReviewV3HostRuntime } from "../review/v3-host";
import type { ReviewV3TerminalHost } from "../review/v3-terminal-host";
import { runReviewV3ServeCommand } from "./review-agents-serve";

describe("review v3 serve", () => {
  test("requires explicit operator trust and cost posture", async () => {
    const errors: string[] = [];
    let constructed = false;
    const code = await runReviewV3ServeCommand([
      "--project", "/repo",
      "--provider", "offline",
      "--model", "model",
      "--config-dir", "/config",
      "--cost-mode", "cost-unknown",
    ], {
      makeProvider: () => { constructed = true; return {} as ProviderPort; },
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(constructed).toBeFalse();
    expect(errors[0]).toContain("--permission-mode is required");
  });

  test("starts a foreground local host without calling the provider", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-v3-serve-test-"));
    const logs: string[] = [];
    let providerCalls = 0;
    let closed = 0;
    let capturedRuntime: ReviewV3HostRuntime | undefined;
    let authorizedWhileOpen: boolean | void | undefined;
    const fakeProvider = {
      describe: () => ({ descriptor: { providerId: "offline" } }),
      stream: () => { providerCalls += 1; throw new Error("must stay offline"); },
    } as unknown as ProviderPort;
    const fakeHost = { close: async () => ({ stopped: true, activeRunIds: [] }) } as unknown as ReviewV3Host;
    const terminal: ReviewV3TerminalHost = {
      socketPath: path.join(root, "controller.sock"),
      runsRoot: path.join(root, ".metaproject", "reviews", "v3"),
      token: "t".repeat(40),
      env: { KERYX_REVIEW_V3_ROOT_SOCKET: path.join(root, "controller.sock"), KERYX_REVIEW_V3_ROOT_TOKEN: "t".repeat(40) },
      close: async () => { closed += 1; return { stopped: true, activeRunIds: [] }; },
    };
    const code = await runReviewV3ServeCommand([
      "--project", root,
      "--provider", "offline",
      "--model", "model",
      "--config-dir", root,
      "--cost-mode", "cost-unknown",
      "--permission-mode", "trust",
    ], {
      makeProvider: () => fakeProvider,
      createHost: () => fakeHost,
      startHost: async (options) => { capturedRuntime = options.runtime; return terminal; },
      waitForStop: async () => {
        authorizedWhileOpen = await capturedRuntime?.authorizeReviewV3Action?.({
          runId: "run-1", dispatchId: "dispatch-1", operation: "model",
        });
      },
      log: (line) => logs.push(line),
    });
    expect(code).toBe(0);
    expect(providerCalls).toBe(0);
    expect(closed).toBe(1);
    expect(capturedRuntime?.providerId).toBe("offline");
    expect(capturedRuntime?.io?.()?.permissionMode?.()).toBe("trust");
    expect(authorizedWhileOpen).toBeTrue();
    expect(await capturedRuntime?.authorizeReviewV3Action?.({
      runId: "run-1", dispatchId: "dispatch-1", operation: "tool",
    })).toBeFalse();
    const descriptor = JSON.parse(logs[0]!) as Record<string, unknown>;
    expect(descriptor.socketPath).toBe(terminal.socketPath);
    expect(descriptor.bearerToken).toBe(terminal.token);
    expect(descriptor.permissionMode).toBe("trust");
    expect(descriptor.costMode).toBe("cost-unknown");
  });

  test("returns nonzero and reports durable active runs when shutdown is incomplete", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "review-v3-serve-test-"));
    const errors: string[] = [];
    const fakeProvider = { describe: () => ({ descriptor: { providerId: "offline" } }) } as unknown as ProviderPort;
    const terminal: ReviewV3TerminalHost = {
      socketPath: path.join(root, "controller.sock"),
      runsRoot: path.join(root, "runs"),
      token: "z".repeat(40),
      env: {},
      close: async () => ({ stopped: false, activeRunIds: ["run-1", "run-2"] }),
    };
    const code = await runReviewV3ServeCommand([
      "--project", root,
      "--provider", "offline",
      "--model", "model",
      "--config-dir", root,
      "--cost-mode", "cost-unknown",
      "--permission-mode", "trust",
    ], {
      makeProvider: () => fakeProvider,
      createHost: () => ({}) as unknown as ReviewV3Host,
      startHost: async () => terminal,
      waitForStop: async () => undefined,
      log: () => undefined,
      error: (line) => errors.push(line),
    });
    expect(code).toBe(1);
    expect(errors).toEqual([
      "review v3 serve shutdown incomplete; active runs: run-1, run-2; durable evidence and the local endpoint directory were preserved for shutdown retry",
    ]);
  });

  test("the source CLI exposes v3 and serve help without starting a provider", async () => {
    for (const args of [["review", "v3", "--help"], ["review", "v3", "serve", "--help"]]) {
      const processHandle = Bun.spawn([process.execPath, path.join(import.meta.dir, "../cli.ts"), ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("keryx review v3 serve --project <dir> [--runs-root <dir>]");
      expect(stdout).toContain("--cost-mode cost-unknown --permission-mode trust");
    }
  }, 20_000);
});
