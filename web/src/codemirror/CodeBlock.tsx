import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import { loadLanguage } from "./languages";
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
            backgroundColor: "var(--background)",
            color: "var(--foreground)",
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
          },
          ".cm-gutters": {
            backgroundColor: "var(--background)",
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
  const [Component, setComponent] = useState<CodeMirrorComponent | null>(codeMirrorCached);
  const [extension, setExtension] = useState<Extension | null>(null);
  const [theme, setTheme] = useState<Extension | null>(themeCached);

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
    return () => {
      cancelled = true;
    };
  }, [lang]);

  if (Component === null) {
    return (
      <pre
        className={cn(
          "overflow-x-auto rounded-md border border-border bg-muted p-2 font-mono text-xs whitespace-pre",
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
  const basicSetup: CodeMirrorProps["basicSetup"] = editable
    ? true
    : { lineNumbers: false, highlightActiveLine: false, highlightActiveLineGutter: false };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border bg-muted [&_.cm-editor]:rounded-md [&_.cm-editor]:bg-muted [&_.cm-scroller]:font-mono",
        className,
      )}
    >
      <Component
        value={value}
        editable={editable}
        readOnly={!editable}
        theme="light"
        basicSetup={basicSetup}
        extensions={extensions}
        minHeight={minHeight}
        onChange={onChange}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
