import type { OpenAIToolDef } from "./tools";
import { parseToolCalls, stripToolBlocks } from "./tools";

const WRAPPER_LIST_MCPS = "list_mcps";
const WRAPPER_LIST_TOOLS = "list_mcp_tools";
const WRAPPER_CALL_MCP = "call_mcp";
const MAX_WRAPPER_ROUNDS = 6;

interface McpToolEntry {
  name: string;
  clientToolName: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface McpGroup {
  name: string;
  tools: McpToolEntry[];
}

function toolNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sharedPrefixCounts(tools: OpenAIToolDef[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const name = (tool.function?.name ?? "").trim();
    if (!name || !name.startsWith("mcp__")) continue;
    const rest = name.slice(5);
    const parts = rest.split("_").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const prefix = "mcp__" + parts.slice(0, i).join("_");
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
  }
  return counts;
}

function inferMcpGroup(
  tool: OpenAIToolDef,
  prefixCounts: Map<string, number>,
): [string, string] | null {
  const name = (tool.function?.name ?? "").trim();
  if (!name || !name.startsWith("mcp__")) return null;
  const rest = name.slice(5);
  if (!rest) return null;

  if (rest.includes("_mcp_")) {
    const idx = rest.indexOf("_mcp_");
    const before = rest.slice(0, idx);
    const after = rest.slice(idx + 5);
    if (before && after) return [`mcp__${before}_mcp`, after];
  }

  const shared: string[] = [];
  for (const [prefix, count] of prefixCounts) {
    if (count >= 2 && name.startsWith(prefix + "_")) shared.push(prefix);
  }
  if (shared.length > 0) {
    const group = shared.sort((a, b) => b.length - a.length)[0];
    return [group, name.slice(group.length + 1)];
  }

  const parts = rest.split("_").filter(Boolean);
  if (parts.length >= 2) return [`mcp__${parts[0]}`, parts.slice(1).join("_")];
  return null;
}

export function buildMcpGroups(tools: OpenAIToolDef[] | null | undefined): Map<string, McpGroup> {
  const groups = new Map<string, McpGroup>();
  if (!tools || tools.length === 0) return groups;

  const mcpTools = tools.filter((t) => (t.function?.name ?? "").startsWith("mcp__"));
  if (mcpTools.length === 0) return groups;

  const prefixCounts = sharedPrefixCounts(mcpTools);
  const seen = new Set<string>();

  for (const tool of mcpTools) {
    const inferred = inferMcpGroup(tool, prefixCounts);
    if (!inferred) continue;
    const [groupName, toolName] = inferred;
    if (!groupName || !toolName) continue;
    const key = `${groupName}::${toolName}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const group = groups.get(groupName) ?? { name: groupName, tools: [] };
    group.tools.push({
      name: toolName,
      clientToolName: tool.function?.name ?? toolName,
      description: tool.function?.description ?? "",
      parameters: (tool.function?.parameters ?? {}) as Record<string, unknown>,
    });
    groups.set(groupName, group);
  }
  return groups;
}

export function mcpGroupToolNames(groups: Map<string, McpGroup>): Set<string> {
  const names = new Set<string>();
  for (const group of groups.values()) {
    for (const tool of group.tools) {
      if (tool.clientToolName) names.add(tool.clientToolName);
    }
  }
  return names;
}

export function splitMcpTools(
  tools: OpenAIToolDef[] | null | undefined,
): { mcpTools: OpenAIToolDef[]; regularTools: OpenAIToolDef[]; groups: Map<string, McpGroup> } {
  const mcpTools: OpenAIToolDef[] = [];
  const regularTools: OpenAIToolDef[] = [];
  if (!tools) return { mcpTools, regularTools, groups: new Map() };

  for (const tool of tools) {
    if ((tool.function?.name ?? "").startsWith("mcp__")) {
      mcpTools.push(tool);
    } else {
      regularTools.push(tool);
    }
  }
  const groups = buildMcpGroups(mcpTools);
  return { mcpTools, regularTools, groups };
}

export function mcpWrapperSystemPrompt(groups: Map<string, McpGroup>): string {
  if (groups.size === 0) return "";
  const groupNames = [...groups.keys()].sort();
  const lines: string[] = [
    "",
    "MCP TOOL DISCOVERY (for mcp__ prefixed tools only):",
    "Instead of listing every MCP tool upfront, discover them on-demand using three wrapper tools.",
    "",
    "WRAPPER TOOLS:",
    `- \`\`\`tool:${WRAPPER_LIST_MCPS}\n\`\`\` — List all available MCP groups.`,
    `- \`\`\`tool:${WRAPPER_LIST_TOOLS}\nmcp_name="<group>"\n\`\`\` — List tools in one MCP group.`,
    `- \`\`\`tool:${WRAPPER_CALL_MCP}\nmcp_name="<group>" tool_name="<tool>"\n{"arg":"value"}\n\`\`\` — Call a specific MCP tool.`,
    "",
    "WORKFLOW: call list_mcps → list_mcp_tools → call_mcp → use results.",
    "",
    `Available MCP groups: ${groupNames.join(", ")}`,
    "",
    "RULES:",
    "1. Call list_mcps first to see available MCP groups.",
    "2. Use exact group and tool names returned by wrapper calls.",
    "3. Put JSON arguments in the block body for call_mcp.",
  ];
  return lines.join("\n");
}

function resolveMcpGroup(groups: Map<string, McpGroup>, mcpName: string): McpGroup | null {
  if (groups.size === 0) return null;
  const sortedNames = [...groups.keys()].sort();
  const sourceMatch = mcpName.trim().toLowerCase().match(/^source_?0*([1-9]\d*)$/);
  if (sourceMatch) {
    const idx = parseInt(sourceMatch[1]) - 1;
    if (idx >= 0 && idx < sortedNames.length) return groups.get(sortedNames[idx]) ?? null;
  }
  if (groups.has(mcpName)) return groups.get(mcpName) ?? null;
  const wanted = toolNameKey(mcpName);
  const aliases = new Map<string, McpGroup>();
  for (const [name, group] of groups) {
    aliases.set(toolNameKey(name), group);
    if (name.startsWith("mcp__")) aliases.set(toolNameKey(name.slice(5)), group);
  }
  if (aliases.has(wanted)) return aliases.get(wanted) ?? null;
  for (const [key, group] of aliases) {
    if (wanted && (wanted.includes(key) || key.includes(wanted))) return group;
  }
  return null;
}

function resolveMcpTool(group: McpGroup, toolName: string): McpToolEntry | null {
  const wanted = toolNameKey(toolName);
  for (const tool of group.tools) {
    if (toolNameKey(tool.name) === wanted) return tool;
    if (tool.clientToolName && toolNameKey(tool.clientToolName) === wanted) return tool;
  }
  for (const tool of group.tools) {
    const key = toolNameKey(`${tool.name} ${tool.description}`);
    if (wanted && (key.includes(wanted) || wanted.includes(key))) return tool;
  }
  return null;
}

function modelSourceName(groups: Map<string, McpGroup>, groupName: string): string {
  const sorted = [...groups.keys()].sort();
  const idx = sorted.indexOf(groupName);
  return `source_${String(idx >= 0 ? idx + 1 : 1).padStart(2, "0")}`;
}

function listMcpsResult(groups: Map<string, McpGroup>): string {
  const sorted = [...groups.keys()].sort();
  return JSON.stringify({
    mcps: sorted.map((name) => {
      const group = groups.get(name)!;
      return {
        mcp_name: group.name,
        alias: modelSourceName(groups, group.name),
        tool_count: group.tools.length,
        tools_preview: group.tools.slice(0, 8).map((t) => t.name),
      };
    }),
  }, null, 2);
}

function listToolsResult(groups: Map<string, McpGroup>, mcpName: string): string {
  const group = resolveMcpGroup(groups, mcpName);
  if (!group) {
    return JSON.stringify({
      error: `MCP group '${mcpName}' not found.`,
      available_mcps: [...groups.keys()].sort().map((name) => ({
        mcp_name: name,
        alias: modelSourceName(groups, name),
      })),
    }, null, 2);
  }
  return JSON.stringify({
    mcp_name: group.name,
    alias: modelSourceName(groups, group.name),
    tools: group.tools.map((t) => ({
      name: t.name,
      client_tool_name: t.clientToolName,
      description: t.description,
      parameters: t.parameters,
    })),
  }, null, 2);
}

function parseCallMcpArgs(
  body: string,
  params: Record<string, unknown>,
): { mcpName: string; toolName: string; args: Record<string, unknown> } | null {
  let mcpName = String(params.mcp_name ?? params.source_name ?? params.server ?? "").trim();
  let toolName = String(params.tool_name ?? params.name ?? "").trim();
  let args = params.arguments;

  if (!mcpName || !toolName) {
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        mcpName = mcpName || String(parsed.mcp_name ?? "").trim();
        toolName = toolName || String(parsed.tool_name ?? "").trim();
        args = args ?? parsed.arguments;
      }
    } catch {}
  }

  if (!mcpName || !toolName) return null;
  if (!args || typeof args !== "object") args = {};
  return { mcpName, toolName, args: args as Record<string, unknown> };
}

