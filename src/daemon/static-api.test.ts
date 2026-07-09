import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "./http.js";

async function req(
  app: ReturnType<typeof buildApp>,
  method: string,
  path: string,
): Promise<{ status: number; contentType: string; text: string }> {
  const res = await app.request(path, { method });
  const text = await res.text();
  const contentType = res.headers.get("Content-Type") ?? "";
  return { status: res.status, contentType, text };
}

describe("static SPA serving", () => {
  function makeApp(webDir: string): ReturnType<typeof buildApp> {
    const options: BuildAppOptions = { webDir };
    return buildApp("0.0.1", options);
  }

  it("serves index.html at GET / when the web bundle is built", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><p>board</p>");
    const app = makeApp(webDir);
    const { status, contentType, text } = await req(app, "GET", "/");
    expect(status).toBe(200);
    expect(contentType).toContain("text/html");
    expect(text).toContain("board");
  });

  it("returns the SPA fallback (index.html) for unknown non-API paths", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><p>spa</p>");
    const app = makeApp(webDir);
    const { status, text } = await req(app, "GET", "/tasks/some-deep-route");
    expect(status).toBe(200);
    expect(text).toContain("spa");
  });

  it("serves a built asset under /assets/* with the correct content type", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html>");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    writeFileSync(join(webDir, "assets", "index-abc.js"), "console.log('hi')");
    writeFileSync(join(webDir, "assets", "style-def.css"), "body{}");
    const app = makeApp(webDir);

    const js = await req(app, "GET", "/assets/index-abc.js");
    expect(js.status).toBe(200);
    expect(js.contentType).toContain("text/javascript");
    expect(js.text).toBe("console.log('hi')");

    const css = await req(app, "GET", "/assets/style-def.css");
    expect(css.status).toBe(200);
    expect(css.contentType).toContain("text/css");
  });

  it("returns 404 for a missing asset under /assets/* (no SPA fallback)", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><p>spa</p>");
    mkdirSync(join(webDir, "assets"), { recursive: true });
    const app = makeApp(webDir);
    const { status, text } = await req(app, "GET", "/assets/missing.js");
    expect(status).toBe(404);
    expect(text).not.toContain("spa");
  });

  it("does not leak files outside assets/ via path traversal", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><p>spa</p>");
    writeFileSync(join(webDir, "secret.txt"), "top-secret");
    const app = makeApp(webDir);
    // Literal and encoded traversal are normalized away from /assets/* before
    // routing; either way the secret must never appear in the response.
    const literal = await req(app, "GET", "/assets/../secret.txt");
    expect(literal.text).not.toContain("top-secret");
    const encoded = await req(app, "GET", "/assets/%2e%2e/secret.txt");
    expect(encoded.text).not.toContain("top-secret");
  });

  it("returns a clear 404 at GET / when the web bundle is absent", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-no-bundle-"));
    const app = makeApp(webDir);
    const { status, contentType, text } = await req(app, "GET", "/");
    expect(status).toBe(404);
    expect(contentType).toContain("text/html");
    expect(text).toContain("Web bundle not built");
  });

  it("keeps API routes taking precedence over the SPA fallback", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html><p>spa</p>");
    const app = makeApp(webDir);
    const { status, text } = await req(app, "GET", "/api/nope");
    expect(status).toBe(404);
    expect(text).toContain("Not found");
    expect(text).not.toContain("spa");
  });

  it("serves /api/health alongside static routes", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "marshal-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html>");
    const app = makeApp(webDir);
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "0.0.1" });
  });
});
