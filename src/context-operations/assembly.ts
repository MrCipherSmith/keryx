/**
 * Canonical bounded context assembly seam.  Consumers supply descriptors, not
 * source content; SAC must reference this trace instead of maintaining a
 * second retrieval trace or knowledge store.
 */
export type ContextCandidate = Readonly<{ id: string; required: boolean; tokens: number }>;
export type ContextAssembly = Readonly<{
  traceRef: string;
  configurationRevision: string;
  policyRef: string;
  policyRevision: string;
  selected: string[];
  omittedOptional: string[];
  partial: boolean;
}>;
export type ContextOverflow = Readonly<{ code: "context_overflow"; requiredId: string }>;

export function assembleContext(input: {
  candidates: readonly ContextCandidate[];
  maxItems: number;
  maxTokens: number;
  traceRef: string;
  configurationRevision: string;
  policyRef: string;
  policyRevision: string;
}): ContextAssembly | ContextOverflow {
  let items = 0;
  let tokens = 0;
  const selected: string[] = [];
  const omittedOptional: string[] = [];
  for (const candidate of input.candidates) {
    const fits = items < input.maxItems && tokens + candidate.tokens <= input.maxTokens;
    if (!fits && candidate.required) return { code: "context_overflow", requiredId: candidate.id };
    if (!fits) { omittedOptional.push(candidate.id); continue; }
    selected.push(candidate.id); items += 1; tokens += candidate.tokens;
  }
  return {
    traceRef: input.traceRef, configurationRevision: input.configurationRevision,
    policyRef: input.policyRef, policyRevision: input.policyRevision,
    selected, omittedOptional, partial: omittedOptional.length > 0,
  };
}
