/**
 * Cookie-based authentication + credential storage for t3.chat.
 *
 * t3.chat uses cookie-based auth — no OAuth flow. Users provide their
 * full Cookie header string and convex_session_id from a logged-in browser session.
 *
 * Key cookies: wos-session, convex-session-id, t3-anon-visitor, __vdpl
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface T3Credentials {
  cookies: string;
  convexSessionId: string;
  issuedAt: string;
}

const APP_DIR_NAME = "pi-t3chat-auth";
const CREDS_FILENAME = "credentials.json";

export function getCredentialsDir(): string {
  return path.join(os.homedir(), ".config", APP_DIR_NAME);
}

export function getCredentialsPath(): string {
  return path.join(getCredentialsDir(), CREDS_FILENAME);
}

function ensureDir(): void {
  const dir = getCredentialsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function loadCredentials(): T3Credentials | null {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof parsed.cookies !== "string" || !parsed.cookies ||
      typeof parsed.convexSessionId !== "string" || !parsed.convexSessionId) {
    throw new Error(`Credentials file at ${p} is missing required fields (cookies, convexSessionId).`);
  }
  return parsed as unknown as T3Credentials;
}

export function saveCredentials(creds: T3Credentials): void {
  ensureDir();
  const p = getCredentialsPath();
  fs.writeFileSync(p, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): boolean {
  const p = getCredentialsPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

/**
 * Validate credentials by hitting t3.chat's tRPC getCustomerData endpoint.
 * Returns { ok, error } with the actual error message from t3.chat.
 *
 * Tries wreq-js (TLS impersonation) first, falls back to standard fetch.
 */
export async function validateCredentials(creds: T3Credentials): Promise<{ ok: boolean; error?: string }> {
  const url = "https://t3.chat/api/trpc/getCustomerData?batch=1&input=" +
    encodeURIComponent(JSON.stringify({ 0: { json: { sessionId: null } } }));
  const headers: Record<string, string> = {
    Cookie: creds.cookies,
    "x-trpc-source": "web-client",
    Referer: "https://t3.chat/",
    "trpc-accept": "application/jsonl",
    "x-trpc-batch": "true",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };

  let lastError: string | undefined;

  try {
    const { request } = await import("wreq-js");
    const resp = await request(url, { method: "GET", headers, impersonate: "chrome136" });
    if (resp.ok) return { ok: true };
    const body = await resp.text();
    lastError = `wreq-js: HTTP ${resp.status} — ${body.slice(0, 300)}`;
  } catch (e) {
    lastError = `wreq-js failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  try {
    const resp = await fetch(url, { method: "GET", headers });
    if (resp.ok) return { ok: true };
    const body = await resp.text();
    lastError = `fetch: HTTP ${resp.status} — ${body.slice(0, 300)}`;
  } catch (e) {
    lastError = `fetch failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  return { ok: false, error: lastError };
}
