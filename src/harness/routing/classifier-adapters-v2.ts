import { runModelTurn, type ProviderFactory } from "../provider/single-turn";
import {
  callJevSystemOne,
  DEFAULT_JEV_MODEL,
  preflightBudget,
  type JevQuestions,
} from "../decision/jev-client";
import { redactSensitiveText } from "../../security/service";
import type { RoutingClassifierAdapter } from "./classifier-chain-v2";

const CATEGORIES = ["default", "review", "subagents", "quick", "coding", "planning", "docs", "unattended"] as const;
const CLASSES = ["light", "standard", "expert", "frontier"] as const;
const CAPABILITIES = ["tools", "vision", "structured-output"] as const;

export const DEFAULT_JEV_ROUTING_TARGET = { providerId: "openrouter", modelId: "jev-1.13" } as const;

export interface MainModelRoutingClassifierOptions {
  readonly providerId: string;
  readonly modelId: string;
  readonly env?: Record<string, string | undefined>;
  readonly fetch?: typeof fetch;
  readonly providerFactory?: ProviderFactory;
}

export function mainModelRoutingClassifierAdapter(id: string, options: MainModelRoutingClassifierOptions): RoutingClassifierAdapter<string> {
  return {
    id,
    async classify(task, context) {
      const result = await runModelTurn({
        provider: options.providerId,
        model: options.modelId,
        system: `Classify the coding-assistant request. Return JSON only with exactly these fields: category (${CATEGORIES.join("|")}), modelClass (${CLASSES.join("|")}), confidence (0..1), reasonCode (short stable string), requiredCapabilities (array containing only ${CAPABILITIES.join("|")}).`,
        user: redactSensitiveText(task.slice(0, 4_000)),
        maxOutputTokens: 180,
        requestId: "keryx-routing-classifier-v2",
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.providerFactory === undefined ? {} : { providerFactory: options.providerFactory }),
        signal: context.signal,
      });
      if (result.error !== undefined || result.text.trim().length === 0) throw new Error("model classifier did not return a usable response");
      const match = result.text.match(/\{[\s\S]*\}/);
      if (match === null) throw new Error("model classifier response was not JSON");
      return JSON.parse(match[0]) as unknown;
    },
  };
}

export interface JevRoutingClassifierOptions {
  readonly fetch?: typeof fetch;
  readonly env?: Record<string, string | undefined>;
  readonly dir?: string;
  readonly model?: string;
  readonly timeoutMs?: number;
}

export function jevRoutingClassifierAdapter(id: string, options: JevRoutingClassifierOptions = {}): RoutingClassifierAdapter<string> {
  return {
    id,
    async classify(task, context) {
      const questions: JevQuestions = {
        category: { type: "choice", instructions: "Choose the single routing category that best matches the request.", criteria: Object.fromEntries(CATEGORIES.map((value) => [value, value])) },
        modelClass: { type: "choice", instructions: "Choose the minimum suitable model capability class. light is trivial, standard is normal work, expert is difficult reasoning or implementation, frontier is highest-stakes or exceptionally hard.", criteria: Object.fromEntries(CLASSES.map((value) => [value, value])) },
        confidence: { type: "noul", instructions: "How confident are you in both choices?" },
        tools: { type: "noul", instructions: "Does this task require tool use?" },
        vision: { type: "noul", instructions: "Does this task require visual/image input?" },
        structuredOutput: { type: "noul", instructions: "Does this task require strict structured output?" },
      };
      const state = `keryx routing request:\n${redactSensitiveText(task.slice(0, 4_000))}`;
      preflightBudget(state, questions);
      const result = await callJevSystemOne(options.fetch ?? globalThis.fetch, {
        model: options.model ?? DEFAULT_JEV_MODEL,
        state,
        questions,
      }, {
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.dir === undefined ? {} : { dir: options.dir }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        signal: context.signal,
      });
      const category = result.answers.category;
      const modelClass = result.answers.modelClass;
      const confidence = result.answers.confidence;
      if (category?.type !== "choice" || modelClass?.type !== "choice" || confidence?.type !== "noul") throw new Error("Jev classifier response is incomplete");
      const requiredCapabilities = CAPABILITIES.filter((capability) => {
        const key = capability === "structured-output" ? "structuredOutput" : capability;
        const answer = result.answers[key];
        return answer?.type === "noul" && answer.noul >= 0.5;
      });
      return { category: category.choice, modelClass: modelClass.choice, confidence: confidence.noul, reasonCode: "jev-task-classification", requiredCapabilities };
    },
  };
}
