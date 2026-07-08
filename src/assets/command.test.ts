import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runAssetsSubcommand } from "./command";
import type { AssetFetcher } from "./pull";

let root: string;
const CONTENT = "grammar-bytes\n";
const SHA = createHash("sha256").update(CONTENT).digest("hex");

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "keryx-assets-cmd-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "assets.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      assets: {
        grammar: {
          version: "1.0.0",
          url: "https://assets.example.dev/grammar",
          sha256: SHA,
          size: Buffer.byteLength(CONTENT),
        },
      },
    }),
    "utf8",
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("assets list shows declared assets and resolution state", async () => {
  const result = await runAssetsSubcommand(root, "gdgraph", ["list"]);
  expect(result.exitCode).toBe(0);
  expect(result.lines.join("\n")).toContain("grammar");
  expect(result.lines.join("\n")).toContain("missing");
});

test("assets verify reports unverified for a missing asset (exit 1)", async () => {
  const result = await runAssetsSubcommand(root, "gdgraph", ["verify", "grammar"]);
  expect(result.exitCode).toBe(1);
  expect(result.lines.join("\n")).toContain("unverified");
});

test("assets pull verifies and writes, then verify passes", async () => {
  const cache = path.join(root, "cache");
  const fetcher: AssetFetcher = async () => ({
    ok: true,
    status: 200,
    bytes: async () => new Uint8Array(Buffer.from(CONTENT)),
  });

  const pull = await runAssetsSubcommand(root, "gdgraph", ["pull", "grammar"], {
    fetcher,
    cache,
  });
  expect(pull.exitCode).toBe(0);
  expect(pull.lines.join("\n")).toContain("pulled and verified");
});

test("assets pull refuses on checksum mismatch (exit 1)", async () => {
  const cache = path.join(root, "cache-bad");
  const fetcher: AssetFetcher = async () => ({
    ok: true,
    status: 200,
    bytes: async () => new Uint8Array(Buffer.from("WRONG")),
  });

  const pull = await runAssetsSubcommand(root, "gdgraph", ["pull", "grammar"], {
    fetcher,
    cache,
  });
  expect(pull.exitCode).toBe(1);
  expect(pull.lines.join("\n")).toContain("Checksum mismatch");
});
