import { describe, expect, it } from "vitest";
import { AuthService } from "./auth.js";

describe("AuthService", () => {
  it("creates and validates opaque sessions", () => {
    const auth = new AuthService({ password: "secret" });
    const result = auth.login("secret", "direct");
    expect(result.token).toBeTypeOf("string");
    expect(auth.isAuthenticated(`marshal_session=${result.token}`)).toBe(true);
    expect(auth.isAuthenticated(undefined)).toBe(false);
  });

  it("locks repeated invalid password attempts", () => {
    const auth = new AuthService({ password: "secret" });
    for (let i = 0; i < 4; i += 1) expect(auth.login("wrong", "direct").token).toBeUndefined();
    expect(auth.login("wrong", "direct").retryAfter).toBeGreaterThan(0);
    expect(auth.login("secret", "direct").token).toBeUndefined();
  });

  it("removes sessions on logout", () => {
    const auth = new AuthService({ password: "secret" });
    const token = auth.login("secret", "direct").token;
    auth.logout(`marshal_session=${token}`);
    expect(auth.isAuthenticated(`marshal_session=${token}`)).toBe(false);
  });
});
