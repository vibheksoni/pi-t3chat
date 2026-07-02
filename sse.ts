/**
 * SSE (Server-Sent Events) stream parser for t3.chat chat API responses.
 *
 * t3.chat /api/chat returns SSE with event types:
 *   start, text-delta, reasoning-start, reasoning-delta,
 *   finish-step, finish, tool-input-start, tool-input-available,
 *   tool-output-available
 *
 * Each line is prefixed with "data: " and contains JSON.
 */

export type SSEEvent =
  | { type: "start"; threadId?: string }
  | { type: "text-delta"; text: string }
  | { type: "reasoning-start" }
  | { type: "reasoning-delta"; text: string }
  | { type: "finish-step" }
  | { type: "finish"; reason: "stop" | "length" | "content_filter" }
  | { type: "tool-input-start"; id: string; name: string }
  | { type: "tool-input-available"; id: string; input: string }
  | { type: "tool-output-available"; id: string; output: string }
  | { type: "image"; base64Data: string; mimeType: string }
  | { type: "image-url"; url: string }
  | { type: "error"; message: string }
  | { type: "unknown"; raw: string };

export async function* parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;
        yield parseSSEData(data);
      }
    }
    if (buffer.trim().startsWith("data: ")) {
      const data = buffer.trim().slice(6);
      if (data && data !== "[DONE]") yield parseSSEData(data);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function extractText(json: Record<string, unknown>): string {
  const delta = json.delta;
  if (typeof delta === "string") return delta;
  if (delta && typeof delta === "object") {
    const deltaObj = delta as Record<string, unknown>;
    if (typeof deltaObj.text === "string") return deltaObj.text;
  }
  if (typeof json.text === "string") return json.text;
  if (Array.isArray(json.content)) {
    return (json.content as Array<Record<string, unknown>>)
      .filter((item) => typeof item.text === "string")
      .map((item) => item.text as string)
      .join("");
  }
  return "";
}

function parseSSEData(data: string): SSEEvent {
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    const eventType = json.type as string | undefined;

    switch (eventType) {
      case "start":
        return { type: "start", threadId: json.threadId as string | undefined };
      case "text-delta":
      case "text":
        return { type: "text-delta", text: extractText(json) };
      case "reasoning-start":
        return { type: "reasoning-start" };
      case "reasoning-delta":
        return { type: "reasoning-delta", text: extractText(json) };
      case "finish-step":
        return { type: "finish-step" };
      case "finish":
        return { type: "finish", reason: (json.reason as "stop" | "length" | "content_filter") ?? "stop" };
      case "tool-input-start":
        return { type: "tool-input-start", id: json.id as string, name: json.name as string };
      case "tool-input-available":
        return { type: "tool-input-available", id: json.id as string, input: json.input as string };
      case "tool-output-available":
        return { type: "tool-output-available", id: json.id as string, output: json.output as string };
      case "image-gen":
        return { type: "image-url", url: (json.url as string ?? json.content as string ?? "") };
      default:
        if (json.base64Data || json.base64_data) {
          return { type: "image", base64Data: (json.base64Data ?? json.base64_data) as string, mimeType: (json.mimeType ?? "image/png") as string };
        }
        if (json.imageUrl || json.image_url) {
          return { type: "image-url", url: (json.imageUrl ?? json.image_url) as string };
        }
        if (json.error) {
          return { type: "error", message: json.error as string };
        }
        return { type: "unknown", raw: data };
    }
  } catch {
    return { type: "unknown", raw: data };
  }
}
