import { describe, expect, it } from "vitest";
import { authMethodSupport } from "./authMethodSupport";

const method = (type: string) => ({ id: type, type, name: type, description: null, vars: [], link: null, args: [], env: {}, meta: null, raw: {} });

describe("authentication method support", () => {
  it("supports generic agent and environment methods", () => {
    expect(authMethodSupport(method("agent"))).toEqual({ supported: true });
    expect(authMethodSupport(method("env_var"))).toEqual({ supported: true });
  });

  it("keeps unsupported methods visible with an explanation", () => {
    expect(authMethodSupport(method("terminal"))).toEqual({ supported: true });
    expect(authMethodSupport(method("future_auth"))).toEqual({ supported: false, reason: "Marshal does not support the advertised method type “future_auth”." });
  });
});
