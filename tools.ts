/**
 * Tool calling support for pi-t3chat.
 *
 * t3.chat models may not natively support OpenAI function calling.
 * This module implements the text-based tool calling protocol from
 * the NoTokenLimit VS Code extension:
 *
 * 1. Inject tool definitions into the system prompt as text
 * 2. Model emits `tool:<name>` fenced blocks in its response
 * 3. Parse blocks and convert to OpenAI tool_calls format
 * 4. Detect false refusals and retry with correction prompt
 *
 * Also supports OpenAI-native structured tool_calls from the SSE stream
 * for models that do support them natively.
 */

const TOOL_CALL_RE = /```tool:([A-Za-z0-9_.:-]+)([^\n`]*)\r?\n([\s\S]*?)```/gi;

const PARAM_RE = /([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;

export interface ToolCall {
  name: string;
  params: Record<string, unknown>;
  body: string;
  raw: string;
}

export interface ToolResult {
  name: string;
  params: Record<string, unknown>;
  ok: boolean;
  output: string;
}

export interface OpenAIToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface OpenAIToolDef {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

function getRequired(spec: OpenAIToolSpec): Set<string> {
  const rawRequired = spec.parameters?.required;
  if (!Array.isArray(rawRequired)) return new Set();
  return new Set(rawRequired.map((item) => String(item)));
}

function getProperties(spec: OpenAIToolSpec): Record<string, unknown> {
  const rawProperties = spec.parameters?.properties;
  return (rawProperties && typeof rawProperties === "object") ? rawProperties as Record<string, unknown> : {};
}

function singleBodyProperty(spec: OpenAIToolSpec): string | null {
  const properties = getProperties(spec);
  const required = getRequired(spec);

  const stringProps = Object.entries(properties)
    .filter(([, schema]) => {
      if (!schema || typeof schema !== "object") return false;
      const type = String((schema as Record<string, unknown>).type ?? "string").toLowerCase();
      return type === "string" || type === "any";
    })
    .map(([name]) => name);

  const requiredStringProps = stringProps.filter((name) => required.has(name));
  if (requiredStringProps.length === 1) return requiredStringProps[0];
  if (stringProps.length === 1) return stringProps[0];
  return "body" in properties ? "body" : null;
}

export class ToolRegistry {
  private specs = new Map<string, OpenAIToolSpec>();

  constructor(tools: OpenAIToolDef[] | null | undefined) {
    if (!tools) return;
    for (const rawTool of tools) {
      const spec = this.coerce(rawTool);
      if (spec) this.specs.set(spec.name, spec);
    }
  }

  get size(): number { return this.specs.size; }

  get names(): string[] { return [...this.specs.keys()]; }

  get(name: string): OpenAIToolSpec | undefined { return this.specs.get(name); }

  resolveName(name: string): string {
    if (this.specs.has(name)) return name;
    const lowered = name.toLowerCase();
    for (const candidate of this.specs.keys()) {
      if (candidate.toLowerCase() === lowered) return candidate;
    }
    return name;
  }

  toPrompt(): string {
    if (this.specs.size === 0) return "";

    const lines: string[] = [
      "You are running inside a host application that will execute OpenAI function tools for you.",
      "The host has provided REAL tools in this request. You do not execute actions directly in prose; you request them by emitting `tool:` fenced blocks.",
      "",
      "TOOL CALL PROTOCOL:",
      "Emit one or more fenced blocks and then stop so the host can run them:",
      "",
      "```tool:<exact_tool_name>",
      '{"argument_name":"argument value"}',
      "```",
      "",
      "You may also put simple scalar arguments on the opening line as key=value, but JSON in the block body is preferred for accuracy.",
      "Use only the exact tool names listed below. The proxy converts each block to OpenAI `tool_calls` for the client.",
      "",
      "AVAILABLE TOOLS:",
    ];

    for (const spec of this.specs.values()) {
      const properties = getProperties(spec);
      const required = getRequired(spec);
      const requiredNames = Object.keys(properties).filter((name) => required.has(name));
      const optionalNames = Object.keys(properties).filter((name) => !required.has(name));
      const desc = shorten(spec.description, 160);
      const details: string[] = [];
      if (desc) details.push(desc);
      if (requiredNames.length > 0) details.push("required: " + requiredNames.join(", "));
      if (optionalNames.length > 0) {
        details.push("optional: " + optionalNames.slice(0, 16).join(", "));
        if (optionalNames.length > 16) details.push(`+${optionalNames.length - 16} more optional args`);
      }
      lines.push(`- ${spec.name}` + (details.length > 0 ? `: ${details.join("; ")}` : ""));
    }

    lines.push(
      "",
      "RULES:",
      "1. If the user asks for information that requires any listed tool, call the relevant tool instead of explaining that you cannot.",
      "2. Do not ask the user to run commands, open files, paste file contents, or perform work that a listed tool can do.",
      "3. When you need tool results before answering, emit only tool blocks and no prose.",
      "4. After tool results arrive, continue from those results. Call more tools if needed; otherwise give the final answer.",
      "5. If a tool can access files, terminals, browsers, web search, calendars, or other external systems, treat that access as available through the host tool.",
    );

    return lines.join("\n");
  }

  private coerce(rawTool: OpenAIToolDef): OpenAIToolSpec | null {
    const func = (rawTool.function ?? rawTool) as Record<string, unknown> | undefined;
    const name = String(func?.name ?? "").trim();
    if (!name) return null;
    const params = func?.parameters ?? {};
    return {
      name,
      description: String(func?.description ?? ""),
      parameters: (params && typeof params === "object") ? params as Record<string, unknown> : {},
    };
  }
}

