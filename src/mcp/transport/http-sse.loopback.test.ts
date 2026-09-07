import { describe, expect, test } from "bun:test";
import { request, type Server } from "node:http";
import * as httpTransport from "./http-sse";

type Lookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
type ResolveHost = (host: string, lookup?: Lookup) => Promise<string>;

function resolveHost(host: string, lookup?: Lookup): Promise<string> {
  const resolve = Reflect.get(httpTransport, "resolveMcpLoopbackHost") as ResolveHost | undefined;
  expect(typeof resolve).toBe("function");
  return resolve!(host, lookup);
}

describe("MCP HTTP validates before connecting or binding", () => {
  for (const host of ["0.0.0.0", "::", "192.0.2.1", "2001:db8::1"]) {
    test(`refuses ${host} before the SDK connection`, async () => {
      let connections = 0;
      const server = {
        async connect() {
          connections += 1;
          throw new Error("fixture aborts before any socket can be opened");
        },
      };
      await expect(httpTransport.startHttpTransport(server, { host, port: 0 })).rejects.toThrow("loopback");
      expect(connections).toBe(0);
    });
  }

  for (const port of [-1, 65536, 1.5, Number.NaN]) {
    test(`refuses invalid port ${port} before SDK connection`, async () => {
      let connections = 0;
      await expect(httpTransport.startHttpTransport({ async connect() {
        connections += 1;
        throw new Error("fixture aborts before any socket can be opened");
      } }, { host: "127.0.0.1", port })).rejects.toThrow("port");
      expect(connections).toBe(0);
    });
  }
});

describe("loopback host resolution", () => {
  test("accepts IPv4 and IPv6 loopback literals without a DNS lookup", async () => {
    const lookup: Lookup = async () => { throw new Error("DNS must not run for literals"); };
    for (const host of ["127.0.0.1", "127.42.0.1", "::1", "0:0:0:0:0:0:0:1"]) {
      expect(await resolveHost(host, lookup)).toBeTruthy();
    }
  });

  test("returns the verified numeric address for hostname binding", async () => {
    expect(await resolveHost("local.example", async () => [{ address: "127.0.0.1", family: 4 }]))
      .toBe("127.0.0.1");
  });

  test("refuses misleading localhost names resolved outside loopback", async () => {
    await expect(resolveHost("localhost.example", async () => [{ address: "192.0.2.1", family: 4 }]))
      .rejects.toThrow("loopback");
  });

  test("refuses ambiguous, empty and failed hostname resolution", async () => {
    for (const addresses of [[], [{ address: "127.0.0.1", family: 4 }, { address: "::1", family: 6 }]]) {
      await expect(resolveHost("local.example", async () => addresses)).rejects.toThrow();
    }
    await expect(resolveHost("local.example", async () => { throw new Error("synthetic resolver failure"); }))
      .rejects.toThrow();
  });

  test("duplicate answers do not make one address ambiguous", async () => {
    const addresses = [{ address: "::1", family: 6 }, { address: "0:0:0:0:0:0:0:1", family: 6 }];
    expect(await resolveHost("local.example", async () => addresses)).toBe("::1");
  });

  test("rejects scoped or malformed IPv6 without echoing the supplied host", async () => {
    await expect(resolveHost("::1%fixture-zone")).rejects.toThrow("MCP HTTP");
  });
});

test("request boundary refuses foreign Host and Origin headers", () => {
  const trusted = Reflect.get(httpTransport, "isTrustedMcpHttpRequest") as
    ((headers: Record<string, string>, hosts: string[], port: number) => boolean) | undefined;
  expect(typeof trusted).toBe("function");
  const hosts = ["127.0.0.1", "localhost"];
  expect(trusted!({ host: "127.0.0.1:43210" }, hosts, 43210)).toBe(true);
  expect(trusted!({ host: "localhost:43210", origin: "http://localhost:43210" }, hosts, 43210)).toBe(true);
  expect(trusted!({ host: "attacker.example:43210" }, hosts, 43210)).toBe(false);
  expect(trusted!({ host: "localhost:12345" }, hosts, 43210)).toBe(false);
  expect(trusted!({ host: "localhost:43210", origin: "https://attacker.example" }, hosts, 43210)).toBe(false);
  expect(trusted!({ host: "localhost:43210", origin: "null" }, hosts, 43210)).toBe(false);
  expect(trusted!({ host: "localhost:43210", "sec-fetch-site": "cross-site" }, hosts, 43210)).toBe(false);
  // A configured DNS name is not an authorized browser origin, even if it
  // resolved to loopback once during startup.
  expect(trusted!({ host: "configured.example:43210", origin: "http://configured.example:43210", "sec-fetch-site": "same-origin" }, [...hosts, "configured.example"], 43210)).toBe(false);
});

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function localRequest(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "HEAD", headers, agent: false }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.setTimeout(2000, () => req.destroy(new Error("local HTTP fixture timed out")));
    req.on("error", reject);
    req.end();
  });
}

test("real loopback listener enforces headers and reports a bind failure", async () => {
  const server = await httpTransport.startHttpTransport({ async connect() {} }, { host: "127.0.0.1", port: 0 });
  try {
    const bound = server.address();
    expect(bound && typeof bound !== "string").toBe(true);
    if (!bound || typeof bound === "string") throw new Error("missing bound address");
    expect(bound.address).toBe("127.0.0.1");
    expect(await localRequest(bound.port, { host: `attacker.example:${bound.port}` })).toBe(403);
    expect(await localRequest(bound.port, { host: `127.0.0.1:${bound.port}`, origin: "https://attacker.example" })).toBe(403);
    // The SDK rejects HEAD with 405: trusted native requests reach the protocol.
    expect(await localRequest(bound.port, { host: `127.0.0.1:${bound.port}` })).toBe(405);
    await expect(httpTransport.startHttpTransport({ async connect() {} }, { host: "127.0.0.1", port: bound.port }))
      .rejects.toMatchObject({ code: "EADDRINUSE" });
  } finally {
    await closeServer(server);
  }
});
