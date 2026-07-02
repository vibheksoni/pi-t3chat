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
 * Validate credentials by hitting t3.chat's status endpoint.
 * Returns true if the cookies are still valid.
 */
export async function validateCredentials(creds: T3Credentials): Promise<boolean> {
  try {
    const resp = await fetch("https://t3.chat/api/status?dpl=LATEST", {
      headers: {
        Cookie: creds.cookies,
        Referer: "https://t3.chat/",
      },
    });
    return resp.ok;
  } catch {
    return false;
  }
}
