import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";

// Import-boundary guard (M-3, AC1): `src/mcp/` may import ONLY service facades +
// `src/lib/*` + the security `guard` seam — never a module's internals. Plus the
// golden-rule static guard (C0-2, AC9): no top-level import of the MCP SDK
// anywhere in `src/`; the SDK is loaded ONLY via `await import()` in server.ts.

const MCP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(MCP_ROOT, "..");
const PKG_ROOT = path.join(SRC_ROOT, "..");

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await tsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

// The ONLY cross-module specifiers `src/mcp/` is allowed to import statically.
// Each is a service facade, a pure query/type module, `lib/*`, or the security
// `guard` seam (redactRaw). Anything else is an internal-boundary violation.
//
// The `../harness/tool/metaproject-*` trio is permitted (flow 040): the single
// metaproject operation source is projected into MCP tools via `toMcpTools`. These
// are pure — the port is a types-only interface, the operations file is pure
// descriptors + projections, and the reference adapter composes ONLY the service
// facades already allow-listed above. No module internals cross the boundary.
const ALLOWED_EXTERNAL = new Set([
  "../gdgraph/query",
  "../gdgraph/types",
  "../security/service",
  "../security/guard",
  "../security/types",
  "../security/detect/mcp",
  "../memory/service",
  "../health/service",
  "../wiki/service",
  "../flow/service",
  "../standard/service",
  "../harness/tool/metaproject-operations",
  "../harness/tool/metaproject-port",
  "../harness/tool/metaproject-adapter",
]);

function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const staticRe = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const sideEffectRe = /\bimport\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = staticRe.exec(content)) !== null) {
    if (match[1]) specs.push(match[1]);
  }
  while ((match = sideEffectRe.exec(content)) !== null) {
    if (match[1]) specs.push(match[1]);
  }
  return specs;
}

test("src/mcp only imports service facades + lib + guard (M-3)", async () => {
  const files = (await tsFiles(MCP_ROOT)).filter((f) => !f.endsWith(".test.ts"));
  const violations: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");
    for (const spec of importSpecifiers(content)) {
      const isRelativeInternal = spec.startsWith("./") || spec.startsWith("../transport/");
      const isNodeBuiltin = spec.startsWith("node:");
      const isLib = spec.startsWith("../lib/");
      const isAllowedFacade = ALLOWED_EXTERNAL.has(spec);
      if (!isRelativeInternal && !isNodeBuiltin && !isLib && !isAllowedFacade) {
        violations.push(`${path.relative(PKG_ROOT, file)} imports "${spec}"`);
      }
    }
  }

  expect(violations).toEqual([]);
});

test("no top-level @modelcontextprotocol/sdk import anywhere in src/ (C0-2)", async () => {
  const files = await tsFiles(SRC_ROOT);
  const violations: string[] = [];
  // Match ANY static import of the SDK or a subpath — but never `await import(`.
  const staticSdk =
    /\b(?:import|export)\b[^()]*?\bfrom\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]|\bimport\s*['"]@modelcontextprotocol\/sdk[^'"]*['"]|\brequire\s*\(\s*['"]@modelcontextprotocol\/sdk/;

  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (staticSdk.test(content)) {
      violations.push(path.relative(PKG_ROOT, file));
    }
  }

  expect(violations).toEqual([]);
});

test("server.ts loads the SDK only via lazy await import()", async () => {
  const server = await readFile(path.join(MCP_ROOT, "server.ts"), "utf8");
  expect(server).toContain('await import("@modelcontextprotocol/sdk');
});
