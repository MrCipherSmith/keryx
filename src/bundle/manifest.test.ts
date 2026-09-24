// Flow 313 (W4 portability), T6 — manifest.ts: schema validation, formatVersion
// major check, duplicate-path and kind/path consistency refusals.

import { describe, expect, test } from "bun:test";

import { parseManifest, serializeManifest } from "./manifest";
import { BUNDLE_FORMAT_VERSION, type BundleManifest } from "./types";

function validManifest(): BundleManifest {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId: "keryx-project-abc123def456",
    createdAt: "2026-09-24T00:00:00.000Z",
    sourceKeryxVersion: "0.2.160",
    provenance: { producedBy: "keryx bundle export", sourceScope: "project" },
    compat: { minKeryxVersion: "0.2.160", targetHarnesses: [] },
    contents: [
      {
        path: "agents/foo.md",
        kind: "agent",
        scope: "project",
        sha256: "a".repeat(64),
        sizeBytes: 10,
      },
    ],
  };
}

describe("parseManifest", () => {
  test("accepts a schema-valid manifest", () => {
    const bytes = Buffer.from(serializeManifest(validManifest()), "utf8");
    const result = parseManifest(bytes);
    expect(result.ok).toBe(true);
  });

  test("refuses invalid JSON", () => {
    const result = parseManifest(Buffer.from("not json", "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals[0]?.reason).toBe("schema-invalid");
  });

  test("refuses a manifest failing the schema (missing required field)", () => {
    const manifest = validManifest() as unknown as Record<string, unknown>;
    delete manifest.bundleId;
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "schema-invalid")).toBe(true);
  });

  test("refuses a formatVersion whose major does not match", () => {
    const manifest = validManifest();
    manifest.formatVersion = "2.0.0";
    const result = parseManifest(Buffer.from(serializeManifest(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals[0]?.reason).toBe("unsupported-format-version");
  });

  test("refuses duplicate contents[].path", () => {
    const manifest = validManifest();
    manifest.contents.push({ ...manifest.contents[0] } as BundleManifest["contents"][number]);
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "duplicate-path")).toBe(true);
  });

  test("refuses a path that does not match its kind's on-disk shape", () => {
    const manifest = validManifest();
    manifest.contents[0]!.path = "not-agents/foo.md";
    const result = parseManifest(Buffer.from(JSON.stringify(manifest), "utf8"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusals.some((r) => r.reason === "kind-path-mismatch")).toBe(true);
  });
});

describe("serializeManifest", () => {
  test("is stable JSON with a trailing newline", () => {
    const text = serializeManifest(validManifest());
    expect(text.endsWith("\n")).toBe(true);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(serializeManifest(validManifest())).toBe(text);
  });
});
