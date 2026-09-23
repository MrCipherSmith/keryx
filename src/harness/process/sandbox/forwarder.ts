// Flow 301 (AC5): the in-sandbox TCP<->unix forwarder.
//
// The unattended sandbox's `--unshare-net` netns has only its own private `lo` (see
// `unattended.ts`'s header) — it cannot reach the host's TCP loopback at all, so the
// domain-allowlisting proxy the dispatcher runs OUTSIDE the sandbox is reachable only
// through a UNIX socket bind-mounted in. Most HTTP(S)_PROXY-speaking tools (curl, git,
// npm, pip, …) cannot dial a unix-socket proxy directly — only curl's own
// `--unix-socket` flag can — so something inside the sandbox has to bridge TCP to that
// socket. `socat` is not reliably present inside the sandbox's toolchain roots, so this
// is a small bun-native bridge instead, shipped as a hidden keryx subcommand
// (`src/commands/sandbox-net-forward.ts`) rather than a standalone script: a compiled
// `keryx` binary has no `.ts` file bwrap could exec (`keryxInvocation()` in
// `trigger-dispatch.ts` already solves re-invoking THIS keryx from inside a sandbox for
// exactly that reason).
//
// Verified against a real `bwrap --unshare-net` sandbox during flow 301's research: a
// first version dropped the client's first TCP chunk, because it arrived before the
// async `Bun.connect` to the unix socket resolved — curl writes its request line the
// instant `connect()` returns, racing ahead of the unix leg. That is a real,
// reproduced hang (a proxied request timing out with zero bytes), not a hypothetical;
// the fix is the `pending` buffer below, flushed once the unix leg opens.

export interface RunForwarderOptions {
  readonly port: number;
  readonly unixSocketPath: string;
  /** Bind host. Default `127.0.0.1` (the sandbox's own private loopback). */
  readonly host?: string;
  /** Called once the TCP listener is bound — the signal `wrap()`'s readiness FIFO needs. */
  readonly onReady?: () => void;
  /**
   * Test seam only: delay dialing the unix leg by this many ms after a TCP client
   * connects, to make the pre-connect-buffering race above deterministic in a test
   * (same-process event-loop timing does not reliably reproduce it on its own —
   * `Bun.connect` to a local unix socket can resolve within the same tick a real
   * cross-process client's write would arrive after). Never set in production.
   */
  readonly testDelayUnixConnectMs?: number;
}

export interface RunningForwarder {
  readonly port: number;
  stop(): void;
}

interface PeerHolder {
  peer?: { write(data: Uint8Array): void; end(): void };
  pending?: Buffer[];
}

/** Start the forwarder. Every accepted TCP connection dials a FRESH unix connection — no connection pooling, no multiplexing, matching a blind relay 1:1. */
export function runForwarder(opts: RunForwarderOptions): RunningForwarder {
  const host = opts.host ?? "127.0.0.1";

  const server = Bun.listen<PeerHolder>({
    hostname: host,
    port: opts.port,
    socket: {
      open(tcpSocket) {
        tcpSocket.data = { pending: [] };
        const dial = (): void => {
          Bun.connect<PeerHolder>({
            unix: opts.unixSocketPath,
            socket: {
              open(unixSocket) {
                unixSocket.data = { peer: tcpSocket };
                tcpSocket.data.peer = unixSocket;
                for (const chunk of tcpSocket.data.pending ?? []) unixSocket.write(chunk);
                tcpSocket.data.pending = [];
              },
              data(unixSocket, chunk) {
                unixSocket.data.peer?.write(chunk);
              },
              close(unixSocket) {
                unixSocket.data.peer?.end();
              },
              error(unixSocket) {
                unixSocket.data.peer?.end();
              },
            },
          }).catch(() => {
            tcpSocket.end();
          });
        };
        if (opts.testDelayUnixConnectMs !== undefined && opts.testDelayUnixConnectMs > 0) {
          setTimeout(dial, opts.testDelayUnixConnectMs);
        } else {
          dial();
        }
      },
      data(tcpSocket, chunk) {
        const peer = tcpSocket.data.peer;
        if (peer) peer.write(chunk);
        else (tcpSocket.data.pending ??= []).push(Buffer.from(chunk));
      },
      close(tcpSocket) {
        tcpSocket.data.peer?.end();
      },
      error(tcpSocket) {
        tcpSocket.data.peer?.end();
      },
    },
  });

  opts.onReady?.();
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
