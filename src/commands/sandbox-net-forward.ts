// Flow 301 (AC5): `keryx __sandbox-net-forward` — the hidden helper subcommand that
// runs the in-sandbox TCP<->unix forwarder (`../harness/process/sandbox/forwarder.ts`).
//
// Never called by an operator. `planUnattendedSandbox`'s `wrap()`
// (`../harness/process/sandbox/unattended.ts`) is the only caller, invoking it through
// `keryxInvocation().argv` (`./trigger-dispatch.ts`) so it works identically running
// from source (`bun <entry.ts> __sandbox-net-forward …`) and from a compiled `keryx`
// binary (`keryx __sandbox-net-forward …`) — a compiled binary has no `.ts` file bwrap
// could exec directly.
//
// Deliberately excluded from `docs/docs/cli-reference.md` — see `DOCUMENTED_ELSEWHERE`
// in `src/cli-reference-coverage.test.ts`, the place that argues CLI-surface coverage
// exceptions with a reason.

import { writeFileSync } from "node:fs";
import { optionValue } from "../lib/args";
import { runForwarder } from "../harness/process/sandbox/forwarder";

export async function sandboxNetForwardCommand(args: string[]): Promise<void> {
  const port = Number(optionValue(args, "--port"));
  const socket = optionValue(args, "--socket");
  const readyFifo = optionValue(args, "--ready-fifo");
  if (!Number.isInteger(port) || port <= 0 || socket === undefined) {
    console.error("keryx __sandbox-net-forward: internal helper — usage: --port <n> --socket <path> [--ready-fifo <path>]");
    process.exitCode = 1;
    return;
  }
  runForwarder({
    port,
    unixSocketPath: socket,
    onReady: () => {
      if (readyFifo === undefined) return;
      // Unblocks the wrapping shell script's `read` — the synchronization point
      // `unattended.ts`'s `wrap()` relies on so a client never connects before the TCP
      // listener is bound. Opening a FIFO for write blocks until a reader has it open
      // for read, so this line itself is where the handshake completes.
      try {
        writeFileSync(readyFifo, "ready\n");
      } catch {
        // best-effort — a missing/removed FIFO just means nothing is waiting
      }
    },
  });
  // Long-lived: this process runs until the sandbox's PID namespace tears down (the
  // bwrap invocation that started it exits), never returning on its own.
  await new Promise<void>(() => {});
}