function shorten(value: string, limit: number): string {
  const text = String(value ?? "").split(/\s+/).join(" ");
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 3)).trimEnd() + "...";
}

export class ToolCallTranslator {
  private registry: ToolRegistry;

  constructor(registry: ToolRegistry) {
    this.registry = registry;
  }

  fromTextBlocks(text: string): Array<Record<string, unknown>> {
    const calls = parseToolCalls(text);
    return calls.map((call) => this.toOpenAIToolCall(call));
  }

  toOpenAIToolCall(call: ToolCall): Record<string, unknown> {
    const name = this.registry.resolveName(call.name);
    const spec = this.registry.get(name);
    const arguments_ = this.argumentsFor(call, spec);
    return {
      id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      name,
      arguments: JSON.stringify(arguments_),
    };
  }

  private argumentsFor(call: ToolCall, spec: OpenAIToolSpec | undefined): Record<string, unknown> {
    const args: Record<string, unknown> = { ...call.params };
    const body = call.body.trim();
    if (!body) return args;

    const parsedBody = jsonLoadsObject(body);
    if (parsedBody) {
      Object.assign(args, parsedBody);
      return args;
    }

    if (spec) {
      const target = singleBodyProperty(spec);
      if (target && !(target in args)) {
        args[target] = body;
        return args;
      }
    }

    if (!("body" in args)) args.body = body;
    return args;
  }
}

export class ToolCallDeltaAccumulator {
  private byIndex = new Map<number, Record<string, unknown>>();

  add(rawCalls: Array<Record<string, unknown>>): void {
    for (let position = 0; position < rawCalls.length; position++) {
      const rawCall = rawCalls[position];
      if (!rawCall || typeof rawCall !== "object") continue;
      const index = Number(rawCall.index ?? position) || 0;
      const current = this.byIndex.get(index) ?? { arguments: "" };
      this.byIndex.set(index, current);

      const callId = rawCall.id;
      if (callId) current.id = callId;
      const callType = rawCall.type;
      if (callType) current.type = callType;

      const fn = rawCall.function as Record<string, unknown> | undefined;
      if (fn && typeof fn === "object") {
        const name = fn.name;
        if (name) current.name = name;
        if ("arguments" in fn) {
          current.arguments = String(current.arguments ?? "") + String(fn.arguments ?? "");
        }
        continue;
      }

      if (rawCall.name) current.name = rawCall.name;
      if ("arguments" in rawCall) {
        current.arguments = String(current.arguments ?? "") + String(rawCall.arguments ?? "");
      }
    }
  }

  snapshot(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const indices = [...this.byIndex.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const item = this.byIndex.get(index)!;
      const name = String(item.name ?? "");
      if (!name) continue;
      out.push({
        id: item.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name,
        arguments: String(item.arguments ?? "{}") || "{}",
      });
    }
    return out;
  }
}

