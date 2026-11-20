// Shared by the ACP host and Desktop. Only configuration hints travel over this boundary.
export const PREPARE_REVIEW_METHOD = "_keryx/prepare_review";

export interface ReviewDraftHints {
  target?: string;
  flowId?: string;
}

export type ParseReviewDraft = { ok: true; hints: ReviewDraftHints } | { ok: false; message: string };

export function parseReviewDraft(input: Record<string, unknown>): ParseReviewDraft {
  if (Object.keys(input).some(key => key !== "target" && key !== "flowId")) {
    return { ok: false, message: "Only target and flowId can be specified." };
  }
  const hints: ReviewDraftHints = {};
  if (input.target !== undefined) {
    const target = typeof input.target === "string" ? input.target.trim() : "";
    const number = /^#?([1-9]\d*)$/.exec(target);
    const url = /^https:\/\/github\.com\/([a-z\d][a-z\d-]*)\/([\w.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(target);
    const pr = number?.[1] ?? url?.[3];
    if (!pr || !Number.isSafeInteger(Number(pr)) || url?.[2] === "." || url?.[2] === ".." || target.length > 512) {
      return { ok: false, message: "Use a pull request number such as #42 or its GitHub pull request URL." };
    }
    hints.target = url ? `https://github.com/${url[1]}/${url[2]}/pull/${pr}` : `#${pr}`;
  }
  if (input.flowId !== undefined) {
    if (typeof input.flowId !== "string" || !/^[1-9]\d*$/.test(input.flowId) || !Number.isSafeInteger(Number(input.flowId))) {
      return { ok: false, message: "Use the numeric Flow ID." };
    }
    hints.flowId = input.flowId;
  }
  return { ok: true, hints };
}
