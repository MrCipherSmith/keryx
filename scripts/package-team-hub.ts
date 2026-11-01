/** Build an allowlisted, deterministic source archive and optional Linux executables.
 * bun scripts/package-team-hub.ts --out /absolute/output [--linux-x64]
 */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const args = process.argv.slice(2);
let output = resolve(root, "artifacts/team-hub");
let compile = false;
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--out" && args[index + 1]) output = resolve(args[++index]!);
  else if (args[index] === "--linux-x64") compile = true;
  else throw new Error("Usage: bun scripts/package-team-hub.ts --out /absolute/output [--linux-x64]");
}
const freshness = Bun.spawn([process.execPath, "scripts/build-hub-web.ts", "--check"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await freshness.exited !== 0) throw new Error("Refusing to package stale frontend assets");
// src/lib/git-revision.ts: the revision-operand guard src/hub/git-delivery.ts and src/hub/connector.ts import at runtime.
const files: string[] = ["src/flow/machine.ts", "src/flow/types.ts", "src/lib/git-revision.ts", "scripts/package-team-hub.ts", "scripts/build-hub-web.ts", "scripts/smoke/team-hub.ts", "scripts/smoke/team-hub-remote.ts", "scripts/smoke/team-hub-work.ts", "docs/handoffs/hub-work-management-runbook.md", "LICENSE"];
async function include(directory: string, allowed: (name: string) => boolean) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Refusing symlink in release inputs: " + entry.name);
    if (entry.isFile() && allowed(entry.name)) files.push(directory + "/" + entry.name);
  }
}
const productionSource = (name: string) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".test-support.ts");
await include("src/hub", productionSource);
await include("src/hub/remote-v2", productionSource);
await include("src/hub/work", productionSource);
// Hub uses the neutral validator boundary, never the native host/tool runtime.
await include("src/remote-control", name => ["protocol.ts", "owned-controls.ts"].includes(name));
await include("src/remote-control/generated", name => ["validators.js", "validators.d.ts", "types.ts", "manifest.json"].includes(name));
async function includeTree(directory: string) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (["node_modules", "dist", "coverage", ".git"].includes(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error("Refusing symlink in frontend release inputs");
    const path = directory + "/" + entry.name;
    if (entry.isDirectory()) await includeTree(path);
    else if (entry.isFile() && !/(?:^|\/)(?:\.env(?:\..+)?|credentials?(?:\..+)?|.*\.(?:pem|key))$/i.test(path)) files.push(path);
  }
}
await includeTree("apps/hub-web/src");
await includeTree("apps/hub-web/public");
await include("apps/hub-web", name => ["package.json", "bun.lock", "index.html", "tsconfig.json", "vite.config.ts", "eslint.config.js", "README.md", "CONTRACTS.md"].includes(name));
await include("docs/requirements/hub-remote-sessions", name => name.endsWith(".md"));
await include("docs/requirements/hub-remote-sessions/schemas", name => name.endsWith(".json"));
// Managed work validates these closed domain/command/event schemas at runtime.
// Keep the source contract reviewable without admitting unrelated job output or private JSON.
await include("docs/requirements/hub-work-management", name => ["README.md","metadata-protocol.md","migration.md","specification.md","observer.md","openapi.json"].includes(name));
await include("docs/requirements/hub-work-management/schemas", name => ["domain.schema.json","command.schema.json","event.schema.json"].includes(name));
await include("docs/requirements/hub-mcp", name => name.endsWith(".md"));
await include("docs/requirements/hub-context-watch", name => name.endsWith(".md"));
await include("docs/requirements/hub-context-watch/schemas", name => name.endsWith(".json"));
await include("deploy/team-hub/runtime", name => ["package.json", "bun.lock", ".gitignore"].includes(name));
await include("docs/requirements/hub-react-frontend", name => name.endsWith(".md"));
await include("docs/requirements/team-hub-prototype", name => name.endsWith(".md"));
await include("deploy/team-hub", name => ["Dockerfile", "Dockerfile.dockerignore", "compose.yaml", "Caddyfile", ".env.example", ".gitignore"].includes(name));
const entries: { path: string; body: Buffer }[] = [];
for (const file of [...new Set(files)].sort()) {
  if (!(await lstat(join(root, file))).isFile()) throw new Error("Refusing non-file or symlink in release inputs: " + file);
  entries.push({ path: file, body: await readFile(join(root, file)) });
}
const runtimePackage = JSON.parse(await readFile(join(root, "deploy/team-hub/runtime/package.json"), "utf8")) as Record<string, unknown>;
entries.push({ path: "package.json", body: Buffer.from(JSON.stringify({ ...runtimePackage, scripts: { start: "bun run src/hub/main.ts", client: "bun run src/hub/client-main.ts", smoke: "bun scripts/smoke/team-hub.ts" } }, null, 2) + "\n") });
entries.push({ path: "bun.lock", body: await readFile(join(root, "deploy/team-hub/runtime/bun.lock")) });
entries.sort((left, right) => left.path.localeCompare(right.path, "en"));
const blocks: Buffer[] = [];
const epoch = Number(process.env.SOURCE_DATE_EPOCH ?? "0");
if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("SOURCE_DATE_EPOCH must be a nonnegative integer");
function octal(header: Buffer, start: number, length: number, value: number) {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  if (encoded.length !== length) throw new Error("Release exceeds tar integer field");
  header.write(encoded, start, length, "ascii");
}
for (const entry of entries) {
  const path = "team-hub-prototype/" + entry.path;
  if (path.includes("\0") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe release path");
  let name = path; let prefix = "";
  if (Buffer.byteLength(path) > 100) {
    const split = [...path.matchAll(/\//g)].map(match => match.index).reverse().find(index => Buffer.byteLength(path.slice(0, index)) <= 155 && Buffer.byteLength(path.slice(index + 1)) <= 100);
    if (split === undefined) throw new Error("Release tar path exceeds portable USTAR fields: " + path);
    prefix = path.slice(0, split); name = path.slice(split + 1);
  }
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8"); header.write(prefix, 345, 155, "utf8");
  octal(header, 100, 8, 0o644); octal(header, 108, 8, 0); octal(header, 116, 8, 0);
  octal(header, 124, 12, entry.body.length); octal(header, 136, 12, epoch);
  header.fill(32, 148, 156); header[156] = 48;
  header.write("ustar\0", 257, 6, "ascii"); header.write("00", 263, 2, "ascii");
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  blocks.push(header, entry.body, Buffer.alloc((512 - entry.body.length % 512) % 512));
}
blocks.push(Buffer.alloc(1024));
await mkdir(output, { recursive: true });
const artifacts = ["team-hub-prototype-source.tar.gz"];
await writeFile(join(output, artifacts[0]!), gzipSync(Buffer.concat(blocks), { level: 9 }));
if (compile) {
  // Compile from isolated sources and the same locked runtime as the container,
  // never from the developer checkout's possibly stale shared dependency tree.
  const staging = await mkdtemp(join(tmpdir(), "keryx-hub-compile-"));
  try {
    for (const entry of entries) {
      const target = join(staging, entry.path); await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, entry.body);
    }
    const install = Bun.spawn([process.execPath, "install", "--frozen-lockfile", "--production", "--ignore-scripts"], { cwd: staging, stdout: "inherit", stderr: "inherit" });
    if (await install.exited !== 0) throw new Error("Pinned Hub runtime installation failed; source archive remains available");
    for (const [entry, name] of [["src/hub/main.ts", "team-hub-server-linux-x64"], ["src/hub/client-main.ts", "team-hub-client-linux-x64"]] as const) {
      const child = Bun.spawn([process.execPath, "build", entry, "--compile", "--target=bun-linux-x64-baseline", "--outfile", join(output, name)], { cwd: staging, stdout: "inherit", stderr: "inherit" });
      if (await child.exited !== 0) throw new Error("Linux compilation failed: " + name + "; source archive remains available");
      artifacts.push(name);
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
const checksums: string[] = [];
for (const name of artifacts) checksums.push(createHash("sha256").update(await readFile(join(output, name))).digest("hex") + "  " + name);
await writeFile(join(output, "SHA256SUMS"), checksums.join("\n") + "\n");
console.log("Release artifacts: " + relative(process.cwd(), output));
console.log(checksums.join("\n"));
