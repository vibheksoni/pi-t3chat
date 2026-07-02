/**
 * Model discovery for t3.chat.
 *
 * t3.chat doesn't expose a model list API. Models are embedded in the
 * JavaScript bundles served from the homepage. This module scrapes
 * t3.chat, finds /assets/*.js chunks, and parses model definitions
 * from the JS using regex.
 *
 * Tries wreq-js (TLS impersonation) first, falls back to standard fetch.
 */
import { logError } from "./log";

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  developer: string;
  requiresPro: boolean;
  premium: boolean;
  disabled: boolean;
  legacy: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    fixed: number;
  };
  limits: {
    appMaxInputTokens: number;
    appMaxOutputTokens: number;
    providerMaxInputTokens: number;
    providerMaxOutputTokens: number;
  };
  features: string[];
  creditAmount: number;
}

export interface ModelCatalog {
  byId: Map<string, ModelInfo>;
  fetchedAt: number;
}

const CATALOG_TTL_MS = 10 * 60 * 1000;
const T3_BASE = "https://t3.chat";

let cached: ModelCatalog | null = null;
let inFlight: Promise<ModelCatalog | null> | null = null;

const DEFAULT_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  Referer: "https://t3.chat/",
};

type FetchFn = (url: string, opts?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

let _fetchFn: FetchFn | null = null;

async function getFetchFn(): Promise<FetchFn> {
  if (_fetchFn) return _fetchFn;

  try {
    const wreq = await import("wreq-js");
    const wreqFetch = wreq.fetch;
    if (typeof wreqFetch === "function") {
      _fetchFn = async (url, opts) => {
        return wreqFetch(url, {
          method: opts?.method ?? "GET",
          headers: { ...DEFAULT_HEADERS, ...opts?.headers },
          browser: "chrome_142",
        });
      };
      return _fetchFn;
    }
  } catch {}

  _fetchFn = async (url, opts) => {
    return fetch(url, { method: opts?.method ?? "GET", headers: { ...DEFAULT_HEADERS, ...opts?.headers } });
  };
  return _fetchFn;
}

async function fetchPageHtml(): Promise<string> {
  const fn = await getFetchFn();
  const resp = await fn(T3_BASE);
  if (!resp.ok) throw new Error(`Failed to fetch t3.chat homepage: HTTP ${resp.status}`);
  return await resp.text();
}

function extractJsChunks(html: string): string[] {
  const chunks: string[] = [];
  const seen = new Set<string>();
  const linkRe = /<link[^>]*href="(\/assets\/[^"]+\.js[^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    const path = m[1];
    if (!seen.has(path)) {
      seen.add(path);
      chunks.push(path);
    }
  }
  const scriptRe = /<script[^>]+src="(\/assets\/[^"]+\.js[^"]*)"/g;
  while ((m = scriptRe.exec(html)) !== null) {
    const path = m[1];
    if (!seen.has(path)) {
      seen.add(path);
      chunks.push(path);
    }
  }
  return chunks;
}

async function fetchJsChunk(chunkPath: string): Promise<string> {
  const fn = await getFetchFn();
  const resp = await fn(`${T3_BASE}/${chunkPath}`);
  if (!resp.ok) return "";
  return await resp.text();
}

function parseModelsFromJs(js: string): ModelInfo[] {
  const models: ModelInfo[] = [];
  const seen = new Set<string>();

  const modelRe = /\{id:`([^`]+)`,.*?name:`([^`]*)`.*?provider:`([^`]*)`.*?developer:`([^`]*)`.*?shortDescription:`([^`]*)`.*?fullDescription:`([^`]*)`.*?(?:requiresPro:(true|false)).*?(?:premium:(true|false)).*?(?:disabled:(true|false)).*?(?:legacy:(true|false))/gs;
  let m: RegExpExecArray | null;

  while ((m = modelRe.exec(js)) !== null) {
    const id = m[1];
    const name = m[2];

    if (seen.has(id)) continue;
    if (id.includes("/") || id.includes("$") || id.includes(" ")) continue;

    seen.add(id);

    const block = m[0];
    const provider = m[3] || guessProvider(id);
    const developer = m[4] || provider;
    const requiresPro = m[7] === "true";
    const premium = m[8] === "true";
    const disabled = m[9] === "true";
    const legacy = m[10] === "true";
    const creditAmount = extractNumberField(block, "creditAmount") ?? 0;

    const costMatch = /cost:\{input:([^,}]+),output:([^,}]+)(?:,fixed:([^}]+))?\}/.exec(block);
    const cacheMatch = /cacheRead:([^,}]+),cacheWrite:([^,}]+)/.exec(block);
    const cost = {
      input: costMatch ? parseFloat(costMatch[1]) : 0,
      output: costMatch ? parseFloat(costMatch[2]) : 0,
      cacheRead: cacheMatch ? parseFloat(cacheMatch[1]) : 0,
      cacheWrite: cacheMatch ? parseFloat(cacheMatch[2]) : 0,
      fixed: costMatch?.[3] ? parseFloat(costMatch[3]) : 0,
    };

    const appLimitsMatch = /app:\{maxInputTokens:(\d+),maxOutputTokens:(\d+)/.exec(block);
    const providerLimitsMatch = /provider:\{maxInputTokens:(\d+),maxOutputTokens:(\d+)/.exec(block);
    const limits = {
      appMaxInputTokens: appLimitsMatch ? parseInt(appLimitsMatch[1]) : 0,
      appMaxOutputTokens: appLimitsMatch ? parseInt(appLimitsMatch[2]) : 0,
      providerMaxInputTokens: providerLimitsMatch ? parseInt(providerLimitsMatch[1]) : 0,
      providerMaxOutputTokens: providerLimitsMatch ? parseInt(providerLimitsMatch[2]) : 0,
    };

    const features = extractFeaturesArray(block);

    models.push({
      id, name, provider, developer,
      requiresPro, premium, disabled, legacy,
      cost, limits, features, creditAmount,
    });
  }

  return models;
}

