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

type Side = Bun.Socket<PeerHolder>;

interface PeerHolder {
  peer?: Side;
  /** Bytes read from this side before its peer (the unix leg) was connected. */
  pending?: Buffer[];
  /** Bytes queued to WRITE to this side because its socket buffer was full (Bun does not buffer a partial write). */
  out: Buffer[];
  /** This side was told to close while `out` still held bytes: end once `out` drains. */
  endWhenDrained?: boolean;
  /** This side has closed or errored. */
  closed?: boolean;
}

/** Copy: Bun may reuse the buffer behind a `data` chunk once the handler returns. */
function copyOf(chunk: Uint8Array): Buffer {
  return Buffer.from(chunk);
}

/**
 * Write `chunk` to `to`, which read it from `from`. Bun's `socket.write` returns how many
 * bytes it accepted and drops the rest, so the unwritten remainder is queued on `to` and
 * `from` is paused until `to`'s `drain` flushes it - bytes are neither lost nor buffered
 * without bound.
 */
function relay(to: Side, from: Side, chunk: Uint8Array): void {
  if (to.data.out.length > 0) {
    to.data.out.push(copyOf(chunk));
    from.pause();
    return;
  }
  const written = to.write(chunk);
  if (written < 0) {
    from.end();
    return;
  }
  if (written < chunk.byteLength) {
    to.data.out.push(copyOf(chunk.subarray(written)));
    from.pause();
  }
}

/** Flush `sock`'s queue; resume its peer once empty, and honour a close requested meanwhile. */
function drain(sock: Side): void {
  const queue = sock.data.out;
  while (queue.length > 0) {
    const head = queue[0]!;
    const written = sock.write(head);
    if (written < 0) {
      queue.length = 0;
      break;
    }
    if (written < head.byteLength) {
      queue[0] = head.subarray(written);
      return;
    }
    queue.shift();
  }
  if (sock.data.endWhenDrained) sock.end();
  else sock.data.peer?.resume();
}

/** Close `sock` after everything queued for it has been written. */
function finish(sock: Side | undefined): void {
  if (!sock) return;
  if (sock.data.out.length > 0) sock.data.endWhenDrained = true;
  else sock.end();
}

/** Start the forwarder. Every accepted TCP connection dials a FRESH unix connection - no connection pooling, no multiplexing, matching a blind relay 1:1. */
export function runForwarder(opts: RunForwarderOptions): RunningForwarder {
  const host = opts.host ?? "127.0.0.1";

  const server = Bun.listen<PeerHolder>({
    hostname: host,
    port: opts.port,
    socket: {
      open(tcpSocket) {
        tcpSocket.data = { pending: [], out: [] };
        const dial = (): void => {
          Bun.connect<PeerHolder>({
            unix: opts.unixSocketPath,
            socket: {
              open(unixSocket) {
                unixSocket.data = { out: [] };
                if (tcpSocket.data.closed) {
                  // The client left before the unix leg opened: nothing to relay to.
                  unixSocket.end();
                  return;
                }
                unixSocket.data.peer = tcpSocket;
                tcpSocket.data.peer = unixSocket;
                const pending = tcpSocket.data.pending ?? [];
                tcpSocket.data.pending = [];
                for (const chunk of pending) relay(unixSocket, tcpSocket, chunk);
              },
              data(unixSocket, chunk) {
                const peer = unixSocket.data.peer;
                if (peer) relay(peer, unixSocket, chunk);
              },
              drain,
              close(unixSocket) {
                unixSocket.data.closed = true;
                finish(unixSocket.data.peer);
              },
              error(unixSocket) {
                unixSocket.data.closed = true;
                finish(unixSocket.data.peer);
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
        if (peer) relay(peer, tcpSocket, chunk);
        else (tcpSocket.data.pending ??= []).push(copyOf(chunk));
      },
      drain,
      close(tcpSocket) {
        tcpSocket.data.closed = true;
        finish(tcpSocket.data.peer);
      },
      error(tcpSocket) {
        tcpSocket.data.closed = true;
        finish(tcpSocket.data.peer);
      },
    },
  });

  opts.onReady?.();
  return {
    port: server.port,
    stop: () => server.stop(true),
  };
}
