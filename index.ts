/**
 * t3.chat Provider for Pi
 *
 * Enables t3.chat models via cookie-based auth with TLS impersonation.
 * Models are fetched dynamically by scraping t3.chat's JS bundles.
 *
 * Usage: /login t3chat → /model t3chat/<id>
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { startProxy, stopProxy, PROXY_SECRET, setProxyCredentials } from "./proxy";
import { loadCredentials, saveCredentials, deleteCredentials, validateCredentials, type T3Credentials } from "./auth";
import { getCachedCatalog, clearCachedCatalog } from "./catalog";
import { modelToPiModel } from "./models";
import { getCustomerData, getSubscriptionData } from "./usage";

let _pi: ExtensionAPI | null = null;

async function fetchDynamicModels(): Promise<ReturnType<typeof modelToPiModel>[]> {
  try {
    const catalog = await getCachedCatalog();
    if (catalog && catalog.byId.size > 0) {
      const models = [...catalog.byId.values()]
        .filter((m) => !m.disabled)
        .map(modelToPiModel);
      console.error(`[t3chat] loaded ${models.length} models from catalog`);
      return models;
    }
    if (catalog && catalog.byId.size === 0) {
      console.error("[t3chat] catalog fetched but found 0 models — JS parsing may have failed");
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[t3chat] catalog fetch failed: ${msg}`);
    _catalogError = msg;
  }
  return [];
}

let _catalogError: string | null = null;

async function loginT3Chat(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const cookies = await callbacks.onPrompt({
    message: "Paste your full Cookie header from t3.chat (DevTools > Application > Cookies):\n\nPaste:",
  });
  const convexSessionId = await callbacks.onPrompt({
    message: "Paste your convex-session-id from t3.chat (found in cookies or URL):\n\nPaste:",
  });

  const trimmedCookies = cookies.trim();
  const trimmedSessionId = convexSessionId.trim();

  if (!trimmedCookies || !trimmedSessionId) {
    throw new Error("Both cookies and convex-session-id are required.");
  }

  const creds: T3Credentials = {
    cookies: trimmedCookies,
    convexSessionId: trimmedSessionId,
    issuedAt: new Date().toISOString(),
  };

  const result = await validateCredentials(creds);
  if (!result.ok) {
    console.error(`[t3chat] credential validation failed: ${result.error ?? "unknown error"}`);
    console.error("[t3chat] saving credentials anyway — chat may still work");
  }

  saveCredentials(creds);
  setProxyCredentials(creds);
  clearCachedCatalog();

  return {
    refresh: trimmedCookies,
    access: trimmedCookies,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
  };
}

async function refreshT3Token(c: OAuthCredentials): Promise<OAuthCredentials> {
  return c;
}

export default async function (pi: ExtensionAPI) {
  _pi = pi;

  const proxyPort = await startProxy();
  const baseUrl = `http://127.0.0.1:${proxyPort}/v1`;

  let hasCreds = false;
  try {
    const stored = loadCredentials();
    if (stored) {
      setProxyCredentials(stored);
      hasCreds = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[t3chat] credential load failed: ${msg}`);
    _catalogError = `credential load: ${msg}`;
  }

  const models = hasCreds ? await fetchDynamicModels() : [];

  pi.registerProvider("t3chat", {
    name: "t3.chat",
    baseUrl,
    apiKey: PROXY_SECRET,
    api: "openai-completions",
    authHeader: true,
    models,
    oauth: {
      name: "t3.chat",
      login: loginT3Chat,
      refreshToken: refreshT3Token,
      getApiKey: (creds: OAuthCredentials) => creds.access,
    },
  });

  console.error(hasCreds ? `[t3chat] connected — ${models.length} models` : `[t3chat] /login t3chat to connect`);

  pi.on("session_start", async (_event, ctx) => {
    if (_catalogError) {
      ctx.ui.notify(`t3chat: model catalog failed — ${_catalogError}`, "error");
    } else if (hasCreds && models.length === 0) {
      ctx.ui.notify("t3chat: logged in but 0 models loaded — run t3chat-refresh or check console for errors", "warning");
    }
  });

  pi.registerCommand("t3chat-status", {
    description: "Show t3.chat auth status, credits, and subscription",
    handler: async (_args, ctx) => {
      const c = loadCredentials();
      if (!c) {
        ctx.ui.notify("t3.chat: not signed in. /login t3chat", "warning");
        return;
      }
      try {
        const [customer, subscription] = await Promise.all([
          getCustomerData(c.cookies),
          getSubscriptionData(c.cookies),
        ]);
        const parts: string[] = [];
        parts.push(`Balance: ${customer.balance.toFixed(2)} credits`);
        parts.push(`Tier: ${subscription.subTier}`);
        if (subscription.isPaid) parts.push("Paid");
        parts.push(`Monthly usage: ${(100 - customer.usageMonthPercentage).toFixed(1)}% remaining`);
        ctx.ui.notify(`t3.chat: ${parts.join(" | ")}`, "info");
      } catch (e) {
        ctx.ui.notify(`t3.chat: authenticated but status fetch failed: ${e instanceof Error ? e.message : String(e)}`, "warning");
      }
    },
  });

  pi.registerCommand("t3chat-logout", {
    description: "Sign out of t3.chat",
    handler: async (_args, ctx) => {
      const ok = deleteCredentials();
      setProxyCredentials(null);
      clearCachedCatalog();
      ctx.ui.notify(ok ? "t3.chat: signed out." : "Already signed out.", "info");
    },
  });

  pi.registerCommand("t3chat-refresh", {
    description: "Refresh t3.chat model catalog",
    handler: async (_args, ctx) => {
      const c = loadCredentials();
      if (!c) {
        ctx.ui.notify("t3.chat: not signed in. /login t3chat", "warning");
        return;
      }
      clearCachedCatalog();
      try {
        const catalog = await getCachedCatalog();
        if (catalog) {
          ctx.ui.notify(`t3.chat: refreshed ${catalog.byId.size} models. Restart Pi to apply.`, "info");
        } else {
          ctx.ui.notify("t3.chat: refresh failed. Check connection.", "warning");
        }
      } catch (e) {
        ctx.ui.notify(`t3.chat: refresh error - ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.on("session_shutdown", async () => {
    _pi = null;
    stopProxy();
  });
}
