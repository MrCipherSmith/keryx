#!/usr/bin/env bun
/**
 * SPIKE ONLY — TCP bind probe for verify.sh section 7.
 *
 * Prints exactly one line: `BOUND` or `DENIED:<code>` or `ERROR:<message>`.
 * A bind is used rather than a connect on purpose: `connect` to a dead port
 * returns ECONNREFUSED whether or not Landlock is in play, so it cannot tell a
 * denial from an absence — the same shape of false green ADR-0010 is about.
 */

const port = Number(Bun.argv[2] ?? "0");

try {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port,
    socket: { data() {} },
  });
  server.stop(true);
  console.log("BOUND");
} catch (error) {
  const code = (error as { code?: string }).code;
  console.log(code === undefined ? `ERROR:${(error as Error).message}` : `DENIED:${code}`);
}
