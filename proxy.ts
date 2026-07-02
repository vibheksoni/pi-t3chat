/**
 * OpenAI-compatible HTTP proxy → t3.chat SSE.
 *
 * Binds at 127.0.0.1:42101 (or fallback port). Accepts standard
 * /v1/chat/completions and /v1/models requests, translates to
 * t3.chat's /api/chat SSE format.
 *
 * Uses wreq-js for TLS impersonation on all t3.chat requests.
 */
import * as crypto from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { streamChat, type ChatHistoryItem } from "./chat";
import { resolveModelName, getDefaultModel, getCanonicalModels } from "./models";
import { loadCredentials, type T3Credentials } from "./auth";
import { getCachedCatalog } from "./catalog";
import {
  type OpenAIToolDef,
  ToolRegistry,
  ToolCallTranslator,
  ToolRefusalDetector,
  ToolCallDeltaAccumulator,
  chatMessagesToApiPayload,
  toolsToSystemPrompt,
  toolsToUserReminder,
  stripToolBlocks,
  normalizeStreamedToolCalls,
  toolCorrectionPrompt,
} from "./tools";
import {
  splitMcpTools,
  mcpWrapperSystemPrompt,
  mcpGroupToolNames,
  handleWrapperCalls,
  wrapperResultsToUserMessage,
  MAX_WRAPPER_ROUNDS,
} from "./mcp";
import { logInfo } from "./log";
import { estimateTokens, estimatePromptTokens } from "./tokens";

const T3_PROXY_HOST = "127.0.0.1";
const T3_PROXY_PORT = 42101;

export const PROXY_SECRET: string = crypto.randomBytes(32).toString("hex");

export let proxyCredentials: T3Credentials | null = null;
export function setProxyCredentials(creds: T3Credentials | null): void {
  proxyCredentials = creds;
}

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
    tool_call_id?: string;
    name?: string;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  providerOptions?: Record<string, unknown>;
}

function openAIError(status: number, message: string): { status: number; body: string; contentType: string } {
  return {
    status,
    body: JSON.stringify({ error: { message, type: "t3chat_error", param: null, code: null } }),
    contentType: "application/json",
  };
}

async function authorizeRequest(req: IncomingMessage): Promise<{ status: number; body: string; contentType: string } | null> {
  const authHeader = (req.headers.authorization ?? "") as string;
  if (!authHeader.startsWith("Bearer ")) {
    return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: missing Authorization header.", type: "t3chat_error" } }), contentType: "application/json" };
  }
  const presented = authHeader.slice("Bearer ".length);
  const presentedBuf = Buffer.from(presented, "utf8");
  const secretBuf = Buffer.from(PROXY_SECRET, "utf8");
  if (presentedBuf.length === secretBuf.length && crypto.timingSafeEqual(presentedBuf, secretBuf)) return null;
  return { status: 401, body: JSON.stringify({ error: { message: "Unauthorized: Invalid Bearer token.", type: "t3chat_error" } }), contentType: "application/json" };
}

function getBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${T3_PROXY_HOST}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const authErr = await authorizeRequest(req);
    if (authErr) {
      res.writeHead(authErr.status, { "Content-Type": authErr.contentType });
      res.end(authErr.body);
      return;
    }

    if (url.pathname === "/v1/models" || url.pathname === "/models") {
      const catalog = await getCachedCatalog();
      const modelIds = catalog ? [...catalog.byId.keys()] : getCanonicalModels();
      const data = modelIds.map((id) => ({ id, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "t3chat" }));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data }));
      return;
    }

    if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Method not allowed; use POST." } }));
        return;
      }

      const rawBody = await getBody(req);
      let requestBody: ChatCompletionRequest;
      try {
        requestBody = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Malformed JSON." } }));
        return;
      }

      if (!requestBody.messages || !Array.isArray(requestBody.messages)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "messages must be an array." } }));
        return;
      }

      const diskCreds = loadCredentials();
      const creds = diskCreds ?? proxyCredentials;
      if (!creds) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Not authenticated. Run /login t3chat first." } }));
        return;
      }

      const requestedModel = requestBody.model || getDefaultModel();
      const resolved = await resolveModelName(requestedModel);
      logInfo(`t3chat-proxy: model=${requestedModel} → id=${resolved.modelId}`);

      const toolsRaw: OpenAIToolDef[] | null = (requestBody.tools && requestBody.tools.length > 0) ? requestBody.tools : null;
      const hasTools = toolsRaw !== null;

      let messages: ChatHistoryItem[];
      let mcpGroups: ReturnType<typeof splitMcpTools>["groups"] = new Map();
      let regularToolsRaw: OpenAIToolDef[] | null = null;

      if (hasTools) {
        const { mcpTools, regularTools, groups } = splitMcpTools(toolsRaw);
        mcpGroups = groups;
        regularToolsRaw = regularTools.length > 0 ? regularTools : null;
        const groupedNames = mcpGroupToolNames(groups);
        const nonMcpTools: OpenAIToolDef[] = regularTools;
        const mcpToolCount = mcpTools.length;
        const groupCount = groups.size;

        const { systemPrompt, apiMessages } = chatMessagesToApiPayload(requestBody.messages, true);
        const regularPrompt = regularToolsRaw ? toolsToSystemPrompt(regularToolsRaw) : "";
        const mcpPrompt = mcpWrapperSystemPrompt(groups);
        const fullSystem = [systemPrompt, regularPrompt, mcpPrompt].filter(Boolean).join("\n\n");

        if (apiMessages.length > 0 && apiMessages[apiMessages.length - 1].role === "user") {
          const lastIdx = apiMessages.length - 1;
          if (regularToolsRaw) {
            apiMessages[lastIdx].content = String(apiMessages[lastIdx].content) + toolsToUserReminder(regularToolsRaw);
          }
        }

        messages = [];
        if (fullSystem) messages.push({ role: "system", content: fullSystem });
        for (const m of apiMessages) {
          messages.push({ role: m.role as ChatHistoryItem["role"], content: String(m.content) });
        }
        logInfo(`t3chat-proxy: tools=${toolsRaw!.length} mcp=${mcpToolCount}(${groupCount} groups) regular=${nonMcpTools.length} prompt=${fullSystem.length}ch msgs=${messages.length}`);
      } else {
        messages = requestBody.messages.map((m) => {
          const item: ChatHistoryItem = { role: m.role as ChatHistoryItem["role"], content: m.content as ChatHistoryItem["content"] };
          if (m.role === "tool" && typeof m.tool_call_id === "string") item.tool_call_id = m.tool_call_id;
          if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            item.tool_calls = m.tool_calls
              .map((tc) => ({
                id: typeof tc.id === "string" ? tc.id : "",
                name: typeof tc.function?.name === "string" ? tc.function.name : "",
                arguments: typeof tc.function?.arguments === "string" ? tc.function.arguments : "",
              }))
              .filter((tc) => tc.id !== "" && tc.name !== "");
          }
          return item;
        });
      }

      const isStreaming = requestBody.stream !== false;

      if (isStreaming) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });

        const responseId = `chatcmpl-${crypto.randomUUID()}`;
        const abort = new AbortController();
        req.on("close", () => { if (!res.writableEnded) abort.abort(); });

        try {
          if (hasTools) {
            await streamWithTools({
              res, responseId, requestedModel, creds, resolvedModelId: resolved.modelId,
              messages, toolsRaw: regularToolsRaw ?? [], mcpGroups, signal: abort.signal,
            });
          } else {
            await streamDirect({
              res, responseId, requestedModel, creds, resolvedModelId: resolved.modelId,
              messages, signal: abort.signal,
            });
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown error";
          try {
            res.write(`data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          } catch {}
        }
      } else {
        if (hasTools) {
          await nonStreamingWithTools({
            res, requestedModel, creds, resolvedModelId: resolved.modelId,
            messages, toolsRaw: regularToolsRaw ?? [], mcpGroups,
          });
        } else {
          await nonStreamingDirect({
            res, requestedModel, creds, resolvedModelId: resolved.modelId,
            messages,
          });
        }
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `Unsupported path: ${url.pathname}` } }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message } }));
    } catch {}
  }
}

interface StreamCtx {
  res: ServerResponse;
  responseId: string;
  requestedModel: string;
  creds: T3Credentials;
  resolvedModelId: string;
  messages: ChatHistoryItem[];
  signal: AbortSignal;
}

async function streamDirect(ctx: StreamCtx): Promise<void> {
  let firstChunkSent = false;
  let toolCallIndex = -1;
  let finishReason: "stop" | "tool_calls" | "length" | "content_filter" | null = null;
  let completionText = "";

  for await (const ev of streamChat({
    cookies: ctx.creds.cookies,
    convexSessionId: ctx.creds.convexSessionId,
    model: ctx.resolvedModelId,
    messages: ctx.messages,
    signal: ctx.signal,
  })) {
    const role = firstChunkSent ? undefined : "assistant";

    if (ev.kind === "text") {
      completionText += ev.text;
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: role ? { role, content: ev.text } : { content: ev.text }, finish_reason: null }],
      })}\n\n`);
      firstChunkSent = true;
    } else if (ev.kind === "reasoning") {
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: role ? { role, reasoning: ev.text } : { reasoning: ev.text }, finish_reason: null }],
      })}\n\n`);
      firstChunkSent = true;
    } else if (ev.kind === "tool_call_start") {
      toolCallIndex += 1;
      const baseDelta = { tool_calls: [{ index: toolCallIndex, id: ev.id, type: "function", function: { name: ev.name, arguments: "" } }] };
      const delta = firstChunkSent ? baseDelta : { role: "assistant", ...baseDelta };
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta, finish_reason: null }],
      })}\n\n`);
      firstChunkSent = true;
    } else if (ev.kind === "tool_call_args") {
      if (toolCallIndex < 0) continue;
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: { tool_calls: [{ index: toolCallIndex, function: { arguments: ev.argsDelta } }] }, finish_reason: null }],
      })}\n\n`);
    } else if (ev.kind === "finish") {
      finishReason = ev.reason;
    }
  }

  const finalReason = finishReason ?? (toolCallIndex >= 0 ? "tool_calls" : "stop");
  const promptTokens = estimatePromptTokens(ctx.messages);
  const completionTokens = estimateTokens(completionText);
  ctx.res.write(`data: ${JSON.stringify({
    id: ctx.responseId, object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
    choices: [{ index: 0, delta: {}, finish_reason: finalReason }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  })}\n\n`);
  ctx.res.write("data: [DONE]\n\n");
  ctx.res.end();
}

interface ToolStreamCtx extends StreamCtx {
  toolsRaw: OpenAIToolDef[];
  mcpGroups: Map<string, { name: string; tools: Array<{ name: string; clientToolName: string; description: string; parameters: Record<string, unknown> }> }>;
}

async function streamWithTools(ctx: ToolStreamCtx): Promise<void> {
  const registry = new ToolRegistry(ctx.toolsRaw);
  const translator = new ToolCallTranslator(registry);
  const refusalDetector = new ToolRefusalDetector();
  let corrections = 0;
  const maxCorrections = 2;
  let messages = [...ctx.messages];
  let wrapperRounds = 0;
  let completionText = "";

  while (true) {
    let text = "";
    let reasoning = "";
    const accumulator = new ToolCallDeltaAccumulator();

    for await (const ev of streamChat({
      cookies: ctx.creds.cookies,
      convexSessionId: ctx.creds.convexSessionId,
      model: ctx.resolvedModelId,
      messages,
      signal: ctx.signal,
    })) {
      if (ev.kind === "text") { text += ev.text; completionText += ev.text; }
      else if (ev.kind === "reasoning") reasoning += ev.text;
      else if (ev.kind === "tool_call_start") {
        accumulator.add([{ id: ev.id, name: ev.name, arguments: "" }]);
      } else if (ev.kind === "tool_call_args") {
        accumulator.add([{ arguments: ev.argsDelta }]);
      }
    }

    const wrapperResult = handleWrapperCalls(text, ctx.mcpGroups);
    if (wrapperResult.handled && wrapperRounds < MAX_WRAPPER_ROUNDS) {
      wrapperRounds++;
      const feedbackParts: string[] = [];
      if (wrapperResult.internalResults.length > 0) {
        feedbackParts.push(wrapperResultsToUserMessage(wrapperResult.internalResults));
      }
      if (wrapperResult.translatedCalls.length > 0) {
        const allCalls = [...wrapperResult.translatedCalls];
        const streamedCalls = accumulator.snapshot();
        const parsedCalls = translator.fromTextBlocks(wrapperResult.passthroughText);
        const passthroughCalls = streamedCalls.length > 0 ? streamedCalls : parsedCalls;
        const normalizedToolCalls = normalizeStreamedToolCalls(
          allCalls.concat(passthroughCalls as unknown as typeof allCalls), ctx.toolsRaw,
        );

        if (normalizedToolCalls.length > 0) {
          if (reasoning) {
            ctx.res.write(`data: ${JSON.stringify({
              id: ctx.responseId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
              choices: [{ index: 0, delta: { role: "assistant", reasoning, reasoning_text: reasoning, reasoning_content: reasoning }, finish_reason: null }],
            })}\n\n`);
          }
          const cleanedText = stripToolBlocks(wrapperResult.passthroughText);
          if (cleanedText) {
            ctx.res.write(`data: ${JSON.stringify({
              id: ctx.responseId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
              choices: [{ index: 0, delta: { role: "assistant", content: cleanedText }, finish_reason: null }],
            })}\n\n`);
          }
          for (let i = 0; i < normalizedToolCalls.length; i++) {
            const tc = normalizedToolCalls[i];
            ctx.res.write(`data: ${JSON.stringify({
              id: ctx.responseId, object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }, finish_reason: null }],
            })}\n\n`);
          }
          ctx.res.write(`data: ${JSON.stringify({
            id: ctx.responseId, object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(completionText), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(completionText) },
          })}\n\n`);
          ctx.res.write("data: [DONE]\n\n");
          ctx.res.end();
          return;
        }
      }
      if (feedbackParts.length > 0) {
        messages = [...messages, { role: "assistant", content: text }, { role: "user", content: feedbackParts.join("\n\n") }];
        continue;
      }
    }

    const streamedCalls = accumulator.snapshot();
    const parsedCalls = translator.fromTextBlocks(text);
    const toolCalls = streamedCalls.length > 0 ? streamedCalls : parsedCalls;
    const cleanedText = parsedCalls.length > 0 ? stripToolBlocks(text) : text;
    const normalizedToolCalls = normalizeStreamedToolCalls(toolCalls, ctx.toolsRaw);

    if (normalizedToolCalls.length > 0) {
      if (reasoning) {
        ctx.res.write(`data: ${JSON.stringify({
          id: ctx.responseId, object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
          choices: [{ index: 0, delta: { role: "assistant", reasoning, reasoning_text: reasoning, reasoning_content: reasoning }, finish_reason: null }],
        })}\n\n`);
      }
      if (cleanedText) {
        ctx.res.write(`data: ${JSON.stringify({
          id: ctx.responseId, object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
          choices: [{ index: 0, delta: { role: "assistant", content: cleanedText }, finish_reason: null }],
        })}\n\n`);
      }
      for (let i = 0; i < normalizedToolCalls.length; i++) {
        const tc = normalizedToolCalls[i];
        ctx.res.write(`data: ${JSON.stringify({
          id: ctx.responseId, object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
          choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }, finish_reason: null }],
        })}\n\n`);
      }
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(completionText), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(completionText) },
      })}\n\n`);
      ctx.res.write("data: [DONE]\n\n");
      ctx.res.end();
      return;
    }

    if (corrections < maxCorrections && refusalDetector.looksLikeFalseRefusal(cleanedText)) {
      corrections++;
      logInfo(`t3chat-proxy: false refusal correction #${corrections}`);
      messages = [...messages, { role: "assistant", content: text }, { role: "user", content: toolCorrectionPrompt(registry) }];
      continue;
    }

    if (reasoning) {
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: { role: "assistant", reasoning, reasoning_text: reasoning, reasoning_content: reasoning }, finish_reason: null }],
      })}\n\n`);
    }
    if (cleanedText) {
      ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: { role: "assistant", content: cleanedText }, finish_reason: null }],
      })}\n\n`);
    }
    ctx.res.write(`data: ${JSON.stringify({
        id: ctx.responseId, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: ctx.requestedModel,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(completionText), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(completionText) },
      })}\n\n`);
    ctx.res.write("data: [DONE]\n\n");
    ctx.res.end();
    return;
  }
}