function extractStringField(block: string, field: string): string | undefined {
  const re = new RegExp(`${field}:\\s*["'\`]([^"'\`]+)["'\`]`);
  const m = re.exec(block);
  return m?.[1];
}

function extractBoolField(block: string, field: string): boolean | undefined {
  const re = new RegExp(`${field}:\\s*(true|false)`);
  const m = re.exec(block);
  return m ? m[1] === "true" : undefined;
}

function extractNumberField(block: string, field: string): number | undefined {
  const re = new RegExp(`${field}:\\s*([0-9.]+)`);
  const m = re.exec(block);
  return m ? parseFloat(m[1]) : undefined;
}

function extractFeaturesArray(block: string): string[] {
  const features: string[] = [];
  const re = /features:\s*\[([^\]]+)\]/;
  const m = re.exec(block);
  if (m) {
    const raw = m[1];
    const itemRe = /["'\`]([^"'\`]+)["'\`]/g;
    let im: RegExpExecArray | null;
    while ((im = itemRe.exec(raw)) !== null) {
      features.push(im[1]);
    }
  }
  return features;
}

function guessProvider(id: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("claude") || lower.includes("anthropic")) return "Anthropic";
  if (lower.includes("gpt") || lower.includes("o3") || lower.includes("o4") || lower.includes("openai")) return "OpenAI";
  if (lower.includes("gemini") || lower.includes("imagen")) return "Google";
  if (lower.includes("grok")) return "xAI";
  if (lower.includes("deepseek")) return "DeepSeek";
  if (lower.includes("llama")) return "Meta";
  if (lower.includes("qwen")) return "Alibaba";
  if (lower.includes("kimi") || lower.includes("moonshot")) return "Moonshot";
  if (lower.includes("glm") || lower.includes("zhipu")) return "GLM";
  if (lower.includes("mimo") || lower.includes("xiaomi")) return "Xiaomi";
  if (lower.includes("minimax")) return "MiniMax";
  if (lower.includes("ling") || lower.includes("inclusion")) return "InclusionAI";
  return "Unknown";
}

async function fetchCatalog(): Promise<ModelCatalog | null> {
  try {
    const html = await fetchPageHtml();
    const chunks = extractJsChunks(html);
    if (chunks.length === 0) return null;

    const prioritized = chunks.filter((c) => c.includes("main-") || c.includes("model-selector"));
    const rest = chunks.filter((c) => !prioritized.includes(c));
    const ordered = [...prioritized, ...rest].slice(0, 12);

    const jsContents = await Promise.all(ordered.map(fetchJsChunk));

    const allJs = jsContents.join("\n");
    const models = parseModelsFromJs(allJs);

    const byId = new Map<string, ModelInfo>();
    for (const model of models) {
      const isImageOnly = model.features.length > 0
        && model.features.every((f) => f === "images");
      if (isImageOnly) continue;
      byId.set(model.id, model);
    }

    return { byId, fetchedAt: Date.now() };
  } catch (e) {
    logError(`t3chat: catalog fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function getCachedCatalog(): Promise<ModelCatalog | null> {
  if (cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;
  if (inFlight) return await inFlight;

  inFlight = fetchCatalog();
  try {
    const result = await inFlight;
    if (result) cached = result;
    return result;
  } finally {
    inFlight = null;
  }
}

export function clearCachedCatalog(): void {
  cached = null;
  inFlight = null;
}
