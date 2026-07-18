import { parseRegistryDocument, RegistryValidationError } from "./parser.js";
import { PUBLIC_REGISTRY_URL, type RegistrySnapshot } from "./types.js";

export const REGISTRY_MAX_BYTES = 5 * 1024 * 1024;
export const REGISTRY_TIMEOUT_MS = 10_000;
export const REGISTRY_MAX_REDIRECTS = 3;

async function fetchBounded(url: string, redirects = 0): Promise<Uint8Array> {
  if (redirects > REGISTRY_MAX_REDIRECTS) throw new Error("registry redirect limit exceeded");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: "manual", signal: controller.signal, headers: { Accept: "application/json" } });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("registry redirect has no location");
      return fetchBounded(new URL(location, url).toString(), redirects + 1);
    }
    if (!response.ok) throw new Error(`registry request failed with HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > REGISTRY_MAX_BYTES) throw new Error("registry response exceeds the 5 MiB limit");
    if (!response.body) throw new Error("registry response had no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > REGISTRY_MAX_BYTES) { await reader.cancel(); throw new Error("registry response exceeds the 5 MiB limit"); }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("registry request timed out");
    throw error;
  } finally { clearTimeout(timer); }
}

export async function fetchRegistrySnapshot(source = PUBLIC_REGISTRY_URL): Promise<RegistrySnapshot> {
  const bytes = await fetchBounded(source);
  let document: unknown;
  try { document = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RegistryValidationError("registry response was not valid JSON"); }
  const parsed = parseRegistryDocument(document);
  return { ...parsed, source, fetched_at: new Date().toISOString() };
}