interface NonStreamCtx {
  res: ServerResponse;
  requestedModel: string;
  creds: T3Credentials;
  resolvedModelId: string;
  messages: ChatHistoryItem[];
}

async function nonStreamingDirect(ctx: NonStreamCtx): Promise<void> {
  let collected = "";
  let finishReason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";
  type TC = { id: string; name: string; args: string };
  const collectedToolCalls: TC[] = [];
  let currentTC: TC | null = null;

  for await (const ev of streamChat({
    cookies: ctx.creds.cookies,
    convexSessionId: ctx.creds.convexSessionId,
    model: ctx.resolvedModelId,
    messages: ctx.messages,
  })) {
    if (ev.kind === "text") collected += ev.text;
    else if (ev.kind === "tool_call_start") {
      currentTC = { id: ev.id, name: ev.name, args: "" };
      collectedToolCalls.push(currentTC);
    } else if (ev.kind === "tool_call_args") {
      if (currentTC) currentTC.args += ev.argsDelta;
    } else if (ev.kind === "finish") {
      finishReason = ev.reason;
    }
  }

  if (collectedToolCalls.length > 0 && finishReason === "stop") finishReason = "tool_calls";

  const assistantMessage = collectedToolCalls.length > 0
    ? { role: "assistant" as const, content: collected, tool_calls: collectedToolCalls.map((tc) => ({ id: tc.id, type: "function" as const, function: { name: tc.name, arguments: tc.args } })) }
    : { role: "assistant" as const, content: collected };

  ctx.res.writeHead(200, { "Content-Type": "application/json" });
  ctx.res.end(JSON.stringify({
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: ctx.requestedModel,
    choices: [{ index: 0, message: assistantMessage, finish_reason: finishReason }],
    usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(collected), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(collected) },
  }));
}

