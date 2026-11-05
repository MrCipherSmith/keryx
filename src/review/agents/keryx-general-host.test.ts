import { expect, test } from "bun:test";
import { createKeryxExternalGeneralHost } from "../../commands/review-agents-runtime/keryx-general-host";

test("production host rejects mismatched provider preflight before advertising an adapter", async () => {
  let controllerReads = 0;
  await expect(createKeryxExternalGeneralHost({
    runId: "run-1",
    runDir: "/path/that/must/not/be-read",
    configDir: "/path/that/must/not/be-read",
    provider: "openai-codex",
    model: "gpt-test",
    compileInstructions: () => "trusted",
    preflightProvider: async () => ({
      provider: "different-provider",
      model: "gpt-test",
      authenticatedAt: "2026-11-05T00:00:00.000Z",
      hostPreparedCredential: true,
    }),
    controller: () => { controllerReads += 1; return undefined; },
    authorize: () => true,
    grantTtlMs: 60_000,
    grantStore: { load: () => [], save: () => undefined },
  })).rejects.toThrow("preflight did not return valid");
  expect(controllerReads).toBe(0);
});
