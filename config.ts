/**
 * Chat config options for t3.chat API.
 *
 * Maps to the `config` object in the /api/chat request body.
 */

export type ReasoningEffort = "low" | "medium" | "high";

export interface ChatConfig {
  reasoningEffort?: ReasoningEffort;
  includeSearch?: boolean;
}

export function defaultConfig(): ChatConfig {
  return {
    reasoningEffort: "medium",
    includeSearch: false,
  };
}

export function buildConfigObject(config?: ChatConfig): Record<string, unknown> {
  if (!config) return {};
  const out: Record<string, unknown> = {};
  if (config.reasoningEffort) out.reasoningEffort = config.reasoningEffort;
  if (config.includeSearch !== undefined) out.includeSearch = config.includeSearch;
  return out;
}
