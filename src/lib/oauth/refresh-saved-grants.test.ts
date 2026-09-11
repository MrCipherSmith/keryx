// K-013: a stored grant is refreshed before any shell surface builds a provider.
//
// Found by the arena, 2026-09-11: both keryx arms of a smoke failed on their first
// call with `HTTP 403: The OAuth2 access token could not be validated`. The grant
// had expired hours earlier and was refreshable — a refresh by hand succeeded at
// once — but the only refresh lived in the TUI's start-up, and the arena runs the
// readline surface (`--no-tui -p`).
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveShellConfig } from "../shell-config";
import { loadOAuthGrant } from "./grants";
import { refreshSavedGrants } from "./login";

const NOW = Date.parse("2026-09-11T17:18:00Z");

function configWithGrokGrant(expires: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "keryx-k013-"));
  saveShellConfig(
    {
      oauthGrants: {
        grok: { method: "device-code", access: "old-access", refresh: "the-refresh", expires, obtainedAt: "2026-09-11T09:02:00Z" },
      },
    },
    dir,
  );
  return dir;
}

function tokenEndpoint(status: number, body: unknown): { fetch: (url: string, init?: RequestInit) => Promise<Response>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    },
  };
}

test("an expired grant is refreshed and saved, with nothing to report", async () => {
  const dir = configWithGrokGrant(NOW - 2 * 60 * 60 * 1000);
  const endpoint = tokenEndpoint(200, { access_token: "new-access", refresh_token: "next-refresh", expires_in: 21_600 });

  const warnings = await refreshSavedGrants({ fetch: endpoint.fetch, now: () => NOW }, dir);

  expect(warnings).toEqual([]);
  expect(endpoint.calls).toHaveLength(1);
  const grant = loadOAuthGrant("grok", dir);
  expect(grant?.access).toBe("new-access");
  expect(grant?.refresh).toBe("next-refresh");
  expect(grant?.expires).toBe(NOW + 21_600 * 1000);
});

test("a grant that is still good is left alone, and the endpoint is not called", async () => {
  const dir = configWithGrokGrant(NOW + 60 * 60 * 1000);
  const endpoint = tokenEndpoint(200, {});

  expect(await refreshSavedGrants({ fetch: endpoint.fetch, now: () => NOW }, dir)).toEqual([]);
  expect(endpoint.calls).toHaveLength(0);
  expect(loadOAuthGrant("grok", dir)?.access).toBe("old-access");
});

test("a refresh that fails says so, names the way out, and carries no token", async () => {
  const dir = configWithGrokGrant(NOW - 1000);
  const endpoint = tokenEndpoint(400, { error: "invalid_grant", error_description: "refresh token revoked" });

  const warnings = await refreshSavedGrants({ fetch: endpoint.fetch, now: () => NOW }, dir);

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("grok");
  expect(warnings[0]).toContain("refresh token revoked");
  expect(warnings[0]).toContain("keryx auth login grok");
  expect(warnings[0]).not.toContain("the-refresh");
  expect(warnings[0]).not.toContain("old-access");
  // A failed refresh leaves the stored grant as it was.
  expect(loadOAuthGrant("grok", dir)?.access).toBe("old-access");
});