interface NonStreamToolCtx extends NonStreamCtx {
  toolsRaw: OpenAIToolDef[];
  mcpGroups: Map<string, { name: string; tools: Array<{ name: string; clientToolName: string; description: string; parameters: Record<string, unknown> }> }>;
}

async function nonStreamingWithTools(ctx: NonStreamToolCtx): Promise<void> {
  const registry = new ToolRegistry(ctx.toolsRaw);
  const translator = new ToolCallTranslator(registry);
  const refusalDetector = new ToolRefusalDetector();
  let corrections = 0;
  const maxCorrections = 2;
  let messages = [...ctx.messages];
  let wrapperRounds = 0;
  let completionText = "";

  while (true) {
    let text = "";
    let reasoning = "";
    const accumulator = new ToolCallDeltaAccumulator();

    for await (const ev of streamChat({
      cookies: ctx.creds.cookies,
      convexSessionId: ctx.creds.convexSessionId,
      model: ctx.resolvedModelId,
      messages,
    })) {
      if (ev.kind === "text") { text += ev.text; completionText += ev.text; }
      else if (ev.kind === "reasoning") reasoning += ev.text;
      else if (ev.kind === "tool_call_start") {
        accumulator.add([{ id: ev.id, name: ev.name, arguments: "" }]);
      } else if (ev.kind === "tool_call_args") {
        accumulator.add([{ arguments: ev.argsDelta }]);
      }
    }

    const wrapperResult = handleWrapperCalls(text, ctx.mcpGroups);
    if (wrapperResult.handled && wrapperRounds < MAX_WRAPPER_ROUNDS) {
      wrapperRounds++;
      const feedbackParts: string[] = [];
      if (wrapperResult.internalResults.length > 0) {
        feedbackParts.push(wrapperResultsToUserMessage(wrapperResult.internalResults));
      }
      if (wrapperResult.translatedCalls.length > 0) {
        const allCalls = [...wrapperResult.translatedCalls];
        const streamedCalls = accumulator.snapshot();
        const parsedCalls = translator.fromTextBlocks(wrapperResult.passthroughText);
        const passthroughCalls = streamedCalls.length > 0 ? streamedCalls : parsedCalls;
        const normalizedToolCalls = normalizeStreamedToolCalls(
          allCalls.concat(passthroughCalls as unknown as typeof allCalls), ctx.toolsRaw,
        );

        if (normalizedToolCalls.length > 0) {
          const assistantMessage: Record<string, unknown> = {
            role: "assistant",
            content: stripToolBlocks(wrapperResult.passthroughText),
            tool_calls: normalizedToolCalls.map((tc) => ({
              id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
            })),
          };
          if (reasoning) {
            assistantMessage.reasoning = reasoning;
            assistantMessage.reasoning_text = reasoning;
            assistantMessage.reasoning_content = reasoning;
          }
          ctx.res.writeHead(200, { "Content-Type": "application/json" });
          ctx.res.end(JSON.stringify({
            id: `chatcmpl-${crypto.randomUUID()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: ctx.requestedModel,
            choices: [{ index: 0, message: assistantMessage, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(completionText), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(completionText) },
          }));
          return;
        }
      }
      if (feedbackParts.length > 0) {
        messages = [...messages, { role: "assistant", content: text }, { role: "user", content: feedbackParts.join("\n\n") }];
        continue;
      }
    }

    const streamedCalls = accumulator.snapshot();
    const parsedCalls = translator.fromTextBlocks(text);
    const toolCalls = streamedCalls.length > 0 ? streamedCalls : parsedCalls;
    const cleanedText = parsedCalls.length > 0 ? stripToolBlocks(text) : text;
    const normalizedToolCalls = normalizeStreamedToolCalls(toolCalls, ctx.toolsRaw);

    if (normalizedToolCalls.length > 0) {
      const assistantMessage: Record<string, unknown> = {
        role: "assistant",
        content: cleanedText,
        tool_calls: normalizedToolCalls.map((tc) => ({
          id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
        })),
      };
      if (reasoning) {
        assistantMessage.reasoning = reasoning;
        assistantMessage.reasoning_text = reasoning;
        assistantMessage.reasoning_content = reasoning;
      }
      ctx.res.writeHead(200, { "Content-Type": "application/json" });
      ctx.res.end(JSON.stringify({
        id: `chatcmpl-${crypto.randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: ctx.requestedModel,
        choices: [{ index: 0, message: assistantMessage, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(completionText), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(completionText) },
      }));
      return;
    }

    if (corrections < maxCorrections && refusalDetector.looksLikeFalseRefusal(cleanedText)) {
      corrections++;
      logInfo(`t3chat-proxy: false refusal correction #${corrections}`);
      messages = [...messages, { role: "assistant", content: text }, { role: "user", content: toolCorrectionPrompt(registry) }];
      continue;
    }

    const assistantMessage: Record<string, unknown> = { role: "assistant", content: cleanedText };
    if (reasoning) {
      assistantMessage.reasoning = reasoning;
      assistantMessage.reasoning_text = reasoning;
      assistantMessage.reasoning_content = reasoning;
    }
    ctx.res.writeHead(200, { "Content-Type": "application/json" });
    ctx.res.end(JSON.stringify({
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: ctx.requestedModel,
      choices: [{ index: 0, message: assistantMessage, finish_reason: "stop" }],
      usage: { prompt_tokens: estimatePromptTokens(ctx.messages), completion_tokens: estimateTokens(completionText), total_tokens: estimatePromptTokens(ctx.messages) + estimateTokens(completionText) },
    }));
    return;
  }
}

let serverInstance: ReturnType<typeof createServer> | null = null;

export function startProxy(port: number = T3_PROXY_PORT): Promise<number> {
  if (serverInstance) return Promise.resolve((serverInstance.address() as { port: number }).port);

  return new Promise((resolve, reject) => {
    const srv = createServer(handleRequest);
    srv.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        srv.listen(0, T3_PROXY_HOST, () => {
          const addr = srv.address() as { port: number };
          serverInstance = srv;
          resolve(addr.port);
        });
        return;
      }
      reject(err);
    });
    srv.listen(port, T3_PROXY_HOST, () => {
      serverInstance = srv;
      const addr = srv.address() as { port: number };
      resolve(addr.port);
    });
  });
}

export function stopProxy(): void {
  if (serverInstance) {
    try { serverInstance.close(); } catch {}
    serverInstance = null;
  }
}
