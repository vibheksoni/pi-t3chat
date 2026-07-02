/**
 * Usage & billing client for t3.chat via tRPC endpoints.
 *
 * t3.chat uses tRPC for server-side data. Endpoints return JSON or JSONL.
 *
 * Key endpoints:
 *   getCustomerData     — credit balance, usage %, subscription
 *   getSubscriptionData — paid status, sub tier
 *   getPricingProducts  — pricing tiers (free, pro, premium)
 *   auth.getActiveSessions — active browser sessions
 *   getModelStatuses    — real-time model operational status
 *   getAllModelBenchmarks — model benchmark scores
 *
 * Uses wreq-js for TLS impersonation.
 */
import { request, type Response as WreqResponse } from "wreq-js";

const T3_BASE = "https://t3.chat";

export interface CustomerData {
  balance: number;
  usageFourHourPercentage: number;
  usageMonthPercentage: number;
  usagePeriodPercentage: number;
  subTier?: string;
  isPaid?: boolean;
}

export interface SubscriptionData {
  isPaid: boolean;
  subTier: string;
}

export interface PricingProduct {
  id: string;
  name: string;
  price: number;
  interval: string;
}

export interface SessionInfo {
  id: string;
  device?: string;
  location?: string;
  lastActive?: string;
}

export interface ModelStatus {
  id: string;
  status: string;
  message?: string;
}

export interface ModelBenchmark {
  id: string;
  name: string;
  scores: Record<string, number>;
}

function buildTrpcUrl(procedure: string, input: Record<string, unknown>): string {
  const encoded = encodeURIComponent(JSON.stringify({ 0: { json: input } }));
  return `${T3_BASE}/api/trpc/${procedure}?batch=1&input=${encoded}`;
}

function extractTrpcResult(body: string): Record<string, unknown> | null {
  const candidates: Array<Record<string, unknown>> = [];

  try {
    const v = JSON.parse(body);
    collectCandidates(v, candidates);
  } catch {}

  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      collectCandidates(v, candidates);
    } catch {}
  }

  for (const c of candidates) {
    if (c.balance !== undefined || c.subTier !== undefined || c.isPaid !== undefined || c.id !== undefined) {
      return c;
    }
  }

  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c as unknown as Record<string, unknown>;
  }

  return candidates[0] ?? null;
}

function collectCandidates(v: unknown, out: Array<Record<string, unknown>>): void {
  if (!v || typeof v !== "object") return;
  const obj = v as Record<string, unknown>;

  const result = obj.result as Record<string, unknown> | undefined;
  const data = result?.data as Record<string, unknown> | undefined;
  const json = data?.json;
  if (json !== undefined) {
    if (json && typeof json === "object") {
      out.push(json as Record<string, unknown>);
      if (Array.isArray(json)) {
        for (const item of json) {
          if (item && typeof item === "object") out.push(item as Record<string, unknown>);
        }
      }
    }
  }

  if (obj.json !== undefined) {
    const inner = obj.json;
    if (Array.isArray(inner)) {
      for (const item of inner) {
        if (item && typeof item === "object") out.push(item as Record<string, unknown>);
      }
    } else if (inner && typeof inner === "object") {
      out.push(inner as Record<string, unknown>);
    }
  }

  for (const key of Object.keys(obj)) {
    if (key === "result" || key === "data") continue;
    const val = obj[key];
    if (val && typeof val === "object") {
      collectCandidates(val, out);
    }
  }
}

async function trpcCall(
  cookies: string,
  procedure: string,
  input: Record<string, unknown>,
  jsonl: boolean,
): Promise<string> {
  const url = buildTrpcUrl(procedure, input);
  const headers: Record<string, string> = {
    Cookie: cookies,
    "x-trpc-source": "web-client",
    Referer: "https://t3.chat/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
  if (jsonl) {
    headers["trpc-accept"] = "application/jsonl";
    headers["x-trpc-batch"] = "true";
  }

  const resp: WreqResponse = await request(url, {
    method: "GET",
    headers,
    impersonate: "chrome136",
  });

  if (!resp.ok) {
    throw new Error(`tRPC ${procedure} failed: HTTP ${resp.status}`);
  }

  return await resp.text();
}

export async function getCustomerData(cookies: string): Promise<CustomerData> {
  const body = await trpcCall(cookies, "getCustomerData", { sessionId: null }, true);
  const result = extractTrpcResult(body);
  if (!result) throw new Error("Failed to parse getCustomerData response");
  return {
    balance: Number(result.balance ?? 0),
    usageFourHourPercentage: Number(result.usageFourHourPercentage ?? 0),
    usageMonthPercentage: Number(result.usageMonthPercentage ?? 0),
    usagePeriodPercentage: Number(result.usagePeriodPercentage ?? 0),
    subTier: result.subTier as string | undefined,
    isPaid: result.isPaid as boolean | undefined,
  };
}

export async function getSubscriptionData(cookies: string): Promise<SubscriptionData> {
  const body = await trpcCall(cookies, "getSubscriptionData", {}, false);
  const result = extractTrpcResult(body);
  if (!result) throw new Error("Failed to parse getSubscriptionData response");
  return {
    isPaid: Boolean(result.isPaid ?? false),
    subTier: String(result.subTier ?? "free"),
  };
}

export async function getPricingProducts(cookies: string): Promise<PricingProduct[]> {
  const body = await trpcCall(cookies, "getPricingProducts", {}, false);
  const result = extractTrpcResult(body);
  if (!result || !Array.isArray(result)) return [];
  return result.map((p: Record<string, unknown>) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    price: Number(p.price ?? 0),
    interval: String(p.interval ?? "month"),
  }));
}

export async function getActiveSessions(cookies: string): Promise<SessionInfo[]> {
  const body = await trpcCall(cookies, "auth.getActiveSessions", { includeLocation: false }, true);
  const result = extractTrpcResult(body);
  if (!result || !Array.isArray(result)) return [];
  return result.map((s: Record<string, unknown>) => ({
    id: String(s.id ?? s.sessionId ?? ""),
    device: s.device as string | undefined,
    location: s.location as string | undefined,
    lastActive: s.lastActive as string | undefined,
  }));
}

export async function getModelStatuses(cookies: string): Promise<ModelStatus[]> {
  const body = await trpcCall(cookies, "getModelStatuses", {}, false);
  const result = extractTrpcResult(body);
  if (!result || !Array.isArray(result)) return [];
  return result.map((s: Record<string, unknown>) => ({
    id: String(s.id ?? ""),
    status: String(s.status ?? "unknown"),
    message: s.message as string | undefined,
  }));
}

export async function getModelBenchmarks(cookies: string): Promise<ModelBenchmark[]> {
  const body = await trpcCall(cookies, "getAllModelBenchmarks", {}, false);
  const result = extractTrpcResult(body);
  if (!result || !Array.isArray(result)) return [];
  return result.map((b: Record<string, unknown>) => ({
    id: String(b.id ?? ""),
    name: String(b.name ?? ""),
    scores: (b.scores ?? b.benchmarks ?? {}) as Record<string, number>,
  }));
}
