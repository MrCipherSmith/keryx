import { TemporalValidationError, validateAsOf } from "./temporal";
import { MEMORY_CLASS_VALUES, MEMORY_STATUS_VALUES } from "./types";
import type { MemoryConfig, SearchFilters } from "./types";

export const MAX_GENERAL_RESULTS = 100;
export const MAX_AUTOMATIC_RESULTS = 20;
export const MAX_QUERY_BYTES = 4096;
export const MAX_AGENT_EXCERPT_BYTES = 2000;

export class MemoryValidationError extends Error {
  readonly code = "invalid-memory-input";
  constructor(
    readonly field: string,
    detail: string,
    readonly action = "Correct the value and try again.",
  ) {
    super(`${field}: ${detail} ${action}`);
    this.name = "MemoryValidationError";
  }
}

export function validateQuery(query: string): string {
  if (typeof query !== "string" || query.trim().length === 0) {
    throw new MemoryValidationError("query", "is required", "Provide a non-empty search query.");
  }
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw new MemoryValidationError("query", `must be at most ${MAX_QUERY_BYTES} UTF-8 bytes`, "Shorten the query and try again.");
  }
  return query;
}

export function validateSearchFilters(filters: SearchFilters, now: Date): SearchFilters {
  if (filters.status !== undefined && !MEMORY_STATUS_VALUES.includes(filters.status)) {
    throw new MemoryValidationError("status", `must be one of: ${MEMORY_STATUS_VALUES.join(", ")}`, "Use a supported memory status.");
  }
  if (filters.class !== undefined && !MEMORY_CLASS_VALUES.includes(filters.class)) {
    throw new MemoryValidationError("class", `must be one of: ${MEMORY_CLASS_VALUES.join(", ")}`, "Use a supported memory class.");
  }
  if (filters.limit !== undefined) {
    validateLimit(filters.limit, "limit", MAX_GENERAL_RESULTS);
  }
  if (filters.asOf !== undefined) {
    try {
      validateAsOf(filters.asOf, now);
    } catch (error) {
      if (error instanceof TemporalValidationError) {
        throw new MemoryValidationError(error.field, error.message, error.action);
      }
      throw error;
    }
  }
  return filters;
}

export function validateLimit(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new MemoryValidationError(field, `must be an integer from 1 to ${maximum}`, `Choose a value in that range.`);
  }
  return value;
}

export function validateByteLimit(value: unknown, field: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new MemoryValidationError(field, `must be an integer byte bound from 1 to ${maximum}`, `Choose a value in that range.`);
  }
  return value;
}

export function validateMemoryConfig(config: MemoryConfig): MemoryConfig {
  validateLimit(config.ranking.maxResults, "ranking.maxResults", MAX_GENERAL_RESULTS);
  validateLimit(config.index.k, "index.k", MAX_GENERAL_RESULTS);
  validateLimit(config.typing.injectLimit, "typing.injectLimit", MAX_AUTOMATIC_RESULTS);
  for (const cls of config.typing.injectClasses) {
    if (!MEMORY_CLASS_VALUES.includes(cls)) {
      throw new MemoryValidationError("typing.injectClasses", `contains unsupported class ${JSON.stringify(cls)}`, "Use semantic, episodic, or procedural.");
    }
  }
  if (config.index.minScore < 0 || config.index.minScore > 1 || !Number.isFinite(config.index.minScore)) {
    throw new MemoryValidationError("index.minScore", "must be between 0 and 1", "Choose a score in that range.");
  }
  return config;
}
