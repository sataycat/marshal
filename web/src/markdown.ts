import type { MarkedOptions } from "marked";

type MarkedModule = typeof import("marked");

let markedPromise: Promise<MarkedModule> | null = null;
let markedCached: MarkedModule | null = null;

function loadMarked(): Promise<MarkedModule> {
  if (!markedPromise) {
    markedPromise = import("marked").then((m) => {
      markedCached = m;
      m.marked.setOptions({ async: false, gfm: true, breaks: false } as MarkedOptions);
      return m;
    });
  }
  return markedPromise;
}

/**
 * Render markdown to HTML. `marked` is dynamic-imported on the first call and
 * cached for the rest of the session so it lands in its own sub-chunk rather
 * than the route chunk that first touches it. Callers in render paths should
 * treat this as effectively synchronous for subsequent calls (the resolved
 * module is reused) but must await the first invocation.
 */
export async function renderMarkdown(src: string): Promise<string> {
  const mod = markedCached ?? (await loadMarked());
  return mod.marked.parse(src ?? "") as string;
}
