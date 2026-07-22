#!/usr/bin/env bun
// Flow 114 / AC2 — POSITIVE proof that the platform-specific prebuilt native
// binary behind the optional TUI dependency resolved on THIS machine.
//
// Why "positive" matters here. The optional dependency is dynamically imported
// and fallback-guarded on purpose (open item O-4), so on a platform where the
// prebuilt binary is missing NOTHING throws: `keryx shell` degrades to readline
// and every suite still goes green. "No error occurred" is therefore worthless
// as platform evidence — it is exactly what an unsupported platform looks like.
//
// So this script never asks "did anything fail?". It asks four questions whose
// answers only exist when the native layer really loaded:
//
//   1. Which prebuilt package does THIS platform/arch/libc require?
//   2. Does importing it hand back a real shared-library file on disk?
//   3. Does dlopen'ing it through the library's own FFI loader succeed?
//   4. Does a byte written by JS come back out of Zig-owned memory?
//
// (4) is the load-bearing one: the string it asserts on has to make a round trip
// through the native buffer. No stub, no fallback and no absent binary can
// produce it.
//
// It also fails when a Zig toolchain is present, because PRD N1's claim is
// "prebuilt binaries … no Zig toolchain required at end-user install" — with a
// compiler on PATH a successful run could not distinguish "the prebuilt binary
// was pulled" from "something built it locally".
//
// Usage:  bun ./scripts/verify-opentui-native.ts
// Exit:   0 = the native layer is proven loaded; 1 = it is not (with the reason).

import { statSync } from "node:fs";
import { basename } from "node:path";

/** One prebuilt shared library, named the way the dependency names it. */
interface NativeTarget {
  /** The prebuilt package the dependency will import on this host. */
  packageName: string;
  /** The shared-library file that package ships. */
  fileName: string;
}

const NATIVE_FILE_NAMES: Record<string, string> = {
  darwin: "libopentui.dylib",
  linux: "libopentui.so",
  win32: "opentui.dll",
};

const OPTIONAL_TUI_PACKAGE = "@opentui/core";

/**
 * Mirrors the dependency's own `getNativeAssetDescriptor`: the prebuilt package
 * is `<dep>-<platform>-<arch>` plus a `-musl` suffix on musl Linux.
 *
 * Deriving it here rather than reading it back from the dependency is the point:
 * an independently computed expectation is what turns step 2 into a check
 * instead of a tautology.
 */
function expectedTarget(): NativeTarget {
  const platform = process.platform;
  const arch = process.arch;
  const fileName = NATIVE_FILE_NAMES[platform];
  if (fileName === undefined) {
    throw new Error(`unsupported platform for the prebuilt TUI binary: ${platform}`);
  }
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`unsupported architecture for the prebuilt TUI binary: ${arch}`);
  }
  const musl = platform === "linux" && process.env.OPENTUI_LIBC === "musl";
  return {
    packageName: `${OPTIONAL_TUI_PACKAGE}-${platform}-${arch}${musl ? "-musl" : ""}`,
    fileName,
  };
}

const failures: string[] = [];
const notes: string[] = [];

function ok(line: string): void {
  notes.push(`  ok    ${line}`);
}

function fail(line: string): void {
  failures.push(line);
  notes.push(`  FAIL  ${line}`);
}

/** The smallest size a real prebuilt core could plausibly have (~3.7MB today). */
const MIN_LIBRARY_BYTES = 512 * 1024;
/** Written by JS, stored by Zig, read back out of native memory. */
const ROUND_TRIP_SENTINEL = "KERYX-NATIVE-ROUND-TRIP";

