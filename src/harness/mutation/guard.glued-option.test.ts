import { expect, test } from "bun:test";
import { isPrivateEgressHost } from "./guard";

// review-degradation-w2:F-001 / review-logic-w3:F-001 / review-regression-w2:F-001:
// the ADDR_START anchor stopped matching a private address glued to a short
// option or embedded in a DNS name. Tokens are split into host candidates first.

test("a private address glued to a short option stays refused", () => {
  for (const token of [
    "-h10.0.0.5",
    "-h192.168.1.10",
    "-h172.16.0.5",
    "-h127.0.0.1",
    "-h169.254.169.254",
    "-x169.254.169.254:80",
    "-x10.0.0.5:3128",
    "-x127.0.0.1:8080",
    "-xhttp://10.0.0.5:3128",
    "-H100.64.0.1",
    "--host=10.0.0.5",
    "--proxy=http://user:pw@10.0.0.5:3128",
    "-h=192.168.0.1",
    "-hlocalhost",
  ]) {
    expect(isPrivateEgressHost(token)).toBe(true);
  }
});

test("a dotted private address embedded in a DNS name stays refused", () => {
  for (const token of [
    "x.10.0.0.1.nip.io",
    "10.0.0.1.nip.io",
    "app.192.168.1.5.sslip.io",
    "foo-10.0.0.1.nip.io",
    "https://x.169.254.169.254.nip.io/latest",
    "y.127.0.0.1.nip.io:8080",
  ]) {
    expect(isPrivateEgressHost(token)).toBe(true);
  }
});

test("public names, versions and public glued addresses are still not private", () => {
  for (const token of [
    "gpu10.inference.example.com",
    "api.v10.example.com",
    "react@18.10.0",
    "typescript@5.10.1",
    "-h8.8.8.8",
    "-x93.184.216.34:3128",
    "x.8.8.8.8.nip.io",
    "--host=example.com",
    "1.2.3.10.example.com",
  ]) {
    expect(isPrivateEgressHost(token)).toBe(false);
  }
});
