import type { InteractiveTool } from "../../harness/tool/builtin/interactive-tools";
import { redactSensitiveText } from "../../security/service";
import type { SessionProjectReadPort } from "./effects";

/** These tools address only the authenticated session's project; no filesystem or URL input. */
export function canonicalProjectTools(port: () => SessionProjectReadPort | undefined): InteractiveTool[] {
  return ["hub_context", "hub_flows", "hub_flow"].map((name) => {
    const key = name === "hub_context" ? "documentId" : "flowId";
    return {
      definition: { name, description: name === "hub_context" ? "Read the current session project's validated canonical Hub context; reread after updates."
        : name === "hub_flows" ? "List canonical Hub Flows for the current session project." : "Read one canonical Hub Flow in the current session project.",
      inputSchema: { type: "object", properties: name === "hub_flows" ? {} : { [key]: { type: "string", maxLength: 200 } },
        required: name === "hub_flow" ? [key] : [], additionalProperties: false }, risk: "read" },
      async invoke(input) {
        const allowed = name === "hub_flows" ? [] : [key];
        if (Object.keys(input).some((field) => !allowed.includes(field)) || (name === "hub_flow" && input[key] === undefined)
          || (input[key] !== undefined && (typeof input[key] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input[key])))) {
          return { output: "invalid-arguments", isError: true };
        }
        const reader = port();
        if (reader?.source !== "hub-canonical" || (name === "hub_context" && reader.readContext === undefined)) return { output: "setup-required", isError: true };
        try {
          const value = name === "hub_context" ? await reader.readContext!(input.documentId as string | undefined)
            : name === "hub_flows" ? await reader.listFlows() : await reader.readFlow(input.flowId as string);
          const output = redactSensitiveText(JSON.stringify(value));
          if (Buffer.byteLength(output) > 32768) return { output: "quota-exceeded", isError: true };
          return { output, isError: false, untrusted: true };
        } catch { return { output: "canonical-project-read-failed", isError: true }; }
      },
    };
  });
}
