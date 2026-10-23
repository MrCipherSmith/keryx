// Flow 309 (AC2) — the live provider catalog's startup wiring inside
// `launchTuiAgentShell` (`tui-shell.ts`).
//
// `launchTuiAgentShell` is never imported/invoked in a headless test (no
// controlling TTY — it declines at its very first line, `if
// (!process.stdout.isTTY) return false;` — matching every other precedent in
// `tui-shell.test.ts`, e.g. its "SLATE-3a" / "SLATE-2a" source-text audits).
// This is that same idiom, applied to AC2: the catalog refresh starts during
// startup loading (the spinner names it), is never `await`ed inline (so a
// hanging provider cannot delay the composer), and the promise it produces is
// only reacted to (the AC6 notice) once it settles, whenever that is.
//
// The HANGING-PROVIDER half of AC2 — that a refresh genuinely does not block
// past its own bound even when a provider's fetch never answers — is proven
// at the unit level in `../harness/provider-catalog.test.ts` (the injected
// fetch there returns a promise that resolves ONLY on the internal abort
// timer, i.e. a hanging fake provider): that is what this integration is
// wired to, so the two tests together cover AC2 end to end without a real
// renderer.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectProviders } from "../commands/select";
import { loadOrRefreshProviderCatalogFromDetected } from "../harness/provider-catalog";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SOURCE = readFileSync(join(import.meta.dir, "tui-shell.ts"), "utf8");
const FN_START = SOURCE.indexOf("export async function launchTuiAgentShell(opts: {");

test("flow 309 AC2: launchTuiAgentShell exists and this audit is anchored inside it", () => {
  expect(FN_START).toBeGreaterThan(-1);
});

test("flow 309 AC2: the spinner names the provider-catalog refresh during startup loading", () => {
  const spinnerAt = SOURCE.indexOf('startupIndicator.setStep("checking providers…")', FN_START);
  expect(spinnerAt).toBeGreaterThan(FN_START);
});

test("flow 309 AC2: the catalog refresh is captured as a promise, not awaited inline, before the composer/chrome mounts", () => {
  // Anchored on the declaration, not on the exact call text: which function and
  // arguments feed it is pinned behaviourally by the flow 468 AC1 tests below.
  const declAt = SOURCE.indexOf("const providerCatalogReady: Promise<ProviderCatalog> =", FN_START);
  expect(declAt).toBeGreaterThan(FN_START);

  // Not `await`ed at the declaration itself — a `const x = await f()` would
  // make `x` the RESOLVED VALUE (not `Promise<ProviderCatalog>`), which is
  // exactly the type annotation this declaration carries; grep the 40 chars
  // immediately before the identifier for a stray `await` anyway, as a direct
  // pin against a future edit reintroducing one.
  const beforeDecl = SOURCE.slice(Math.max(0, declAt - 40), declAt);
  expect(beforeDecl).not.toMatch(/await\s*$/);

  // The chrome (composer, transcript, header) mounts AFTER the kickoff line —
  // proving the refresh is dispatched before the UI becomes interactive, but
  // the UI does not wait on it: `startupIndicator.remove()` (the loading gap
  // this indicator covers) and `chrome.input.focus()` both appear between the
  // kickoff and here, with no `await providerCatalogReady` anywhere in
  // between.
  const chromeMountAt = SOURCE.indexOf("chrome = await createShellChrome(otui, r, {", declAt);
  expect(chromeMountAt).toBeGreaterThan(declAt);
  const between = SOURCE.slice(declAt, chromeMountAt);
  expect(between).not.toContain("await providerCatalogReady");
});

test("flow 309 AC6: a provider that fails at startup is surfaced through announceStartupNotice — the non-blocking, at-most-once notice path — not a blocking prompt", () => {
  const readyReactionAt = SOURCE.indexOf("void providerCatalogReady.then((catalog) => {", FN_START);
  expect(readyReactionAt).toBeGreaterThan(FN_START);
  // Reacts to the SAME promise the kickoff created (never a second refresh).
  const announceDeclAt = SOURCE.indexOf("const announceStartupNotice = (text: string): void => {", FN_START);
  expect(announceDeclAt).toBeGreaterThan(FN_START);
  expect(readyReactionAt).toBeGreaterThan(announceDeclAt); // attached only once safe to reference it (TDZ)
  const reactionBody = SOURCE.slice(readyReactionAt, SOURCE.indexOf("});", readyReactionAt));
  expect(reactionBody).toContain("announceStartupNotice(");
  expect(reactionBody).toContain("auth-failed");
  expect(reactionBody).toContain("unreachable");
  expect(reactionBody).toContain("timeout");
});

test("flow 309 review F-006: the startup-notice reaction returns before painting once the shell is destroyed", () => {
  const readyReactionAt = SOURCE.indexOf("void providerCatalogReady.then((catalog) => {", FN_START);
  expect(readyReactionAt).toBeGreaterThan(FN_START);
  const reactionBody = SOURCE.slice(readyReactionAt, SOURCE.indexOf("});", readyReactionAt));
  const guardAt = reactionBody.indexOf("if (destroyed) return;");
  expect(guardAt).toBeGreaterThan(-1);
  expect(guardAt).toBeLessThan(reactionBody.indexOf("announceStartupNotice("));
});

// --- flow 468 AC1: an empty startup `detected` is never turned into an empty catalog ---

test("flow 468 AC1: with detected: [] at startup the refresh is handed a real detection and saves its providers", async () => {
  const dir = mkdtempSync(join(tmpdir(), "keryx-catalog-startup-"));
  roots.push(dir);
  const fetchFn = (async (url: string) => {
    if (url.includes("/api/tags") || url.includes("/user/balance")) return { ok: false } as Response;
    if (url.includes("deepseek")) return { ok: true, json: async () => ({ data: [{ id: "deepseek-chat" }] }) } as Response;
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  const env = { DEEPSEEK_API_KEY: "sk-fake-deepseek" };
  let detections = 0;
  // Test seam `redetect`: the same live detection `tui-shell.ts` already holds as `opts.redetect` (the path `/model` uses).
  const redetect = async () => {
    detections += 1;
    return detectProviders({ fetch: fetchFn, env, configDir: dir, platform: "linux" });
  };

  const catalog = await loadOrRefreshProviderCatalogFromDetected([], { fetch: fetchFn, env, dir, platform: "linux", redetect });

  expect(detections).toBe(1);
  expect(catalog.providers.deepseek?.models).toEqual(["deepseek-chat"]);
});

test("flow 468 AC1: launchTuiAgentShell hands its redetect to the startup catalog refresh", () => {
  // The one wiring fact a headless test cannot reach (the launcher declines without a TTY): the kickoff passes `opts.redetect` along.
  const declAt = SOURCE.indexOf("const providerCatalogReady: Promise<ProviderCatalog> =", FN_START);
  expect(declAt).toBeGreaterThan(FN_START);
  const kickoff = SOURCE.slice(declAt, SOURCE.indexOf(".catch(", declAt));
  expect(kickoff).toContain("redetect");
});
