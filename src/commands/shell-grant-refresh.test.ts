// K-013: the stored-grant refresh runs for every shell surface, not only the TUI.
//
// A source-text check, like the SLATE-3a audits beside it: the surfaces are chosen
// inside one long function whose branches need a terminal, a provider and a model
// to drive. The behaviour of the refresh itself is proved in
// `src/lib/oauth/refresh-saved-grants.test.ts`; what this pins is where it is
// called — before the surface is chosen, so the readline surface (`--no-tui`,
// `--print`) cannot be skipped again.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const source = readFileSync(path.join(import.meta.dir, "shell.ts"), "utf8");

test("the shell refreshes stored grants before it picks a surface", () => {
  const refresh = source.indexOf("await refreshSavedGrants(");
  const surface = source.indexOf("const surface = chooseShellSurface(");
  expect(refresh).toBeGreaterThan(-1);
  expect(surface).toBeGreaterThan(-1);
  expect(refresh).toBeLessThan(surface);
});

test("the refresh is bounded, so a silent network cannot hang a scripted run (review F-001)", () => {
  const call = source.slice(source.indexOf("const { refreshSavedGrants }"), source.indexOf("const surface = chooseShellSurface("));
  expect(call).toContain("AbortSignal.timeout(GRANT_REFRESH_TIMEOUT_MS)");
  expect(source).toMatch(/const GRANT_REFRESH_TIMEOUT_MS = \d[\d_]*;/);
});

test("readline provider detection reads saved keys itself, not through a shell_exec side effect (review F-003)", () => {
  // `resolveShellEnv` used to load saved keys into `process.env`, so a provider
  // configured only by a saved key appeared in readline `/provider` once any
  // command had run. It no longer does (K-015); the selector reads them directly.
  const start = source.indexOf("function realSelectProviderModel(");
  const body = source.slice(start, source.indexOf("\n}\n", start));
  expect(start).toBeGreaterThan(-1);
  expect(body).toContain("const env = envWithSavedApiKeys(process.env);");
  expect(body).not.toContain("env: process.env");
});

test("no refresh failure is swallowed silently any more", () => {
  expect(source).not.toContain('refreshProviderGrant("grok", { fetch: oauthFetch }, opts.configDir).catch(() => undefined)');
});
