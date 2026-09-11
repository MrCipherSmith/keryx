// The loopback callback — AC6 through AC10.
//
// Driven against a REAL listener on a real socket, because every
// property here is about what a network peer can do, and a stubbed
// server proves things about the stub.

import { afterEach, describe, expect, test } from "bun:test";
import {
  LOOPBACK_HOST,
  startCallbackListener,
  type CallbackListener,
  type CallbackResult,
} from "./oauth-callback";

const open: CallbackListener[] = [];
afterEach(() => {
  for (const listener of open.splice(0)) listener.close();
});

function listen(timeoutMs = 10_000): CallbackListener {
  const listener = startCallbackListener({ timeoutMs });
  open.push(listener);
  return listener;
}

/**
 * The listener's result, or the fact that it never produced one.
 *
 * A bare `await listener.result` HANGS when the listener is broken in
 * the direction of never settling, and two mutants do exactly that —
 * inverting the `state` check, and making the "no code" guard always
 * true. Both wedged the whole mutation run rather than failing a test,
 * which is the sweep reporting that these tests lack a deadline of
 * their own. Now they say "never settled" and the assertion fails.
 */
async function resultOf(listener: CallbackListener): Promise<CallbackResult | "never settled"> {
  return await Promise.race([
    listener.result,
    new Promise<"never settled">((resolve) => {
      const timer = setTimeout(() => resolve("never settled"), 3_000);
      timer.unref?.();
    }),
  ]);
}

describe("AC6 — the listener is reachable only from this machine", () => {
  test("it binds 127.0.0.1, not every interface", () => {
    // A callback on 0.0.0.0 offers the authorisation code to whoever
    // shares the network: a coffee-shop wifi, a shared CI runner, a
    // container host. Asserted on the URL the flow will actually hand
    // to the authorisation server.
    const listener = listen();
    expect(listener.redirectUrl.startsWith(`http://${LOOPBACK_HOST}:`)).toBe(true);
    expect(listener.redirectUrl).not.toContain("0.0.0.0");
    expect(listener.redirectUrl).not.toContain("localhost");
  });

  test("and on an ephemeral port, so two flows cannot collide", () => {
    const a = listen();
    const b = listen();
    expect(a.redirectUrl).not.toBe(b.redirectUrl);
  });
});

describe("AC7 — a redirect from somewhere else is not accepted", () => {
  test("the happy path first, so the rejections below mean something", async () => {
    const listener = listen();
    const response = await fetch(`${listener.redirectUrl}?code=the-code&state=${listener.state}`);
    expect(response.status).toBe(200);
    expect(await resultOf(listener)).toEqual({ ok: true, code: "the-code" });
  });

  test("a WRONG state is refused and does not end the flow", async () => {
    // Not settled: a stray request must not cancel the operator's
    // authorisation, or anyone who can reach the port has a denial of
    // service. The real browser can still arrive.
    const listener = listen();
    const bad = await fetch(`${listener.redirectUrl}?code=stolen&state=not-the-state`);
    expect(bad.status).toBe(400);

    const good = await fetch(`${listener.redirectUrl}?code=real&state=${listener.state}`);
    expect(good.status).toBe(200);
    expect(await resultOf(listener)).toEqual({ ok: true, code: "real" });
  });

  test("a MISSING state is refused too", async () => {
    const listener = listen();
    expect((await fetch(`${listener.redirectUrl}?code=stolen`)).status).toBe(400);
    const good = await fetch(`${listener.redirectUrl}?code=real&state=${listener.state}`);
    expect(good.status).toBe(200);
  });

  test("the state is unguessable, not a counter", () => {
    // A predictable state is no state at all.
    const a = listen().state;
    const b = listen().state;
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(32);
  });
});

describe("AC8 — the listener answers once", () => {
  test("a replay after the flow completed reaches nothing", async () => {
    const listener = listen();
    const first = await fetch(`${listener.redirectUrl}?code=real&state=${listener.state}`);
    expect(first.status).toBe(200);
    expect(await resultOf(listener)).toEqual({ ok: true, code: "real" });

    // The code is single-use at the authorisation server, but a
    // listener that stays open is a second chance for anything local
    // that read the code out of browser history.
    const replay = await fetch(`${listener.redirectUrl}?code=real&state=${listener.state}`).catch(
      () => ({ status: 0 }) as Response,
    );
    expect([410, 0]).toContain(replay.status);
  });

  test("and the FIRST code is the one kept", async () => {
    const listener = listen();
    await fetch(`${listener.redirectUrl}?code=first&state=${listener.state}`);
    await fetch(`${listener.redirectUrl}?code=second&state=${listener.state}`).catch(() => undefined);
    expect(await resultOf(listener)).toEqual({ ok: true, code: "first" });
  });
});

