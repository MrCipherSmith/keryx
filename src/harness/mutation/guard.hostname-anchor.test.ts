import { expect, test } from "bun:test";
import { isPrivateEgressHost } from "./guard";

// review-degradation-w3:F-001 / review-logic-w14:F-001: private prefixes were
// matched as substrings of the whole token, so a public host or a version
// that merely CONTAINS "10." was refused.

test("public hosts and package versions containing a private-looking number are not private egress", () => {
  for (const token of [
    "gpu10.inference.example.com",
    "api.v10.example.com",
    "react@18.10.0",
    "typescript@5.10.1",
    "node-10.example.org",
    "https://gpu10.inference.example.com/v1/chat",
    "https://registry.example.com/pkg-172.16.x",
    "db172.16x.example.com",
    "foo.192.168x.example.com",
    "https://cdn.example.com/lib/v100.64.min.js",
  ]) {
    expect(isPrivateEgressHost(token)).toBe(false);
  }
});

test("real private destinations in every written form stay refused", () => {
  for (const token of [
    "10.0.0.1",
    "10.1.2.3:8080",
    "http://10.0.0.1/admin",
    "https://user:pw@10.0.0.1/x",
    "--host=10.0.0.1",
    "--url=http://192.168.1.10:3000/x",
    "172.16.0.5",
    "http://172.31.255.1/",
    "192.168.0.1",
    "169.254.169.254",
    "http://169.254.169.254/latest/meta-data",
    "127.0.0.1",
    "localhost:3000",
    "http://LOCALHOST/",
    "100.64.0.1",
    "0.0.0.0",
    "http://[::1]:8080/",
    "2130706433",
    "0x7f000001",
    "10.1.2",
    "-H Host:10.0.0.1",
  ]) {
    expect(isPrivateEgressHost(token)).toBe(true);
  }
});