async function main(): Promise<number> {
  const target = expectedTarget();
  const host = `${process.platform}-${process.arch}${
    process.env.OPENTUI_LIBC !== undefined && process.env.OPENTUI_LIBC !== ""
      ? ` (libc=${process.env.OPENTUI_LIBC})`
      : ""
  }`;

  console.log("Native TUI binary verification (flow 114 / AC2)");
  console.log(`  host            ${host}`);
  console.log(`  bun             ${Bun.version}`);
  console.log(`  expects package ${target.packageName}`);
  console.log(`  expects library ${target.fileName}`);
  console.log("");

  // --- 0. No Zig toolchain ---------------------------------------------------
  const zig = Bun.which("zig");
  if (zig === null) {
    ok("no Zig toolchain on PATH, so nothing here could have been compiled locally");
  } else {
    fail(
      `a Zig toolchain is on PATH (${zig}). PRD N1 claims the prebuilt binaries are ` +
        `pulled with no toolchain required; with a compiler present this run could not ` +
        `tell a downloaded binary from a locally built one, so the evidence would be void.`,
    );
  }

  // --- 1./2. The prebuilt package resolves to a real shared library ----------
  let libraryPath: string | undefined;
  try {
    const prebuilt = (await import(target.packageName)) as { default?: unknown };
    const resolved = prebuilt.default;
    if (typeof resolved !== "string" || resolved.length === 0) {
      fail(`${target.packageName} resolved but exported no library path (got ${typeof resolved})`);
    } else {
      libraryPath = resolved;
      ok(`${target.packageName} resolved -> ${resolved}`);
    }
  } catch (error) {
    fail(
      `${target.packageName} did not resolve: ${error instanceof Error ? error.message : String(error)}. ` +
        `This is the platform gap itself — the optional dependency would silently ` +
        `fall back to readline here.`,
    );
  }

  if (libraryPath !== undefined) {
    if (basename(libraryPath) !== target.fileName) {
      fail(`resolved library is ${basename(libraryPath)}, expected ${target.fileName}`);
    } else {
      ok(`library file name matches this platform's convention (${target.fileName})`);
    }
    try {
      const size = statSync(libraryPath).size;
      if (size < MIN_LIBRARY_BYTES) {
        fail(`library is only ${size} bytes — too small to be the real prebuilt core`);
      } else {
        ok(`library exists on disk, ${(size / (1024 * 1024)).toFixed(2)} MB`);
      }
    } catch (error) {
      fail(
        `library path does not stat: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // --- 3./4. dlopen, then a round trip through Zig-owned memory -------------
  //
  // The optional dependency is reached only through `await import(...)`, never a
  // static import — the same rule `src/capability/no-optional-imports` enforces
  // over `src/`.
  try {
    const core = await import(OPTIONAL_TUI_PACKAGE);
    const lib = core.resolveRenderLib();
    const loader = lib.constructor.name;
    if (!loader.includes("RenderLib")) {
      fail(`the render library resolved to an unexpected implementation (${loader})`);
    } else {
      ok(`the shared library dlopen'd through the FFI loader (${loader})`);
    }

    const buffer = core.OptimizedBuffer.create(ROUND_TRIP_SENTINEL.length + 4, 1, "wcwidth");
    try {
      buffer.clear(core.RGBA.fromInts(0, 0, 0, 255));
      buffer.drawText(ROUND_TRIP_SENTINEL, 0, 0, core.RGBA.fromInts(255, 255, 255, 255));
      const decoded = new TextDecoder().decode(buffer.getRealCharBytes(false));
      if (decoded.includes(ROUND_TRIP_SENTINEL)) {
        ok(`text written by JS came back out of native memory ("${ROUND_TRIP_SENTINEL}")`);
      } else {
        fail(`the native buffer round trip returned ${JSON.stringify(decoded)}`);
      }
    } finally {
      buffer.destroy();
    }
  } catch (error) {
    fail(
      `the native layer did not load: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  console.log(notes.join("\n"));
  console.log("");

  if (failures.length > 0) {
    console.error("=========================================================================");
    console.error(`NATIVE BINARY NOT PROVEN on ${host} — ${failures.length} check(s) failed:`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    console.error("");
    console.error("PRD N1 claims prebuilt native binaries cover this platform and that the");
    console.error("install path pulls them without a Zig toolchain. On this host that claim");
    console.error("is NOT evidenced. Failing loudly: the optional dependency degrades to the");
    console.error("readline shell instead of erroring, so a green run would prove nothing.");
    console.error("=========================================================================");
    return 1;
  }

  console.log(`NATIVE BINARY PROVEN on ${host}: ${target.packageName} loaded and answered.`);
  return 0;
}

process.exit(await main());
