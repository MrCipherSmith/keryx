// Flow 313 (W4 portability), T6 — archive.ts: ustar round trip and refusals.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_BUNDLE_LIMITS, buildBundleArchive, openBundle } from "./archive";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "keryx-bundle-archive-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("buildBundleArchive + openBundle round trip", () => {
  test("archive bytes round-trip byte-identical", async () => {
    const files = new Map<string, Buffer>([
      ["agents/foo.md", Buffer.from("---\nname: foo\n---\nbody\n", "utf8")],
      ["skills/bar/SKILL.md", Buffer.from("skill content", "utf8")],
    ]);
    const manifestBytes = Buffer.from('{"a":1}\n', "utf8");
    const built = buildBundleArchive(files, manifestBytes);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const archivePath = path.join(root, "bundle.tar.gz");
    writeFileSync(archivePath, built.value);

    const opened = await openBundle(archivePath);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.manifestBytes.equals(manifestBytes)).toBe(true);
    expect(opened.value.files.get("agents/foo.md")?.equals(files.get("agents/foo.md") as Buffer)).toBe(true);
    expect(opened.value.files.get("skills/bar/SKILL.md")?.equals(files.get("skills/bar/SKILL.md") as Buffer)).toBe(true);
  });

  test("directory bundle round trip", async () => {
    const dir = path.join(root, "bundle-dir");
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    writeFileSync(path.join(dir, "bundle.json"), '{"a":1}\n');
    writeFileSync(path.join(dir, "agents", "foo.md"), "content");

    const opened = await openBundle(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.kind).toBe("directory");
    expect(opened.value.files.get("agents/foo.md")?.toString()).toBe("content");
  });

  test("refuses a directory bundle containing a symlink", async () => {
    const dir = path.join(root, "bundle-dir-symlink");
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    writeFileSync(path.join(dir, "bundle.json"), '{"a":1}\n');
    writeFileSync(path.join(root, "outside.md"), "x");
    symlinkSync(path.join(root, "outside.md"), path.join(dir, "agents", "foo.md"));

    const opened = await openBundle(dir);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("symlink-refused");
  });

  test("refuses a directory with no bundle.json", async () => {
    const dir = path.join(root, "not-a-bundle");
    mkdirSync(dir, { recursive: true });
    const opened = await openBundle(dir);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("not-a-bundle");
  });

  test("refuses a corrupt gzip stream", async () => {
    const archivePath = path.join(root, "bad.tar.gz");
    writeFileSync(archivePath, Buffer.from("not a gzip stream"));
    const opened = await openBundle(archivePath);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-invalid");
  });

  test("refuses a tar entry with a `..` name", async () => {
    const header = Buffer.alloc(512);
    header.write("../escape.txt", 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write("00000000000\0", 124, "ascii"); // size 0
    header[156] = 0x30;
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    header.fill(0x20, 148, 156);
    for (let i = 0; i < 512; i += 1) sum += header[i] as number;
    header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;

    const tar = Buffer.concat([header, Buffer.alloc(1024)]);
    const archivePath = path.join(root, "escape.tar.gz");
    writeFileSync(archivePath, gzipSync(tar));
    const opened = await openBundle(archivePath);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-invalid");
  });

  // R3-I2: a member is a DIRECTORY only by its ustar typeflag ("5"), never
  // merely because its name ends in "/" — a SYMLINK member (typeflag "2")
  // named with a trailing slash used to be silently treated as an empty
  // directory instead of falling through to the unsupported-entry-type
  // refusal every other symlink member already hits. Fails on the pre-fix
  // code, which accepted this archive.
  test("R3-I2: a symlink member named with a trailing slash is refused, not treated as an empty directory", async () => {
    function ustarHeader(name: string, size: number, typeflag: number, link = ""): Buffer {
      const header = Buffer.alloc(512);
      header.write(name, 0, "utf8");
      header.write("0000644\0", 100, "ascii");
      header.write("0000000\0", 108, "ascii");
      header.write("0000000\0", 116, "ascii");
      header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii");
      header.write("00000000000\0", 136, "ascii");
      header.fill(0x20, 148, 156);
      header[156] = typeflag;
      header.write(link, 157, "ascii");
      header.write("ustar", 257, "ascii");
      header.write("00", 263, "ascii");
      let sum = 0;
      for (let i = 0; i < 512; i += 1) sum += header[i] as number;
      header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
      header[154] = 0;
      header[155] = 0x20;
      return header;
    }
    const manifestBytes = Buffer.from(
      JSON.stringify({
        formatVersion: "1.0.0",
        bundleId: "ptar",
        createdAt: "2026-01-01T00:00:00.000Z",
        sourceKeryxVersion: "0.0.0",
        provenance: { producedBy: "keryx bundle export", sourceScope: "project" },
        compat: { minKeryxVersion: "0.0.0", targetHarnesses: [] },
        contents: [],
      }),
    );
    const parts = [
      ustarHeader("bundle.json", manifestBytes.length, 0x30),
      manifestBytes,
      Buffer.alloc((512 - (manifestBytes.length % 512)) % 512),
      // A symlink (typeflag '2') named with a trailing slash, pointing outside.
      ustarHeader("rules/", 0, 0x32, "/tmp"),
      Buffer.alloc(1024),
    ];
    const tar = Buffer.concat(parts);
    const archivePath = path.join(root, "symlink-trailing-slash.tar.gz");
    writeFileSync(archivePath, gzipSync(tar));
    const opened = await openBundle(archivePath);
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-invalid");
  });

  test("default caps match what archive.ts documents (R1-F10)", () => {
    // A behavioral pin on the exported defaults, so a change to the
    // production constants is a deliberate, visible diff here rather than a
    // silent drift from the header comment that documents them.
    expect(DEFAULT_BUNDLE_LIMITS).toEqual({
      maxEntries: 10_000,
      maxTotalBytes: 256 * 1024 * 1024,
      maxCompressedBytes: 32 * 1024 * 1024,
      maxManifestBytes: 8 * 1024 * 1024,
    });
  });

  test("refuses an archive source past an injected entry-count cap", async () => {
    const files = new Map<string, Buffer>([
      ["agents/a.md", Buffer.from("x")],
      ["agents/b.md", Buffer.from("x")],
      ["agents/c.md", Buffer.from("x")],
    ]);
    const built = buildBundleArchive(files, Buffer.from("{}"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const archivePath = path.join(root, "too-many-entries.tar.gz");
    writeFileSync(archivePath, built.value);

    // 3 files (bundle.json is excluded from the count — R3-F22); cap at 2
    // so it still refuses.
    const opened = await openBundle(archivePath, { maxEntries: 2 });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-too-large");
  });

  // R3-F22: the archive's entry cap used to count `bundle.json` as one of
  // the entries, while `manifest.ts`'s own `contents.length` cap did not —
  // so a VALID bundle with exactly `maxEntries` content entries (allowed by
  // the manifest cap) could never be opened, because the archive itself
  // carries one MORE entry (`bundle.json`) than the injected archive cap.
  // Fails on the pre-fix code, which refused `archive-too-large` here.
  test("R3-F22: a bundle with exactly maxEntries content files (plus bundle.json) still opens", async () => {
    const files = new Map<string, Buffer>([
      ["agents/a.md", Buffer.from("x")],
      ["agents/b.md", Buffer.from("x")],
      ["agents/c.md", Buffer.from("x")],
    ]);
    const built = buildBundleArchive(files, Buffer.from("{}"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const archivePath = path.join(root, "exactly-at-cap.tar.gz");
    writeFileSync(archivePath, built.value);

    // 3 real files, capped at exactly 3 — bundle.json must not consume one
    // of the 3 slots.
    const opened = await openBundle(archivePath, { maxEntries: 3 });
    expect(opened.ok).toBe(true);
  });

  test("R3-F22: the directory source agrees with the archive source at the same boundary", async () => {
    const dir = path.join(root, "bundle-dir-exactly-at-cap");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle.json"), '{"a":1}\n');
    writeFileSync(path.join(dir, "a.md"), "x");
    writeFileSync(path.join(dir, "b.md"), "x");
    writeFileSync(path.join(dir, "c.md"), "x");

    const opened = await openBundle(dir, { maxEntries: 3 });
    expect(opened.ok).toBe(true);
  });

  test("R3-F19: a bundle.json over the injected manifest-byte cap is refused, independent of the entry/total-bytes caps", async () => {
    const files = new Map<string, Buffer>();
    const bigManifest = Buffer.from(`{"padding":"${"x".repeat(1000)}"}`);
    const built = buildBundleArchive(files, bigManifest);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const archivePath = path.join(root, "big-manifest.tar.gz");
    writeFileSync(archivePath, built.value);

    const opened = await openBundle(archivePath, { maxManifestBytes: 100 });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-too-large");
  });

  test("refuses a directory source past an injected entry-count cap", async () => {
    const dir = path.join(root, "bundle-dir-too-many-entries");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "bundle.json"), '{"a":1}\n');
    writeFileSync(path.join(dir, "a.md"), "x");
    writeFileSync(path.join(dir, "b.md"), "x");
    writeFileSync(path.join(dir, "c.md"), "x");

    const opened = await openBundle(dir, { maxEntries: 2 });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-too-large");
  });

  test("refuses a compressed file past an injected compressed-size cap", async () => {
    const files = new Map<string, Buffer>([["agents/a.md", Buffer.from("hello world")]]);
    const built = buildBundleArchive(files, Buffer.from("{}"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const archivePath = path.join(root, "over-compressed-cap.tar.gz");
    writeFileSync(archivePath, built.value);

    // The archive on disk is a few hundred bytes; cap it far below that.
    const opened = await openBundle(archivePath, { maxCompressedBytes: 16 });
    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-too-large");
  });

  test("refuses a gzip bomb via maxOutputLength, without inflating past a small injected cap (R1-F10)", async () => {
    // Build a single ustar entry whose DECLARED size safely exceeds a small
    // injected `maxTotalBytes`, filled with zero bytes. gzip level 9
    // compresses an all-zero payload to a few KB, so the archive on disk
    // here is tiny while its declared decompressed size is not — a genuine
    // high-ratio decompression bomb, not just a big file.
    //
    // `openBundle` must refuse via gunzipSync's `maxOutputLength`, which
    // ABORTS decompression once the cap is crossed instead of inflating the
    // full declared size — so this test's own peak memory stays bounded
    // near the injected cap (a few MiB), not the declared ~20 MiB, and the
    // refusal must surface as the named `archive-invalid` reason that
    // `maxOutputLength` errors map to (not `archive-too-large`, which is
    // the tar-level per-entry/total check that never gets a chance to run
    // here because decompression itself aborts first).
    const MAX_TOTAL_BYTES = 1 * 1024 * 1024; // 1 MiB injected cap
    const DATA_SIZE = 20 * 1024 * 1024; // declared size, well past the cap
    const name = "agents/bomb.md";
    const header = Buffer.alloc(512);
    header.write(name, 0, "ascii");
    header.write("0000644\0", 100, "ascii");
    header.write(`${DATA_SIZE.toString(8).padStart(11, "0")}\0`, 124, "ascii");
    header[156] = 0x30; // regular file
    header.write("ustar", 257, "ascii");
    header.write("00", 263, "ascii");
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += header[i] as number;
    header.write(sum.toString(8).padStart(6, "0"), 148, "ascii");
    header[154] = 0;
    header[155] = 0x20;

    const dataBlocks = Math.ceil(DATA_SIZE / 512) * 512;
    const tar = Buffer.concat([header, Buffer.alloc(dataBlocks), Buffer.alloc(1024)]);
    const compressed = gzipSync(tar, { level: 9 });
    // Prove this really is a high-ratio bomb: the on-disk archive is tiny
    // relative to its declared decompressed size.
    expect(compressed.length).toBeLessThan(64 * 1024);

    const archivePath = path.join(root, "bomb.tar.gz");
    writeFileSync(archivePath, compressed);

    const rssBefore = process.memoryUsage().rss;
    const opened = await openBundle(archivePath, { maxTotalBytes: MAX_TOTAL_BYTES });
    const rssAfter = process.memoryUsage().rss;

    expect(opened.ok).toBe(false);
    if (!opened.ok) expect(opened.refusal.reason).toBe("archive-invalid");
    // gunzipSync must have aborted well short of the ~20 MiB declared size.
    // The injected cap is ~9 MiB (1 MiB total + 8 MiB ustar headroom); allow
    // generous headroom above that for GC/allocator noise while staying
    // meaningfully under the 20 MiB the bomb would inflate to uncapped.
    expect(rssAfter - rssBefore).toBeLessThan(18 * 1024 * 1024);
  });

  test("refuses a name too long for ustar name+prefix", () => {
    const longName = `agents/${"a".repeat(90)}/${"b".repeat(90)}/${"c".repeat(90)}.md`;
    const files = new Map<string, Buffer>([[longName, Buffer.from("x")]]);
    const built = buildBundleArchive(files, Buffer.from("{}"));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.refusal.reason).toBe("archive-invalid");
  });
});
