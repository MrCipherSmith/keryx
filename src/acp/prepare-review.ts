import type { InteractiveTool } from "../harness/tool/builtin/interactive-tools";
import { parseReviewDraft, type ReviewDraftHints } from "./review-draft";
import type { AcpClientCapabilities } from "./protocol";

export type RequestReviewDraft = (hints: ReviewDraftHints) => Promise<boolean>;

export function clientPreparesReview(capabilities: AcpClientCapabilities | undefined): boolean {
  const meta = capabilities?._meta?.["keryx"];
  return typeof meta === "object" && meta !== null && (meta as Record<string, unknown>)["prepareReview"] === true;
}

export function prepareReviewTool(requestDraft: RequestReviewDraft): InteractiveTool {
  return {
    definition: {
      name: "prepare_review",
      description: "When the user asks to start or configure a PR review in Keryx, use this tool to open the Review configuration in Desktop. " +
        "Pass the PR or Flow if the user identified one. The user chooses settings and starts the review in Desktop. " +
        "For a request to review code yourself, perform the requested code review directly.",
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string", description: "Optional #number or https://github.com/owner/repo/pull/number." },
          flowId: { type: "string", description: "Optional numeric project Flow ID." },
        },
        additionalProperties: false,
      },
      risk: "read",
    },
    invoke: async input => {
      const parsed = parseReviewDraft(input);
      if (!parsed.ok) return { output: parsed.message, isError: true };
      const accepted = await requestDraft(parsed.hints);
      return accepted
        ? { output: "Review configuration requested in the originating Desktop session. The user chooses settings and starts the review there.", isError: false }
        : { output: "Desktop could not accept the configuration request for this session.", isError: true };
    },
  };
}