const REFUSAL_RE = /\b(can't|cannot|can not|don't have|do not have|unable to|not able to|no access|without access|can't actually|cannot actually)\b/i;
const CAPABILITY_RE = /\b(tool|terminal|shell|command|run|execute|file|filesystem|browse|browser|web search|search|calendar|schedule|environment)\b/i;

export class ToolRefusalDetector {
  looksLikeFalseRefusal(text: string): boolean {
    if (!text || text.length > 2500) return false;
    return REFUSAL_RE.test(text) && CAPABILITY_RE.test(text);
  }
}

function jsonLoadsObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return (parsed && typeof parsed === "object" && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function parseParams(paramStr: string): Record<string, unknown> {
  if (!paramStr) return {};
  const result: Record<string, unknown> = {};
  let m: RegExpExecArray | null;
  PARAM_RE.lastIndex = 0;
  while ((m = PARAM_RE.exec(paramStr)) !== null) {
    const key = m[1];
    const value = m[2] ?? m[3] ?? m[4];
    result[key] = value;
  }
  return result;
}

export function parseToolCalls(text: string): ToolCall[] {
  if (!text) return [];
  const out: ToolCall[] = [];
  let safety = 0;
  let m: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;
  while ((m = TOOL_CALL_RE.exec(text)) !== null) {
    safety++;
    if (safety > 50) break;
    const name = m[1].toLowerCase();
    const params = parseParams(m[2].trim());
    const body = m[3].replace(/^\r?\n|\r?\n$/g, "");
    out.push({ name, params, body, raw: m[0] });
  }
  return out;
}

export function toolsToSystemPrompt(tools: OpenAIToolDef[] | null | undefined): string {
  return new ToolRegistry(tools).toPrompt();
}

export function toolsToUserReminder(tools: OpenAIToolDef[] | null | undefined): string {
  const registry = new ToolRegistry(tools);
  if (registry.size === 0) return "";
  const names = registry.names.join(", ");
  return (
    `\n\n[Tool access reminder: this request includes executable host tools. ` +
    `When a listed tool can satisfy the request, emit a \`tool:<exact_tool_name>\` ` +
    `fenced block and stop for results. Available tool names: ${names}]`
  );
}

export function stripToolBlocks(text: string): string {
  if (!text) return "";
  return text.replace(TOOL_CALL_RE, "").trim();
}

export function toolResultsToMessages(results: ToolResult[]): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  for (const result of results) {
    messages.push({
      role: "tool",
      tool_call_id: crypto.randomUUID(),
      content: JSON.stringify({
        tool: result.name,
        ok: result.ok,
        output: result.output,
      }),
    });
  }
  return messages;
}

export function normalizeStreamedToolCalls(
  toolCalls: Array<Record<string, unknown>>,
  clientTools: OpenAIToolDef[] | null | undefined,
): Array<Record<string, unknown>> {
  const registry = new ToolRegistry(clientTools);
  const normalized: Array<Record<string, unknown>> = [];
  for (const tc of toolCalls) {
    if (!tc || typeof tc !== "object") continue;
    const fn = tc.function as Record<string, unknown> | undefined;
    let name: string;
    let arguments_: string;
    if (fn && typeof fn === "object") {
      name = String(fn.name ?? "");
      arguments_ = String(fn.arguments ?? "{}") || "{}";
    } else {
      name = String(tc.name ?? "");
      arguments_ = String(tc.arguments ?? "{}") || "{}";
    }
    normalized.push({
      id: tc.id ?? `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
      name: registry.resolveName(name),
      arguments: arguments_,
    });
  }
  return normalized;
}

/**
 * Convert OpenAI chat messages to t3.chat API format.
 * - System messages are collected into a system prompt
 * - Tool messages become user messages with [Tool result] prefix
 * - Assistant tool_calls are converted back to `tool:` blocks
 *
 * Returns { systemPrompt, apiMessages }.
 */
export function chatMessagesToApiPayload(
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
    tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
    tool_call_id?: string;
    name?: string;
  }>,
  forwardSystemPrompt = true,
): { systemPrompt: string; apiMessages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const apiMessages: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const text = contentText(msg.content);

    if (msg.role === "system" || msg.role === "developer") {
      if (forwardSystemPrompt) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      const toolName = msg.name ?? msg.tool_call_id ?? "tool";
      apiMessages.push({
        role: "user",
        content: `[Tool result: ${toolName}]\n${text || "[tool returned no output]"}`,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant", content: text };
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const blocks: string[] = [];
        for (const tc of msg.tool_calls) {
          const fnName = tc.function?.name ?? "";
          const argsStr = tc.function?.arguments ?? "";
          let argsDict: Record<string, unknown> = {};
          try { argsDict = argsStr ? JSON.parse(argsStr) : {}; } catch {}
          const params = Object.entries(argsDict)
            .map(([k, v]) => typeof v === "string" ? `${k}="${v}"` : `${k}=${v}`)
            .join(" ");
          blocks.push(params ? `\`\`\`tool:${fnName} ${params}\n\`\`\`` : `\`\`\`tool:${fnName}\n\`\`\``);
        }
        if (blocks.length > 0) {
          const joinedBlocks = blocks.join("\n");
          entry.content = text ? `${text}\n${joinedBlocks}` : joinedBlocks;
        }
      }
      apiMessages.push(entry);
      continue;
    }

    apiMessages.push({ role: msg.role, content: text });
  }

  return { systemPrompt: systemParts.join("\n\n"), apiMessages };
}

function contentText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);
  return content
    .filter((item) => item.type === "text" || item.type === "input_text" || item.type === "output_text")
    .map((item) => String(item.text ?? ""))
    .join("");
}

/**
 * Build a correction prompt for false refusals.
 */
export function toolCorrectionPrompt(registry: ToolRegistry): string {
  const names = registry.names.join(", ");
  return (
    "[SYSTEM TOOL CORRECTION]\n" +
    "Your previous answer said or implied that a host capability was unavailable, " +
    "but this request includes executable OpenAI tools. Re-evaluate the user's " +
    "request against the provided tool schemas. If any listed tool can perform " +
    `the needed external action, emit the correct \`tool:\` fenced block now using ` +
    `one exact tool name from this list: ${names}. Do not ask the user to run the ` +
    "tool manually. If no provided tool is relevant after checking the schemas, " +
    "answer normally and briefly."
  );
}
