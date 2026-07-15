import { useEffect, useState } from "react";
import { renderMarkdown } from "../markdown";

interface Props {
  src: string;
  className?: string;
}

/**
 * Renders markdown to HTML via the lazily-loaded `marked` chunk. The first
 * render of any `<Markdown>` in a session triggers the dynamic import; the
 * resolved module is cached by `markdown.ts` so subsequent mounts are
 * synchronous-ish. Until the HTML resolves, the raw source is shown in a
 * `<pre>` so the surface is never blank.
 */
export function Markdown({ src, className }: Props): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    renderMarkdown(src).then((out) => {
      if (!cancelled) setHtml(out);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  if (html === null) {
    return <pre className={className}>{src}</pre>;
  }
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}