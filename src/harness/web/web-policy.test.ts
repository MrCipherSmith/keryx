import { expect, test } from "bun:test";
import { parsePublicHttpsUrl, validatePublicTarget } from "./web-policy";

const publicAddress = "93.184.216.34";

test("public HTTPS target is parsed and pinned to a validated address", async () => {
  const url = parsePublicHttpsUrl("https://example.com/path?q=1");
  expect(url.ok).toBe(true);
  if (!url.ok) return;

  const target = await validatePublicTarget(url.value, async () => [{ address: publicAddress }]);
  expect(target).toEqual({ ok: true, value: { url: "https://example.com/path?q=1", hostname: "example.com", address: publicAddress } });
});

test("remote policy rejects non-HTTPS, credentials, and encoded IP literals", () => {
  for (const raw of [
    "http://example.com",
    "https://user:pass@example.com",
    "https://127.0.0.1",
    "https://2130706433",
    "https://0x7f000001",
  ]) {
    expect(parsePublicHttpsUrl(raw).ok).toBe(false);
  }
});

test("remote policy rejects every private, special, and IPv6-local DNS answer", async () => {
  const url = parsePublicHttpsUrl("https://example.com");
  expect(url.ok).toBe(true);
  if (!url.ok) return;

  for (const address of ["127.0.0.1", "10.0.0.1", "100.64.0.1", "169.254.169.254", "0.0.0.0", "::1", "::", "fc00::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    const result = await validatePublicTarget(url.value, async () => [{ address }]);
    expect(result.ok).toBe(false);
  }
});

test("remote policy rejects mixed DNS results before a connection can be selected", async () => {
  const url = parsePublicHttpsUrl("https://example.com");
  expect(url.ok).toBe(true);
  if (!url.ok) return;

  const result = await validatePublicTarget(url.value, async () => [
    { address: publicAddress },
    { address: "10.0.0.1" },
  ]);
  expect(result.ok).toBe(false);
});
