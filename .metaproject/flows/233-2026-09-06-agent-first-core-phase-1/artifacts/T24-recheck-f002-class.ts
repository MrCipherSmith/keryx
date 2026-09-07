// T24 recheck — enumerate the F-002 class: which byte-hiding shapes still pass the
// accountability gate, and how wide the new false-rejection is on real repo JSON.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateSerializedContentForTransport } from "../../../../src/security/output-validation";

const S = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const CRED = "tr0ub4dor-correct-horse";

const shapes: Record<string, string> = {
  // (a) JSON escapes hide the span from the raw-text detectors
  escapedSecretDuplicateValue: `{"a":"AKIA\\u0049OSFODNN7EXAMPLE","a":"safe"}`,
  escapedSecretDuplicateKey: `{"AKIA\\u0049OSFODNN7EXAMPLE":"x","b":1}`,
  fullyEscapedSecretDuplicate: `{"a":"\\u0041\\u004bIAIOSFODNN7EXAMPLE","a":"safe"}`,
  // (b) the contextual sensitive-field rule is not part of accountability
  credEmptySurvivor: `{"pwd":"${CRED}","pwd":""}`,
  credNullSurvivor: `{"api_key":"${CRED}","api_key":null}`,
  credBooleanSurvivor: `{"secret":"${CRED}","secret":false}`,
  // controls that must stay closed
  plainSecretDuplicate: `{"metric":"${S}","metric":"safe"}`,
  plainSecretDuplicateKeyNotSensitive: `{"note":"${S}","note":"safe"}`,
  numberUnderCredentialKeyDuplicate: `{"password":1234,"password":1}`,
};
const shapeResults = Object.fromEntries(
  Object.entries(shapes).map(([name, raw]) => {
    const r = validateSerializedContentForTransport(raw);
    return [
      name,
      {
        ok: r.ok,
        state: r.redaction.state,
        reasons: r.redaction.reasons,
        bytesRestored: r.text === raw,
        hidesSecret: r.text.includes(S) || r.text.includes(CRED) || /AKIA|\\u004[9b]/.test(r.text),
      },
    ];
  }),
);

// False-rejection breadth: realistic payloads whose parsed value has a safe
// representation but whose raw bytes carry a detector span across a separator.
const falseRejectionCandidates: Record<string, unknown> = {
  urlThenEmail: { docs: "https://example.com", note: "ping@host.example" },
  repoThenOwner: { repo: "https://github.com/acme/x", owner: "dev@acme.example" },
  linkThenContact: { link: "https://docs.example.org/guide", contact: "a@b.co" },
  emailThenUrl: { note: "ping@host.example", docs: "https://example.com" },
  urlOnly: { docs: "https://example.com" },
  emailOnly: { note: "ping@host.example" },
};
const falseRejections = Object.fromEntries(
  Object.entries(falseRejectionCandidates).map(([name, value]) => {
    const raw = JSON.stringify(value);
    const r = validateSerializedContentForTransport(raw);
    return [name, { raw, ok: r.ok, state: r.redaction.state, reasons: r.redaction.reasons }];
  }),
);

// Real repository JSON through the same adapter (the persistence path).
function collect(dir: string, out: string[], depth = 0): void {
  if (depth > 3 || out.length > 400) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".git")) continue;
    const full = path.join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) collect(full, out, depth + 1);
    else if (entry.endsWith(".json") && s.size < 400_000) out.push(full);
  }
}
const files: string[] = [];
collect(path.join(process.cwd(), ".metaproject"), files);
collect(path.join(process.cwd(), "fixtures"), files);
const rejected: Array<{ file: string; reasons: string[] }> = [];
let checked = 0;
for (const file of files) {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  try {
    JSON.parse(content);
  } catch {
    continue;
  }
  checked += 1;
  const r = validateSerializedContentForTransport(content);
  if (!r.ok) {
    rejected.push({ file: path.relative(process.cwd(), file), reasons: r.redaction.reasons });
  }
}
const mismatchOnly = rejected.filter((r) => r.reasons.includes("serialized-content-mismatch"));

const out = process.argv[2] ?? "/tmp/T24-recheck-f002-class.json";
writeFileSync(
  out,
  JSON.stringify(
    {
      shapeResults,
      falseRejections,
      repoJson: {
        checked,
        rejectedTotal: rejected.length,
        serializedContentMismatch: mismatchOnly.length,
        mismatchFiles: mismatchOnly.slice(0, 25),
        otherRejections: rejected.filter((r) => !r.reasons.includes("serialized-content-mismatch")).slice(0, 25),
      },
    },
    null,
    2,
  ),
);
console.log(`wrote ${out} (checked ${checked} repo json files)`);
