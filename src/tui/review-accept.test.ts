import { expect, test } from "bun:test";
import type { CommandRunner } from "../harness/tool/builtin/shell-exec-tool";
import { acceptProposalViaShell, declineProposalViaShell } from "./review-accept";

function fakeRunner(byPrefix: Record<string, { output: string; isError: boolean }>): {
  run: CommandRunner;
  calls: string[];
} {
  const calls: string[] = [];
  const run: CommandRunner = async (command) => {
    calls.push(command);
    for (const [prefix, result] of Object.entries(byPrefix)) {
      if (command.startsWith(prefix)) {
        return result;
      }
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { run, calls };
}

test("mints a token then spends it — two distinct commands, in order", async () => {
  const { run, calls } = fakeRunner({
    "keryx workspace confirm-review": {
      output: JSON.stringify({ token: "tok-123", expiresAt: "2026-08-16T00:05:00.000Z" }),
      isError: false,
    },
    "keryx workspace review": { output: JSON.stringify({ status: "accepted" }), isError: false },
  });
  const outcome = await acceptProposalViaShell(run, "ws-1", "proposal-abc");
  expect(outcome).toEqual({ ok: true });
  expect(calls).toHaveLength(2);
  expect(calls[0]).toBe("keryx workspace confirm-review 'ws-1' 'proposal-abc'");
  expect(calls[1]).toBe(
    "keryx workspace review 'ws-1' 'proposal-abc' --decision accepted --confirm-token 'tok-123'",
  );
});

test("single-quotes every interpolated value, even one containing a quote", async () => {
  const { run, calls } = fakeRunner({
    "keryx workspace confirm-review": { output: JSON.stringify({ token: "a'b" }), isError: false },
    "keryx workspace review": { output: "{}", isError: false },
  });
  await acceptProposalViaShell(run, "ws it's-1", "proposal-abc");
  expect(calls[0]).toBe("keryx workspace confirm-review 'ws it'\\''s-1' 'proposal-abc'");
  expect(calls[1]).toContain("--confirm-token 'a'\\''b'");
});

test("a confirm-review failure stops before the second command and reports the output", async () => {
  const { run, calls } = fakeRunner({
    "keryx workspace confirm-review": { output: "no such workspace", isError: true },
  });
  const outcome = await acceptProposalViaShell(run, "ws-1", "proposal-abc");
  expect(outcome).toEqual({ ok: false, message: "no such workspace" });
  expect(calls).toHaveLength(1);
});

test("unparseable confirm-review output is reported, never thrown", async () => {
  const { run } = fakeRunner({
    "keryx workspace confirm-review": { output: "not json", isError: false },
  });
  const outcome = await acceptProposalViaShell(run, "ws-1", "proposal-abc");
  expect(outcome.ok).toBe(false);
  expect(outcome.ok === false && outcome.message).toContain("could not parse");
});

test("a review failure after a successful mint is reported", async () => {
  const { run } = fakeRunner({
    "keryx workspace confirm-review": { output: JSON.stringify({ token: "tok-1" }), isError: false },
    "keryx workspace review": { output: "confirm token expired", isError: true },
  });
  const outcome = await acceptProposalViaShell(run, "ws-1", "proposal-abc");
  expect(outcome).toEqual({ ok: false, message: "confirm token expired" });
});

test("decline runs exactly one command — no confirm-token mint step, unlike accept", async () => {
  const { run, calls } = fakeRunner({
    "keryx workspace review": { output: JSON.stringify({ event: { toStatus: "rejected" } }), isError: false },
  });
  const outcome = await declineProposalViaShell(run, "ws-1", "proposal-abc");
  expect(outcome).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBe("keryx workspace review 'ws-1' 'proposal-abc' --decision rejected");
});

test("decline single-quotes every interpolated value", async () => {
  const { run, calls } = fakeRunner({
    "keryx workspace review": { output: "{}", isError: false },
  });
  await declineProposalViaShell(run, "ws it's-1", "proposal-abc");
  expect(calls[0]).toBe("keryx workspace review 'ws it'\\''s-1' 'proposal-abc' --decision rejected");
});

test("a decline command failure is reported, never thrown", async () => {
  const { run } = fakeRunner({
    "keryx workspace review": { output: "proposal already has a terminal transition", isError: true },
  });
  const outcome = await declineProposalViaShell(run, "ws-1", "proposal-abc");
  expect(outcome).toEqual({ ok: false, message: "proposal already has a terminal transition" });
});
