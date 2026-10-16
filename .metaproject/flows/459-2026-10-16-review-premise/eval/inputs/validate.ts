// usage: bun validate.ts <claims.json> <findings.json>
// claims.json may be the raw judge output (markdown with a ```json keryx:premises block) or bare JSON.
import { readFileSync } from "node:fs";
import { parsePremiseClaims, mergePremises } from "/Users/Goodea/goodea/keryx/.claude/worktrees/blissful-poitras-27beb5/src/review/premise";

const [claimsPath, findingsPath] = process.argv.slice(2);
let text = readFileSync(claimsPath!, "utf8");
const fenced = text.match(/```json keryx:premises\s*([\s\S]*?)```/);
if (fenced) text = fenced[1]!;
const findings = JSON.parse(readFileSync(findingsPath!, "utf8"));
let parsed;
try {
  parsed = parsePremiseClaims(JSON.parse(text));
} catch (e) {
  console.log(JSON.stringify({ parseError: String(e) }));
  process.exit(1);
}
const res = mergePremises(findings, parsed);
console.log(
  JSON.stringify(
    {
      judge: parsed?.judge,
      model: parsed?.model,
      counts: res.counts,
      rejections: res.rejections,
      verdicts: res.findings.map((f: any) => ({ id: f.id, severity: f.severity, verdict: f.premise?.verdict })),
    },
    null,
    1,
  ),
);
