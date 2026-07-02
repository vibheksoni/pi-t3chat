/**
 * t3.chat streaming chat via SSE.
 *
 * POST https://t3.chat/api/chat
 * Body: JSON { messages, model, threadId, convexSessionId, config }
 * Response: SSE stream with text-delta, reasoning-delta, finish, etc.
 *
 * Tries wreq-js (TLS impersonation) first, falls back to standard fetch.
 */
import { parseSSEStream, type SSEEvent } from "./sse";
import { buildConfigObject, type ChatConfig } from "./config";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; base64Data: string };

export interface ChatHistoryItem {
  role: "user" | "assistant" | "system" | "tool";
  content: string | ContentPart[];
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; name: string; arguments: string }>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export type ChatEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call_start"; id: string; name: string }
  | { kind: "tool_call_args"; argsDelta: string; id?: string }
  | { kind: "tool_output"; id: string; output: string }
  | { kind: "image"; base64Data: string; mimeType: string }
  | { kind: "image_url"; url: string }
  | { kind: "finish"; reason: "stop" | "tool_calls" | "length" | "content_filter" }
  | { kind: "error"; message: string };

export interface ChatRequest {
  cookies: string;
  convexSessionId: string;
  model: string;
  messages: ChatHistoryItem[];
  threadId?: string;
  config?: ChatConfig;
  tools?: ToolDef[];
  signal?: AbortSignal;
}

export class T3ChatError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "T3ChatError";
  }
}

const T3_BASE_URL = "https://t3.chat";
const CHAT_TIMEOUT_MS = 120_000;

function normalizeContent(content: string | ContentPart[] | unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content as Array<Record<string, unknown>>;
  return parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

function buildMessagesPayload(messages: ChatHistoryItem[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const text = normalizeContent(m.content);
    const out: Record<string, unknown> = { role: m.role, content: text };
    if (m.role === "tool" && m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: tc.arguments },
      }));
    }
    return out;
  });
}

function mapSSEEvent(ev: SSEEvent): ChatEvent | null {
  switch (ev.type) {
    case "text-delta":
      return { kind: "text", text: ev.text };
    case "reasoning-delta":
      return { kind: "reasoning", text: ev.text };
    case "tool-input-start":
      return { kind: "tool_call_start", id: ev.id, name: ev.name };
    case "tool-input-available":
      return { kind: "tool_call_args", argsDelta: ev.input, id: ev.id };
    case "tool-output-available":
      return { kind: "tool_output", id: ev.id, output: ev.output };
    case "image":
      return { kind: "image", base64Data: ev.base64Data, mimeType: ev.mimeType };
    case "image-url":
      return { kind: "image_url", url: ev.url };
    case "finish":
      return { kind: "finish", reason: ev.reason };
    case "error":
      return { kind: "error", message: ev.message };
    default:
      return null;
  }
}

export async function* streamChat(req: ChatRequest): AsyncGenerator<ChatEvent> {
  const threadId = req.threadId ?? crypto.randomUUID();
  const body = JSON.stringify({
    messages: buildMessagesPayload(req.messages),
    model: req.model,
    threadId,
    convexSessionId: req.convexSessionId,
    config: buildConfigObject(req.config),
  });

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(
    () => timeoutController.abort(new Error(`Chat timeout (${CHAT_TIMEOUT_MS}ms)`)),
    CHAT_TIMEOUT_MS,
  );

  const signal = req.signal
    ? AbortSignal.any([req.signal, timeoutController.signal])
    : timeoutController.signal;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Cookie: req.cookies,
    Referer: "https://t3.chat/",
    Origin: "https://t3.chat",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };

  let resp: { ok: boolean; status: number; text: () => Promise<string>; body: ReadableStream<Uint8Array> | null };
  try {
    let wreqResp: { ok: boolean; status: number; text: () => Promise<string>; body: ReadableStream<Uint8Array> | null } | null = null;
    try {
      const wreq = await import("wreq-js");
      if (typeof wreq.fetch === "function") {
        wreqResp = await wreq.fetch(`${T3_BASE_URL}/api/chat`, {
          method: "POST",
          headers,
          body,
          signal,
          browser: "chrome_142",
        });
      }
    } catch {}
    if (wreqResp) {
      resp = wreqResp;
    } else {
      const fetchResp = await fetch(`${T3_BASE_URL}/api/chat`, { method: "POST", headers, body, signal });
      resp = {
        ok: fetchResp.ok,
        status: fetchResp.status,
        text: () => fetchResp.text(),
        body: fetchResp.body,
      };
    }
  } finally {
    clearTimeout(timeoutTimer);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new T3ChatError(`t3.chat HTTP ${resp.status}: ${text.slice(0, 400)}`, resp.status);
  }

  if (!resp.body) throw new T3ChatError("t3.chat response had no body stream");

  const reader = resp.body.getReader();
  let sawFinish = false;
  let sawToolCalls = false;

  for await (const ev of parseSSEStream(reader, signal)) {
    const mapped = mapSSEEvent(ev);
    if (!mapped) continue;
    if (mapped.kind === "finish") sawFinish = true;
    if (mapped.kind === "tool_call_start" || mapped.kind === "tool_call_args") sawToolCalls = true;
    yield mapped;
  }

  if (!sawFinish) {
    yield { kind: "finish", reason: sawToolCalls ? "tool_calls" : "stop" };
  }
}

/**
 * Non-streaming chat — collects all events and returns the full text.
 */
export async function chat(req: ChatRequest): Promise<{
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter";
}> {
  let content = "";
  let reasoning = "";
  const toolCalls: Array<{ id: string; name: string; args: string }> = [];
  let currentToolCall: { id: string; name: string; args: string } | null = null;
  let finishReason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";

  for await (const ev of streamChat(req)) {
    switch (ev.kind) {
      case "text":
        content += ev.text;
        break;
      case "reasoning":
        reasoning += ev.text;
        break;
      case "tool_call_start":
        currentToolCall = { id: ev.id, name: ev.name, args: "" };
        toolCalls.push(currentToolCall);
        break;
      case "tool_call_args":
        if (currentToolCall) currentToolCall.args += ev.argsDelta;
        break;
      case "finish":
        finishReason = ev.reason;
        break;
    }
  }

  if (toolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

  return { content, reasoning, toolCalls, finishReason };
}
