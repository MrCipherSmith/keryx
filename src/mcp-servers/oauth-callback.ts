// The loopback listener that catches the authorisation redirect.
//
// P3b. The authorisation server sends the operator's browser back to
// `http://127.0.0.1:<port>/callback?code=…&state=…`, and this is what
// is listening. It exists for about the length of one browser
// round trip and holds, briefly, the single most valuable string in
// the flow.
//
// Every property below is a way that string gets taken:
//
//   - BIND 127.0.0.1, never 0.0.0.0. A callback on every interface is
//     an authorisation code offered to whoever is on the network —
//     a coffee-shop wifi, a shared CI runner, a container host. The
//     bound address is asserted, not assumed from the intent.
//
//   - VALIDATE `state`. Without it any page the operator visits can
//     drive their browser to this port with a code the attacker
//     obtained, and keryx exchanges it and stores the attacker's token
//     as the operator's. That is CSRF against the token store.
//
//   - SERVE ONCE. The code is single-use at the authorisation server,
//     but a listener that stays open is a second chance for anything
//     local to replay a code it read from the browser's history.
//
//   - BOUND THE WAIT. An operator who closes the tab must get their
//     shell back with a reason, not a process that waits forever.

import { randomBytes, timingSafeEqual } from "node:crypto";

export type CallbackResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

export type CallbackListener = {
  /** Where the authorisation server must redirect. Always loopback. */
  readonly redirectUrl: string;
  /**
   * The address actually bound, read back from the running server.
   *
   * Exposed because `redirectUrl` cannot carry AC6. Both are built
   * from `LOOPBACK_HOST`, so a test asserting the URL asserts the
   * constant against itself: changing the `hostname` passed to
   * `serve` to `0.0.0.0` left all 19 callback tests green. What keryx
   * advertises and where it listens are two facts, and only this one
   * is the security property.
   */
  readonly boundHost: string;
  /** The `state` this listener will accept, and only this one. */
  readonly state: string;
  /** Resolves once, when the browser arrives or the budget runs out. */
  readonly result: Promise<CallbackResult>;
  /** Idempotent; safe to call after `result` settles. */
  readonly close: () => void;
};

/**
 * Compare the presented `state` without leaking its length or prefix
 * through timing.
 *
 * Not because a remote timing oracle over Bun's HTTP parsing is a
 * demonstrated attack — it is not — but because this is a 32-byte
 * secret compared on every request to a port any local process can
 * reach, and the constant-time form costs nothing.
 */
function matchesState(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which is itself the
  // answer for a fixed-length secret.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Loopback only. Named so a future edit has to argue with the name. */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * How long the operator has to finish in the browser.
 *
 * Generous — a first-time consent screen can involve a login, an MFA
 * prompt and an org picker — and finite, because the alternative is a
 * shell that never comes back.
 */
export const CALLBACK_TIMEOUT_MS = 5 * 60_000;

/** What the browser shows once it has come back. No token, no code. */
function page(title: string, detail: string): string {
  return [
    "<!doctype html><meta charset=utf-8>",
    `<title>${title}</title>`,
    '<body style="font:14px system-ui;padding:3rem;max-width:34rem">',
    `<h1 style="font-size:1.1rem">${title}</h1>`,
    `<p>${detail}</p>`,
    "</body>",
  ].join("");
}

export type StartCallbackOptions = {
  readonly timeoutMs?: number;
  /** Injected in tests. Real `Bun.serve` otherwise. */
  readonly serve?: typeof Bun.serve;
};

/**
 * Start listening, and hand back where to redirect and what to wait on.
 *
 * The `state` is minted here rather than taken from the caller: it is
 * meaningful only if it is unguessable and if the same value is both
 * sent and checked, and making one function responsible for both
 * removes the way that goes wrong.
 */
export function startCallbackListener(options: StartCallbackOptions = {}): CallbackListener {
  const state = randomBytes(32).toString("base64url");
  const timeoutMs = options.timeoutMs ?? CALLBACK_TIMEOUT_MS;
  const serve = options.serve ?? Bun.serve;

  let settle: (result: CallbackResult) => void = () => {};
  const result = new Promise<CallbackResult>((resolve) => {
    settle = resolve;
  });

  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const server = serve({
    hostname: LOOPBACK_HOST,
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);

      // SERVE ONCE. After the first answer this listener has done its
      // job; anything further is a replay, and it is told so rather
      // than being handed another chance.
      if (done) {
        return new Response(page("Already handled", "This authorisation was already completed."), {
          status: 410,
          headers: { "content-type": "text/html" },
        });
      }

      // STATE FIRST, BEFORE ANYTHING THAT SETTLES.
      //
      // The error branch used to run above this check, and settling on
      // an unauthenticated request is a denial of service: any page
      // the operator visits while `keryx mcp auth` is waiting can
      // `<img src="http://127.0.0.1:PORT/callback?error=access_denied">`
      // across the ephemeral range — a plain cross-origin GET, no
      // preflight, no knowledge of `state` needed — and abort an
      // authorisation it knows nothing about. Any local process can do
      // it directly by reading the port from /proc/net/tcp.
      //
      // The comment below said this must not happen while the code
      // three lines above did it.
      const given = url.searchParams.get("state");
      if (!matchesState(given, state)) {
        // NOT settled. A wrong `state` is somebody else's redirect, and
        // ending the operator's flow because a stray request arrived
        // would be a denial of service with extra steps. The real
        // browser can still arrive.
        return new Response(page("Not this flow", "This request did not come from the authorisation keryx started."), {
          status: 400,
          headers: { "content-type": "text/html" },
        });
      }

      const error = url.searchParams.get("error");
      if (error !== null) {
        // The authorisation server said no. Reported as THAT, because
        // "timed out" would send the operator to retry something that
        // will refuse them again for the same reason.
        const description = url.searchParams.get("error_description");
        done = true;
        settle({ ok: false, reason: description === null ? error : `${error}: ${description}` });
        return new Response(page("Authorisation refused", "You can close this tab and return to keryx."), {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      const code = url.searchParams.get("code");
      if (code === null || code === "") {
        return new Response(page("No code", "The authorisation server returned no code."), {
          status: 400,
          headers: { "content-type": "text/html" },
        });
      }

      done = true;
      settle({ ok: true, code });
      return new Response(page("Authorised", "keryx has what it needs. You can close this tab."), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  });

  const close = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    try {
      server.stop(true);
    } catch {
      // Already stopped. The caller is closing, not diagnosing.
    }
  };

  timer = setTimeout(() => {
    if (done) return;
    done = true;
    settle({
      ok: false,
      reason: `no response within ${Math.round(timeoutMs / 1000)}s — the browser tab was never completed`,
    });
  }, timeoutMs);
  // Do not hold the process open on this timer alone.
  timer.unref?.();

  // Close AFTER the response has been written, not the instant the
  // promise settles. `settle` runs inside the fetch handler, so
  // force-stopping on it tore the socket down before the browser got
  // its page — every completing test failed with ECONNRESET while the
  // flow itself was working correctly. The operator would have seen a
  // browser error on a successful authorisation.
  void result.then(() => {
    const drain = setTimeout(close, 50);
    drain.unref?.();
  });

  return {
    redirectUrl: `http://${LOOPBACK_HOST}:${server.port}/callback`,
    // From the SERVER, not from the constant.
    boundHost: server.hostname ?? "",
    state,
    result,
    close,
  };
}
