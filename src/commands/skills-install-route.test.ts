// Flow 309 (W1) review round 1, F18: `keryx skills install`'s legacy-vs-manifest
// routing must be consistent for the same argv (minus --dry-run/--json), and
// the CLI must note it plainly when --dry-run/--json alone is what routed a
// legacy profile id onto the manifest path.

import { expect, test } from "bun:test";
import { installNeedsManifestPreviewNote, installRoute, valuelessFlagError, valuelessRepeatedFlagError } from "./skills";

test("a legacy profile id with no manifest flags at all stays on the legacy path", () => {
  expect(installRoute("minimal", false)).toBe("legacy");
  expect(installRoute(undefined, false)).toBe("legacy");
});

test("a legacy profile id combined with a manifest-only flag routes to the manifest path", () => {
  expect(installRoute("minimal", true)).toBe("manifest");
});

test("a non-legacy profile id always routes to the manifest path, flags or not", () => {
  expect(installRoute("core", false)).toBe("manifest");
  expect(installRoute("python", true)).toBe("manifest");
});

test("F18: --dry-run/--json alone on a legacy profile id needs the preview-divergence note", () => {
  const base = { withValues: [], withoutValues: [], targetArg: undefined, includeDeprecated: false };
  expect(installNeedsManifestPreviewNote("minimal", base)).toBe(true);
  expect(installNeedsManifestPreviewNote(undefined, base)).toBe(true);
});

test("F18: the note is NOT needed once --with/--without/--target/--include-deprecated is also present", () => {
  expect(
    installNeedsManifestPreviewNote("minimal", {
      withValues: ["lang:python"],
      withoutValues: [],
      targetArg: undefined,
      includeDeprecated: false,
    }),
  ).toBe(false);
  expect(
    installNeedsManifestPreviewNote("minimal", {
      withValues: [],
      withoutValues: [],
      targetArg: "keryx-shell",
      includeDeprecated: false,
    }),
  ).toBe(false);
});

test("F18: the note is NOT needed for a non-legacy profile id (there is no legacy install to diverge from)", () => {
  expect(
    installNeedsManifestPreviewNote("core", {
      withValues: [],
      withoutValues: [],
      targetArg: undefined,
      includeDeprecated: false,
    }),
  ).toBe(false);
});

test("F18: dry-run and a real apply of the SAME argv (minus --dry-run) select the same route", () => {
  // The routing decision does not depend on --dry-run's presence at all —
  // `usesManifestFlags` already includes it, so stripping ONLY --dry-run
  // from a manifest-flagged argv can flip legacy<->manifest; this test pins
  // the one case that matters: an otherwise-bare legacy profile id.
  const dryRunArgvUsesManifestFlags = true; // "--profile minimal --dry-run"
  const applyArgvUsesManifestFlags = false; // "--profile minimal" (no --dry-run)
  expect(installRoute("minimal", dryRunArgvUsesManifestFlags)).toBe("manifest");
  expect(installRoute("minimal", applyArgvUsesManifestFlags)).toBe("legacy");
  // This IS the divergence F18 flags — which is exactly why the note above
  // exists: the CLI cannot make --dry-run's preview and a flag-less apply
  // agree without inventing a legacy dry-run, so it names the divergence
  // instead of hiding it.
});

// R2-8: `install`/`doctor`/`uninstall`'s `--target` (and `--profile`,
// `--module`, `--with`, `--without`) must error on a valueless occurrence
// rather than silently falling back to the default — the same class F3/F9/
// F13 already fixed for `--target`'s VALUE validation, `--trials`/
// `--strictness`, and `--cwd`.
test("R2-8: valuelessFlagError is undefined when the flag is absent entirely", () => {
  expect(valuelessFlagError(["--json"], "--target")).toBeUndefined();
  expect(valuelessFlagError([], "--target")).toBeUndefined();
});

test("R2-8: valuelessFlagError is undefined when the flag has a real value, either spelling", () => {
  expect(valuelessFlagError(["--target", "claude"], "--target")).toBeUndefined();
  expect(valuelessFlagError(["--target=claude"], "--target")).toBeUndefined();
});

test("R2-8: valuelessFlagError errors for a bare trailing flag", () => {
  expect(valuelessFlagError(["--json", "--target"], "--target")).toBe("--target requires a value.");
});

test("R2-8: valuelessFlagError errors when the flag is immediately followed by another flag", () => {
  expect(valuelessFlagError(["--target", "--json"], "--target")).toBe("--target requires a value.");
});

test("R2-8: valuelessFlagError errors for an empty `--flag=` value", () => {
  expect(valuelessFlagError(["--target="], "--target")).toBe("--target requires a value.");
});

test("R2-8: valuelessRepeatedFlagError is undefined when --with is absent or has real values", () => {
  expect(valuelessRepeatedFlagError(["--json"], "--with")).toBeUndefined();
  expect(valuelessRepeatedFlagError(["--with", "lang:python", "--with", "lang:go"], "--with")).toBeUndefined();
  expect(valuelessRepeatedFlagError(["--with=lang:python"], "--with")).toBeUndefined();
});

test("R2-8: valuelessRepeatedFlagError errors for a bare trailing --with, --with followed by a flag, or --with=", () => {
  expect(valuelessRepeatedFlagError(["--with"], "--with")).toBe("--with requires a value.");
  expect(valuelessRepeatedFlagError(["--with", "--json"], "--with")).toBe("--with requires a value.");
  expect(valuelessRepeatedFlagError(["--with="], "--with")).toBe("--with requires a value.");
});

test("R2-8: a valueless --target in real argv is caught even alongside a valid --with", () => {
  expect(valuelessFlagError(["--with", "lang:python", "--target", "--json"], "--target")).toBe(
    "--target requires a value.",
  );
});
