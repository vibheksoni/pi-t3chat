export interface UsageData {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimatePromptTokens(messages: Array<{ role: string; content: string | unknown }>): number {
  let total = 0;
  for (const msg of messages) {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
    total += estimateTokens(content) + 4;
  }
  return total;
}

export function buildUsage(promptTokens: number, completionTokens: number): UsageData {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: {
      cached_tokens: 0,
      cache_write_tokens: 0,
    },
    completion_tokens_details: {
      reasoning_tokens: 0,
    },
  };
}