export interface WrapperResult {
  handled: boolean;
  internalResults: Array<{ name: string; result: string }>;
  translatedCalls: Array<{ id: string; name: string; arguments: string }>;
  passthroughText: string;
}

export function handleWrapperCalls(
  text: string,
  groups: Map<string, McpGroup>,
): WrapperResult {
  const calls = parseToolCalls(text);
  if (calls.length === 0) {
    return { handled: false, internalResults: [], translatedCalls: [], passthroughText: text };
  }

  const internalResults: Array<{ name: string; result: string }> = [];
  const translatedCalls: Array<{ id: string; name: string; arguments: string }> = [];
  const passthroughBlocks: string[] = [];
  let handled = false;

  for (const call of calls) {
    const key = toolNameKey(call.name);

    if (key === toolNameKey(WRAPPER_LIST_MCPS)) {
      handled = true;
      internalResults.push({ name: WRAPPER_LIST_MCPS, result: listMcpsResult(groups) });
    } else if (key === toolNameKey(WRAPPER_LIST_TOOLS)) {
      handled = true;
      const mcpName = String(call.params.mcp_name ?? call.params.source_name ?? "").trim();
      internalResults.push({ name: WRAPPER_LIST_TOOLS, result: listToolsResult(groups, mcpName) });
    } else if (key === toolNameKey(WRAPPER_CALL_MCP)) {
      handled = true;
      const parsed = parseCallMcpArgs(call.body, call.params);
      if (!parsed) {
        internalResults.push({
          name: WRAPPER_CALL_MCP,
          result: "call_mcp requires mcp_name, tool_name, and arguments.",
        });
        continue;
      }
      const group = resolveMcpGroup(groups, parsed.mcpName);
      if (!group) {
        internalResults.push({
          name: WRAPPER_CALL_MCP,
          result: `MCP group '${parsed.mcpName}' not found. Available: ${[...groups.keys()].sort().join(", ")}`,
        });
        continue;
      }
      const tool = resolveMcpTool(group, parsed.toolName);
      if (!tool) {
        internalResults.push({
          name: WRAPPER_CALL_MCP,
          result: `Tool '${parsed.toolName}' not found in '${group.name}'. Available: ${group.tools.map((t) => t.name).join(", ")}`,
        });
        continue;
      }
      translatedCalls.push({
        id: `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name: tool.clientToolName,
        arguments: JSON.stringify(parsed.args),
      });
    } else {
      passthroughBlocks.push(call.raw);
    }
  }

  const passthroughText = passthroughBlocks.length > 0
    ? stripToolBlocks(text) + "\n" + passthroughBlocks.join("\n")
    : stripToolBlocks(text);

  return { handled, internalResults, translatedCalls, passthroughText };
}

export function wrapperResultsToUserMessage(results: Array<{ name: string; result: string }>): string {
  const parts: string[] = [];
  for (const r of results) {
    parts.push(`[Tool result: ${r.name}]\n${r.result}`);
  }
  return parts.join("\n\n");
}

export { MAX_WRAPPER_ROUNDS };
