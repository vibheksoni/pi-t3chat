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
