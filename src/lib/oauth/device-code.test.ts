import { expect, test } from "bun:test";
import {
  DeviceCodeError,
  pollDeviceCodeToken,
  refreshAccessToken,
  requestDeviceCode,
  type DeviceCodeChallenge,
  type OAuthFetch,
} from "./device-code";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const challenge: DeviceCodeChallenge = {
  deviceCode: "device-secret",
  userCode: "ABCD-1234",
  verificationUri: "https://auth.example.test/verify",
  expiresInSeconds: 60,
  intervalSeconds: 1,
};

test("requestDeviceCode returns the challenge and never requires a loopback", async () => {
  const fetchFn: OAuthFetch = async (input) => {
    expect(String(input)).toBe("https://auth.example.test/oauth2/device/code");
    return jsonResponse(200, {
      device_code: "device-secret",
      user_code: "ABCD-1234",
      verification_uri: "https://auth.example.test/verify",
      interval: 5,
      expires_in: 300,
    });
  };
  const got = await requestDeviceCode(
    {
      deviceAuthorizationEndpoint: "https://auth.example.test/oauth2/device/code",
      clientId: "public-client",
      scope: "openid offline_access",
    },
    { fetch: fetchFn },
  );
  expect(got.userCode).toBe("ABCD-1234");
  expect(got.verificationUri).toBe("https://auth.example.test/verify");
  expect(got.deviceCode).toBe("device-secret");
});

test("requestDeviceCode rejects a user_code with control characters", async () => {
  const fetchFn: OAuthFetch = async () =>
    jsonResponse(200, {
      device_code: "device-secret",
      user_code: "AB\nCD",
      verification_uri: "https://auth.example.test/verify",
    });
  await expect(
    requestDeviceCode(
      {
        deviceAuthorizationEndpoint: "https://auth.example.test/device",
        clientId: "c",
        scope: "s",
      },
      { fetch: fetchFn },
    ),
  ).rejects.toBeInstanceOf(DeviceCodeError);
});

test("pollDeviceCodeToken treats authorization_pending as progress and honours slow_down", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const fetchFn: OAuthFetch = async () => {
    n += 1;
    if (n === 1) {
      calls.push("pending");
      return jsonResponse(400, { error: "authorization_pending" });
    }
    if (n === 2) {
      calls.push("slow");
      return jsonResponse(400, { error: "slow_down" });
    }
    calls.push("ok");
    return jsonResponse(200, { access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
  };
  const tokens = await pollDeviceCodeToken(
    { ...challenge, intervalSeconds: 1 },
    { tokenEndpoint: "https://auth.example.test/token", clientId: "c" },
    {
      fetch: fetchFn,
      now: (() => {
        let t = 0;
        return () => {
          t += 1;
          return t;
        };
      })(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  expect(tokens.accessToken).toBe("access-1");
  expect(tokens.refreshToken).toBe("refresh-1");
  expect(calls).toEqual(["pending", "slow", "ok"]);
  expect(sleeps.length).toBe(2);
  expect(sleeps[1]!).toBeGreaterThan(sleeps[0]!);
});

test("pollDeviceCodeToken stops on access_denied and does not retry", async () => {
  let n = 0;
  const fetchFn: OAuthFetch = async () => {
    n += 1;
    return jsonResponse(400, { error: "access_denied" });
  };
  await expect(
    pollDeviceCodeToken(challenge, { tokenEndpoint: "https://auth.example.test/token", clientId: "c" }, { fetch: fetchFn, sleep: async () => {} }),
  ).rejects.toMatchObject({ kind: "access_denied" });
  expect(n).toBe(1);
});

test("pollDeviceCodeToken accepts a GitHub-style 200 body with authorization_pending", async () => {
  let n = 0;
  const fetchFn: OAuthFetch = async () => {
    n += 1;
    if (n === 1) return jsonResponse(200, { error: "authorization_pending" });
    return jsonResponse(200, { access_token: "gh-access" });
  };
  const tokens = await pollDeviceCodeToken(
    { ...challenge, intervalSeconds: 1 },
    { tokenEndpoint: "https://github.test/login/oauth/access_token", clientId: "c" },
    { fetch: fetchFn, now: () => n * 10, sleep: async () => {} },
  );
  expect(tokens.accessToken).toBe("gh-access");
});

test("pollDeviceCodeToken cancels when the signal aborts", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    pollDeviceCodeToken(
      challenge,
      { tokenEndpoint: "https://auth.example.test/token", clientId: "c" },
      { fetch: async () => jsonResponse(200, {}), signal: controller.signal },
    ),
  ).rejects.toMatchObject({ kind: "cancelled" });
});

test("refreshAccessToken keeps the previous refresh token when the server omits a rotation", async () => {
  const fetchFn: OAuthFetch = async () => jsonResponse(200, { access_token: "next-access", expires_in: 10 });
  const tokens = await refreshAccessToken(
    { tokenEndpoint: "https://auth.example.test/token", clientId: "c", refreshToken: "old-refresh" },
    { fetch: fetchFn },
  );
  expect(tokens.accessToken).toBe("next-access");
  expect(tokens.refreshToken).toBe("old-refresh");
});
