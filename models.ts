/**
 * Model resolution — catalog is the single source of truth.
 *
 * Resolves user-provided model names to t3.chat model IDs.
 * Falls back to pass-through if no catalog entry matches.
 */

import type { ModelInfo } from "./catalog";

export interface ResolvedModel {
  modelId: string;
  label: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

export async function resolveModelName(
  modelName: string,
): Promise<ResolvedModel> {
  const { getCachedCatalog } = await import("./catalog");
  const catalog = await getCachedCatalog();
  if (!catalog) return { modelId: modelName, label: modelName };

  const lower = modelName.toLowerCase();

  if (catalog.byId.has(modelName)) {
    const entry = catalog.byId.get(modelName)!;
    return {
      modelId: entry.id,
      label: entry.name,
      contextWindow: entry.limits.appMaxInputTokens || undefined,
      maxOutputTokens: entry.limits.appMaxOutputTokens || undefined,
    };
  }

  for (const [id, entry] of catalog.byId) {
    if (id.toLowerCase() === lower) {
      return {
        modelId: entry.id,
        label: entry.name,
        contextWindow: entry.limits.appMaxInputTokens || undefined,
        maxOutputTokens: entry.limits.appMaxOutputTokens || undefined,
      };
    }
  }

  for (const [, entry] of catalog.byId) {
    if (entry.name.toLowerCase() === lower) {
      return {
        modelId: entry.id,
        label: entry.name,
        contextWindow: entry.limits.appMaxInputTokens || undefined,
        maxOutputTokens: entry.limits.appMaxOutputTokens || undefined,
      };
    }
  }

  const normalized = lower.replace(/[^a-z0-9]/g, "");
  for (const [id, entry] of catalog.byId) {
    const idNorm = id.toLowerCase().replace(/[^a-z0-9]/g, "");
    const nameNorm = entry.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (idNorm === normalized || nameNorm === normalized) {
      return {
        modelId: entry.id,
        label: entry.name,
        contextWindow: entry.limits.appMaxInputTokens || undefined,
        maxOutputTokens: entry.limits.appMaxOutputTokens || undefined,
      };
    }
  }

  return { modelId: modelName, label: modelName };
}

export function getDefaultModel(): string {
  return "gemini-2.5-flash-lite";
}

export function getCanonicalModels(): string[] {
  return [];
}

export function modelToPiModel(m: ModelInfo) {
  const ctx = m.limits.appMaxInputTokens ?? 0;
  const maxOut = m.limits.appMaxOutputTokens ?? 0;
  const tags: string[] = [];
  if (m.premium) tags.push("Premium");
  if (m.legacy) tags.push("Legacy");
  if (m.requiresPro) tags.push("Pro");
  const tagStr = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
  const ctxStr = ctx > 0 ? ` (${ctx >= 1_000_000 ? `${Math.round(ctx / 1_000_000)}M` : `${Math.round(ctx / 1000)}K`})` : "";
  const f = m.features;
  return {
    id: m.id,
    name: `${m.name}${tagStr}${ctxStr}`,
    reasoning: f.includes("reasoning"),
    input: ["text", ...(f.includes("images") ? ["image"] : [])] as ("text" | "image")[],
    cost: {
      input: m.cost.input * 1_000_000,
      output: m.cost.output * 1_000_000,
      cacheRead: m.cost.cacheRead * 1_000_000,
      cacheWrite: m.cost.cacheWrite * 1_000_000,
    },
    contextWindow: ctx || 1,
    maxTokens: maxOut || 1,
  };
}
