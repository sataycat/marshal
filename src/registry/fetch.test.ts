import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRegistrySnapshot } from "./fetch.js";

const response = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("registry fetch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an oversized response before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(JSON.stringify({ version: "1.0.0", agents: [] }), { "content-length": String(6 * 1024 * 1024) })));
    await expect(fetchRegistrySnapshot("https://fixture.invalid/registry.json")).rejects.toThrow(/5 MiB/);
  });

  it("follows bounded redirects and validates the final response", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/final.json" } }))
      .mockResolvedValueOnce(response(JSON.stringify({ version: "1.0.0", agents: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const snapshot = await fetchRegistrySnapshot("https://fixture.invalid/registry.json");
    expect(snapshot.agents).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
