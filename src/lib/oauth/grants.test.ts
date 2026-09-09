import { expect, test } from "bun:test";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { uniqueTestRoot } from "../test-tmp";
import { shellConfigPath } from "../shell-config";
import {
  deleteOAuthGrant,
  grantFromTokens,
  grantNeedsRefresh,
  listOAuthGrantProviders,
  loadOAuthGrant,
  oauthGrantStatus,
  saveOAuthGrant,
} from "./grants";

function dir(): string {
  return uniqueTestRoot(tmpdir(), "keryx-oauth");
}

test("saveOAuthGrant writes owner-only and loadOAuthGrant reads it back", () => {
  const root = dir();
  saveOAuthGrant("grok", grantFromTokens("device-code", { accessToken: "acc", refreshToken: "ref", expiresInSeconds: 60 }, () => 1_000), root);
  const mode = statSync(shellConfigPath(root)).mode & 0o777;
  expect(mode).toBe(0o600);
  const grant = loadOAuthGrant("grok", root);
  expect(grant?.access).toBe("acc");
  expect(grant?.refresh).toBe("ref");
  expect(grant?.method).toBe("device-code");
  expect(oauthGrantStatus("grok", root, () => 1_000)?.state).toBe("active");
  expect(oauthGrantStatus("grok", root, () => 1_000)?.refreshable).toBe(true);
  expect(listOAuthGrantProviders(root)).toEqual(["grok"]);
});

test("oauthGrantStatus reports expired without returning the token", () => {
  const root = dir();
  saveOAuthGrant("grok", grantFromTokens("device-code", { accessToken: "secret-token", expiresInSeconds: 1 }, () => 0), root);
  const status = oauthGrantStatus("grok", root, () => 2_000);
  expect(status?.state).toBe("expired");
  expect(JSON.stringify(status)).not.toContain("secret-token");
});

test("deleteOAuthGrant removes only that provider", () => {
  const root = dir();
  saveOAuthGrant("grok", grantFromTokens("device-code", { accessToken: "a" }), root);
  saveOAuthGrant("github-copilot", grantFromTokens("device-code", { accessToken: "b" }), root);
  deleteOAuthGrant("grok", root);
  expect(loadOAuthGrant("grok", root)).toBeUndefined();
  expect(loadOAuthGrant("github-copilot", root)?.access).toBe("b");
});

test("grantNeedsRefresh is true inside the skew window when a refresh token exists", () => {
  const grant = grantFromTokens("device-code", { accessToken: "a", refreshToken: "r", expiresInSeconds: 30 }, () => 0);
  expect(grantNeedsRefresh(grant, () => 0)).toBe(true);
  const withoutRefresh: typeof grant = { method: grant.method, access: grant.access, obtainedAt: grant.obtainedAt };
  expect(grantNeedsRefresh(withoutRefresh, () => 0)).toBe(false);
});
