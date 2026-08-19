// Codec lookup for the external agent runtime (flow 176, T14).
// Package: docs/requirements/keryx-external-agent-runtime §5.
//
// A table of the shipped codecs and one lookup over it. Deliberately tiny: the
// registry (`../registry.ts`) owns agent METADATA and this owns the CODE that
// cannot be expressed as table rows — argv, parsing, classification (package
// decisions.md D-06). Keeping them in two files means a new agent adds one row
// and one module rather than editing a single object that does both jobs.
//
// FAIL-CLOSED, and that is the whole point of the module. An unknown id yields
// `undefined` and never a default codec, because "fall back to some other
// agent's adapter" produces a run that spawns the wrong binary with the wrong
// flags and then misclassifies its output — three wrong answers wearing a
// success shape. The registry's `getExternalAgent` fails closed for the same
// reason and the two must agree.
//
// Pure: importing this spawns nothing and reads nothing.
import type { ExternalAgentCodec } from "../types";
import { claudeCliCodec } from "./claude-cli";
import { codexCliCodec } from "./codex-cli";

/**
 * Every shipped codec, in registry order.
 *
 * Exported so a caller can ENUMERATE rather than guess — `keryx` surfaces that
 * list available agents, and a test that pins registry/codec agreement, both
 * need the set rather than a lookup.
 */
export const EXTERNAL_CODECS: readonly ExternalAgentCodec[] = [codexCliCodec, claudeCliCodec];

/**
 * The codec for one dispatch id, or `undefined` when no codec ships for it.
 *
 * Never returns a default. A caller holding `undefined` has learned a true fact
 * — keryx cannot drive this agent — and must refuse the dispatch with that
 * reason instead of substituting an adapter that would build the wrong argv.
 */
export function getExternalCodec(agentId: string): ExternalAgentCodec | undefined {
  return EXTERNAL_CODECS.find((codec) => codec.id === agentId);
}

/** Every id a codec ships for, in registry order. */
export function externalCodecIds(): string[] {
  return EXTERNAL_CODECS.map((codec) => codec.id);
}
