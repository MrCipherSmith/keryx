// The loopback callback — AC6 through AC10.
//
// Driven against a REAL listener on a real socket, because every
// property here is about what a network peer can do, and a stubbed
// server proves things about the stub.

import { afterEach, describe, expect, test } from "bun:test";
import { LOOPBACK_HOST, startCallbackListener, type CallbackListener } from "./oauth-callback";

const open: CallbackListener[] = [];
afterEach(() => {
  for (const listener of open.splice(0)) listener.close();
});

function listen(timeoutMs = 10_000): CallbackListener {
  const listener = startCallbackListener({ timeoutMs });
  open.push(listener);
  return listener;
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
    await expect(listener.result).resolves.toEqual({ ok: true, code: "the-code" });
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
    await expect(listener.result).resolves.toEqual({ ok: true, code: "real" });
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
    await listener.result;

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
    await expect(listener.result).resolves.toEqual({ ok: true, code: "first" });
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
    await expect(listener.result).resolves.toEqual({ ok: true, code: "in-time" });
  });
});

describe("what the browser is shown", () => {
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
