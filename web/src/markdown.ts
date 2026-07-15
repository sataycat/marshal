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

export interface MarkdownStub {
  /** Position in document order. Stable across re-renders. */
  idx: number;
  /** Fence language as it appeared in the source (e.g. "ts", "py"). */
  lang: string;
  /** Decoded source text. */
  code: string;
}

export interface RenderProseResult {
  /** HTML with fenced code blocks replaced by `<div data-cm data-lang="…" data-idx="…">` stubs. */
  html: string;
  /** Stubs in document order. Hydration finds the live element via `[data-cm][data-idx="N"]`. */
  stubs: MarkdownStub[];
}

const FENCE_RE = /<pre>\s*<code(?:\s+class="language-([^"\s]*)")?\s*>([\s\S]*?)<\/code>\s*<\/pre>/g;

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeAttr(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Render markdown to HTML via the lazily-loaded `marked` chunk. The
 * resolved module is cached by `markdown.ts` so subsequent calls are
 * effectively synchronous. Callers in render paths must `await` the first
 * call; later calls return immediately off the cache.
 */
export async function renderMarkdown(src: string): Promise<string> {
  const mod = markedCached ?? (await loadMarked());
  return mod.marked.parse(src ?? "") as string;
}

/**
 * Render markdown with fenced code blocks replaced by `<div data-cm>`
 * stubs. After the returned HTML is mounted (e.g. via
 * `dangerouslySetInnerHTML`), the consumer hydrates each stub by
 * `querySelector('[data-cm][data-idx="N"]')` against the container ref.
 *
 * This is the path used by `MarkdownWithCode`; `DiffView` and any other
 * plain-prose-only surface keeps using `renderMarkdown`.
 */
export async function renderProse(src: string): Promise<RenderProseResult> {
  const html = await renderMarkdown(src);
  const stubs: MarkdownStub[] = [];
  const replaced = html.replace(FENCE_RE, (_match, langRaw: string | undefined, codeRaw: string) => {
    const idx = stubs.length;
    const lang = (langRaw ?? "").trim().toLowerCase();
    const code = decodeEntities(codeRaw);
    stubs.push({ idx, lang, code });
    return `<div data-cm data-lang="${escapeAttr(lang)}" data-idx="${idx}"></div>`;
  });
  return { html: replaced, stubs };
}

