import type { Extension } from "@codemirror/state";

/**
 * Fence-language → CodeMirror extension. The extensions themselves are
 * dynamic-imported inside `loadLanguage()` so each language package lives
 * in its own sub-chunk. The resolved extension is cached per-language for
 * the rest of the session.
 *
 * Unknown languages fall through to plain text. The match is
 * case-insensitive and supports a few common aliases (`ts`/`typescript`,
 * `md`/`markdown`, `py`/`python`, `jsonc`→`json`).
 *
 * Bundle budget: keep this set curated. Pass 4 acceptance is 90 KB gzipped
 * for the whole CodeMirror chunk. If a future addition tips it over, drop
 * `sql` or `py` first (per TODO §Pass 4 step 1) and document the trim here.
 */

export type LanguageId =
  | "ts"
  | "tsx"
  | "js"
  | "jsx"
  | "json"
  | "md"
  | "css"
  | "py"
  | "sql"
  | "diff"
  | "text";

const ALIASES: Record<string, LanguageId> = {
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  js: "js",
  javascript: "js",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  md: "md",
  markdown: "md",
  css: "css",
  py: "py",
  python: "py",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  text: "text",
  txt: "text",
  "": "text",
  plain: "text",
};

export function normalizeLanguage(raw: string | null | undefined): LanguageId {
  if (raw == null) return "text";
  const id = ALIASES[raw.trim().toLowerCase()];
  return id ?? "text";
}

type Loader = () => Promise<Extension>;

const LOADERS: Record<Exclude<LanguageId, "text">, Loader> = {
  ts: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import("@codemirror/lang-javascript").then((m) =>
      m.javascript({ jsx: true, typescript: true }),
    ),
  js: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  md: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  py: () =>
    Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/python"),
    ]).then(([{ StreamLanguage }, m]) => StreamLanguage.define(m.python)),
  sql: () =>
    Promise.all([import("@codemirror/language"), import("@codemirror/legacy-modes/mode/sql")]).then(
      ([{ StreamLanguage }, m]) => StreamLanguage.define(m.standardSQL),
    ),
  diff: () =>
    Promise.all([
      import("@codemirror/language"),
      import("@codemirror/legacy-modes/mode/diff"),
    ]).then(([{ StreamLanguage }, m]) => StreamLanguage.define(m.diff)),
};

const cache = new Map<LanguageId, Extension>();
const inflight = new Map<LanguageId, Promise<Extension>>();

/**
 * Resolve a fence-language string to the CodeMirror extension for that
 * language. The first call for an id dynamic-imports the underlying
 * parser package; subsequent calls reuse the cached extension. Unknown
 * ids resolve to plain text (`[]`).
 */
export function loadLanguage(raw: string | null | undefined): Promise<Extension> {
  const id = normalizeLanguage(raw);
  const hit = cache.get(id);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending !== undefined) return pending;

  if (id === "text") {
    const ext: Extension = [];
    cache.set("text", ext);
    return Promise.resolve(ext);
  }

  const promise = LOADERS[id]()
    .then((ext) => {
      cache.set(id, ext);
      inflight.delete(id);
      return ext;
    })
    .catch((err: unknown) => {
      inflight.delete(id);
      throw err;
    });
  inflight.set(id, promise);
  return promise;
}