describe("AC9 — the authorisation server's own refusal is reported as itself", () => {
  test("?error=access_denied says access_denied", async () => {
    // Reporting this as a timeout would send the operator back to
    // retry something that will refuse them again for the same reason.
    const listener = listen();
    await fetch(`${listener.redirectUrl}?error=access_denied&state=${listener.state}`);
    const result = await listener.result;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("access_denied");
  });

  test("and the description is included when the server sends one", async () => {
    const listener = listen();
    await fetch(
      `${listener.redirectUrl}?error=invalid_scope&error_description=Scope%20not%20granted&state=${listener.state}`,
    );
    const result = await listener.result;
    if (!result.ok) {
      expect(result.reason).toContain("invalid_scope");
      expect(result.reason).toContain("Scope not granted");
    }
  });

  test("BOUNDARY — an error does NOT yield a code", async () => {
    const listener = listen();
    await fetch(`${listener.redirectUrl}?error=access_denied&state=${listener.state}`);
    const result = await listener.result;
    expect(result.ok).toBe(false);
  });

  test("a redirect with neither code nor error is refused", async () => {
    const listener = listen();
    expect((await fetch(`${listener.redirectUrl}?state=${listener.state}`)).status).toBe(400);
  });
});

describe("AC10 — the wait is bounded, with real margin", () => {
  test("an operator who never finishes gets the shell back, with a reason", async () => {
    // The budget is 300ms and the assertion allows 5s: two numbers
    // that are not the same number, because a threshold equal to the
    // budget passes whether or not the timeout fired.
    const started = Date.now();
    const listener = listen(300);
    const result = await listener.result;
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("never completed");
    expect(elapsed).toBeLessThan(5_000);
    expect(elapsed).toBeGreaterThanOrEqual(250);
  });

  test("BOUNDARY — a flow that DOES complete is not cut off by the timeout", async () => {
    // Without this, a listener that always timed out would pass the
    // test above.
    const listener = listen(10_000);
    await fetch(`${listener.redirectUrl}?code=in-time&state=${listener.state}`);
    expect(await resultOf(listener)).toEqual({ ok: true, code: "in-time" });
  });
});

describe("the budget is taken literally", () => {
  test("timeoutMs: 0 gives up at once rather than waiting five minutes", async () => {
    // `options.timeoutMs ?? CALLBACK_TIMEOUT_MS` must not become
    // `||`: zero is falsy, so `||` would silently replace an explicit
    // "do not wait" with the full five-minute default.
    const started = Date.now();
    const listener = listen(0);
    const result = await listener.result;
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe("what the browser is shown", () => {
  test("a real doctype, so the page is not rendered in quirks mode", async () => {
    // Invisible when wrong, which is why the mutation survived: a
    // malformed doctype renders the page in quirks mode, and a
    // one-paragraph confirmation comes out looking broken at the one
    // moment the operator is being asked to trust this flow.
    const listener = listen();
    const response = await fetch(`${listener.redirectUrl}?code=c&state=${listener.state}`);
    expect((await response.text()).startsWith("<!doctype html>")).toBe(true);
  });

  test("and on the refusal page too", async () => {
    const listener = listen();
    const response = await fetch(`${listener.redirectUrl}?code=c&state=wrong`);
    expect((await response.text()).startsWith("<!doctype html>")).toBe(true);
  });

  test("never the code, on any path", async () => {
    const listener = listen();
    const response = await fetch(`${listener.redirectUrl}?code=secret-code-value&state=${listener.state}`);
    const body = await response.text();
    expect(body).not.toContain("secret-code-value");
  });

  test("nor on the rejection path", async () => {
    const listener = listen();
    const response = await fetch(`${listener.redirectUrl}?code=secret-code-value&state=wrong`);
    expect(await response.text()).not.toContain("secret-code-value");
  });
});
