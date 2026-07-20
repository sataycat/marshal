import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import { loadLanguage } from "./languages";
import { useTheme } from "../theme";
import { cn } from "@/lib/utils";

type CodeMirrorComponent = typeof import("@uiw/react-codemirror").default;
type CodeMirrorProps = React.ComponentProps<CodeMirrorComponent>;

let codeMirrorPromise: Promise<CodeMirrorComponent> | null = null;
let codeMirrorCached: CodeMirrorComponent | null = null;

function loadCodeMirror(): Promise<CodeMirrorComponent> {
  if (codeMirrorCached !== null) return Promise.resolve(codeMirrorCached);
  if (codeMirrorPromise === null) {
    codeMirrorPromise = import("@uiw/react-codemirror").then((m) => {
      codeMirrorCached = m.default;
      return m.default;
    });
  }
  return codeMirrorPromise;
}

let themePromise: Promise<Extension> | null = null;
let themeCached: Extension | null = null;

function loadTheme(): Promise<Extension> {
  if (themeCached !== null) return Promise.resolve(themeCached);
  if (themePromise === null) {
    themePromise = import("@codemirror/view").then(({ EditorView }) => {
      const ext = EditorView.theme(
        {
          "&": {
            backgroundColor: "transparent",
            color: "var(--foreground)",
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
          },
          ".cm-gutters": {
            backgroundColor: "transparent",
            color: "var(--muted-foreground)",
            border: "none",
          },
          ".cm-content": { caretColor: "var(--primary)" },
          ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
            { backgroundColor: "var(--muted)" },
          ".cm-activeLine": { backgroundColor: "transparent" },
          ".cm-activeLineGutter": { backgroundColor: "transparent" },
        },
        { dark: false },
      );
      themeCached = ext;
      return ext;
    });
  }
  return themePromise;
}

let darkHighlightPromise: Promise<Extension> | null = null;
let darkHighlightCached: Extension | null = null;

/** Dark-theme token colors; the light theme keeps the default highlight style. */
function loadDarkHighlight(): Promise<Extension> {
  if (darkHighlightCached !== null) return Promise.resolve(darkHighlightCached);
  if (darkHighlightPromise === null) {
    darkHighlightPromise = Promise.all([
      import("@codemirror/language"),
      import("@lezer/highlight"),
    ]).then(([{ HighlightStyle, syntaxHighlighting }, { tags }]) => {
      const style = HighlightStyle.define([
        { tag: [tags.comment, tags.meta], color: "#6b7390" },
        { tag: [tags.keyword, tags.modifier, tags.controlKeyword], color: "#a8b0ff" },
        { tag: [tags.string, tags.special(tags.string), tags.regexp], color: "#7fd6a4" },
        { tag: [tags.number, tags.bool, tags.null, tags.atom], color: "#e0a94f" },
        { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace], color: "#6fc3df" },
        { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#c5a3ff" },
        { tag: [tags.propertyName, tags.attributeName], color: "#8fd0ea" },
        { tag: [tags.variableName, tags.name], color: "#e3e6ef" },
        { tag: [tags.punctuation, tags.operator, tags.separator], color: "#8b93ab" },
        { tag: tags.heading, color: "#c5a3ff", fontWeight: "600" },
        { tag: tags.link, color: "#a8b0ff", textDecoration: "underline" },
        { tag: tags.deleted, color: "#f0705f" },
        { tag: tags.inserted, color: "#4cc790" },
      ]);
      const ext = syntaxHighlighting(style);
      darkHighlightCached = ext;
      return ext;
    });
  }
  return darkHighlightPromise;
}

export interface CodeBlockProps {
  /** Source text. */
  value: string;
  /** Fence language id (e.g. "ts", "markdown", "py"). Unknown ids fall back to plain text. */
  lang?: string;
  /** When true the block is editable; defaults to false (read-only highlighting). */
  editable?: boolean;
  /** Optional class for the outer wrapper. */
  className?: string;
  /** Optional min height. */
  minHeight?: string;
  /** Fires when the user edits the buffer. */
  onChange?: (next: string) => void;
  /** Fires for keyboard shortcuts while the editor is focused. */
  onKeyDown?: (event: React.KeyboardEvent) => void;
}

/**
 * CodeMirror-backed code block. The `@uiw/react-codemirror` component and
 * the per-language parser package are dynamic-imported on the first mount;
 * the resolved modules are cached for the rest of the session. The first
 * render shows a `<pre>` placeholder, which is replaced once the chunks
 * resolve.
 *
 * `editable=false` (the default) renders a read-only buffer with the
 * `EditorView` set to read-only mode and `basicSetup` disabled — this is
 * the path used by spec / chat / diff surfaces.
 */
export function CodeBlock({
  value,
  lang = "text",
  editable = false,
  className,
  minHeight,
  onChange,
  onKeyDown,
}: CodeBlockProps): JSX.Element {
  const { resolvedTheme } = useTheme();
  const [Component, setComponent] = useState<CodeMirrorComponent | null>(codeMirrorCached);
  const [extension, setExtension] = useState<Extension | null>(null);
  const [theme, setTheme] = useState<Extension | null>(themeCached);
  const [darkHighlight, setDarkHighlight] = useState<Extension | null>(darkHighlightCached);

  useEffect(() => {
    let cancelled = false;
    loadCodeMirror().then((c) => {
      if (!cancelled) setComponent(c);
    });
    loadLanguage(lang).then((ext) => {
      if (!cancelled) setExtension(ext);
    });
    loadTheme().then((ext) => {
      if (!cancelled) setTheme(ext);
    });
    if (resolvedTheme === "dracula") {
      loadDarkHighlight().then((ext) => {
        if (!cancelled) setDarkHighlight(ext);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [lang, resolvedTheme]);

  if (Component === null) {
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-md border border-border bg-inset p-2 font-mono text-xs whitespace-pre",
          className,
        )}
      >
        {value}
      </pre>
    );
  }

  const extensions: Extension[] = [];
  if (theme !== null) extensions.push(theme);
  if (extension !== null) extensions.push(extension);
  if (resolvedTheme === "dracula" && darkHighlight !== null) extensions.push(darkHighlight);
  const basicSetup: CodeMirrorProps["basicSetup"] = editable
    ? true
    : { lineNumbers: false, highlightActiveLine: false, highlightActiveLineGutter: false };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-inset [&_.cm-editor]:rounded-md [&_.cm-editor]:bg-inset [&_.cm-scroller]:font-mono",
        className,
      )}
    >
      <Component
        value={value}
        editable={editable}
        readOnly={!editable}
        theme={resolvedTheme === "dracula" ? "dark" : "light"}
        basicSetup={basicSetup}
        extensions={extensions}
        minHeight={minHeight}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
