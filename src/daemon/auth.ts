import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

export const SESSION_COOKIE = "marshal_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export interface AuthOptions {
  password?: string;
  secureCookies?: boolean;
}

interface Session {
  token: string;
  expiresAt: number;
  lastUsedAt: number;
}

interface FailureState {
  failures: number;
  lockedUntil: number;
}

export class AuthService {
  readonly enabled: boolean;
  private readonly passwordHash: Buffer | undefined;
  private readonly sessions = new Map<string, Session>();
  private readonly failures = new Map<string, FailureState>();
  private readonly secureCookies: boolean;

  constructor(options: AuthOptions = {}) {
    this.enabled = Boolean(options.password);
    this.passwordHash = options.password
      ? (() => {
          const salt = randomBytes(16);
          return Buffer.concat([salt, scryptSync(options.password, salt, 64)]);
        })()
      : undefined;
    this.secureCookies = options.secureCookies ?? false;
  }

  isAuthenticated(cookieHeader: string | undefined): boolean {
    if (!this.enabled) return true;
    return this.getSession(cookieHeader) !== undefined;
  }

  login(password: string, clientKey: string): { token?: string; retryAfter?: number } {
    if (!this.enabled || !this.passwordHash) return { token: undefined };
    const failure = this.failures.get(clientKey);
    const now = Date.now();
    if (failure && failure.lockedUntil > now) {
      return { retryAfter: Math.ceil((failure.lockedUntil - now) / 1000) };
    }
    const candidate = scryptSync(password, this.passwordHash.subarray(0, 16), 64);
    const stored = this.passwordHash.subarray(16);
    const valid = candidate.length === stored.length && timingSafeEqual(candidate, stored);
    if (!valid) {
      const next = failure && failure.lockedUntil <= now ? failure.failures : 0;
      const failures = next + 1;
      this.failures.set(clientKey, {
        failures,
        lockedUntil: failures >= MAX_FAILURES ? now + LOCKOUT_MS : 0,
      });
      return failures >= MAX_FAILURES ? { retryAfter: Math.ceil(LOCKOUT_MS / 1000) } : {};
    }
    this.failures.delete(clientKey);
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { token, expiresAt: now + SESSION_TTL_MS, lastUsedAt: now });
    return { token };
  }

  logout(cookieHeader: string | undefined): void {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (token) this.sessions.delete(token);
  }

  cookie(token: string, maxAge = SESSION_TTL_MS / 1000, secure = this.secureCookies): string {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? "; Secure" : ""}`;
  }

  clearCookie(): string {
    return this.cookie("", 0);
  }

  middleware = async (c: Context, next: Next): Promise<Response | void> => {
    if (!this.enabled || c.req.path === "/api/auth/status" || c.req.path === "/api/auth/login" || c.req.path === "/api/health") {
      return next();
    }
    if (!this.isAuthenticated(c.req.header("Cookie"))) {
      return c.json({ error: "Authentication required", code: "auth_required" }, 401);
    }
    return next();
  };

  private getSession(cookieHeader: string | undefined): Session | undefined {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) this.sessions.delete(token);
      return undefined;
    }
    session.lastUsedAt = Date.now();
    return session;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of header?.split(";") ?? []) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}
