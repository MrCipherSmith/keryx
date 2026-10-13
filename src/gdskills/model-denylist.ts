/**
 * Models that automatic selection must never pick, whatever their name ranks as.
 * The operator's rule: GPT-6 Astra is too expensive to dispatch on their behalf.
 * Applied wherever a model is chosen without the operator naming it — tier
 * resolution candidates and routing-table assignments.
 */
const DENIED_MODEL_PATTERNS: readonly RegExp[] = [/(^|[/:])gpt-6(\.\d+)*-astra(\b|$)/i];

export function isDeniedModel(modelId: string | undefined): boolean {
  if (modelId === undefined) return false;
  const id = modelId.trim();
  return DENIED_MODEL_PATTERNS.some((re) => re.test(id));
}
