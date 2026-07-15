import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CodeBlock } from "./CodeBlock";
import { renderProse, type MarkdownStub } from "../markdown";
import { cn } from "@/lib/utils";

interface Props {
  src: string;
  /** Default editable state for hydrated blocks. Hovering surfaces an "Edit" affordance that flips an individual block. */
  editable?: boolean;
  className?: string;
}

interface StubHost {
  element: HTMLElement | null;
}

/**
 * Replaces the stub `<div data-cm>` with a fully-rendered CodeMirror block
 * + hover affordance. We portal into the stub so the new content lands
 * inside the existing DOM flow (between paragraphs of the surrounding
 * prose) without us having to mutate the `dangerouslySetInnerHTML` tree.
 */
function HydratedStub({
  stub,
  host,
  onEditToggle,
  isEditing,
}: {
  stub: MarkdownStub;
  host: HTMLElement | null;
  onEditToggle: () => void;
  isEditing: boolean;
}): JSX.Element | null {
  if (host === null) return null;
  return createPortal(
    <div className="group/cm relative my-2">
      {!isEditing && (
        <button
          type="button"
          className="absolute top-1 right-1 z-10 rounded-md border border-border bg-panel/90 px-1.5 py-0.5 text-[0.65rem] text-muted opacity-0 transition-opacity hover:text-text group-hover/cm:opacity-100"
          onClick={onEditToggle}
          aria-label="Edit this code block"
        >
          Edit
        </button>
      )}
      <CodeBlock value={stub.code} lang={stub.lang} editable={isEditing} />
    </div>,
    host,
  );
}

/**
 * Markdown-with-hydrated-code. `marked` runs once for the prose; the
 * resulting HTML keeps the surrounding text but every fenced code block
 * is replaced with a `<div data-cm data-lang="…" data-idx="…">` stub.
 * After mount, a ref-collecting loop walks the container, finds each
 * stub, and ports a `<CodeBlock>` (with its hover "Edit" affordance)
 * into it.
 *
 * The "edit on hover" affordance is per-block local state — flipping a
 * block to editable does not PATCH the spec; that is intentional per
 * ADR-0001a §2 and TODO §Pass 4.
 */
export function MarkdownWithCode({ src, editable = false, className }: Props): JSX.Element {
  const [html, setHtml] = useState<string | null>(null);
  const [stubs, setStubs] = useState<MarkdownStub[]>([]);
  const [editing, setEditing] = useState<Set<number>>(new Set());
  const [hosts, setHosts] = useState<StubHost[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEditing(new Set());
    setStubs([]);
    setHosts([]);
    setHtml(null);
    renderProse(src ?? "").then((out) => {
      if (cancelled) return;
      setHtml(out.html);
      setStubs(out.stubs);
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Ref-collecting pass: after each render that has both stubs and a
  // mounted container, walk the DOM and resolve each stub's live element.
  // This survives re-renders because we always look up by data-idx, which
  // is the stable identity per stub.
  useEffect(() => {
    if (html === null || stubs.length === 0) return;
    const container = containerRef.current;
    if (container === null) return;
    const next: StubHost[] = stubs.map((stub) => {
      const el = container.querySelector<HTMLElement>(
        `[data-cm][data-idx="${stub.idx}"]`,
      );
      return { element: el };
    });
    setHosts(next);
  }, [html, stubs]);

  const toggleEdit = (idx: number): void => {
    setEditing((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  if (html === null) {
    return (
      <pre className={cn("font-mono text-xs whitespace-pre-wrap", className)}>
        {src}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className={cn("markdown", className)}
      dangerouslySetInnerHTML={{ __html: html }}
    >
      {stubs.map((stub, i) => (
        <HydratedStub
          key={stub.idx}
          stub={stub}
          host={hosts[i]?.element ?? null}
          onEditToggle={() => toggleEdit(i)}
          isEditing={editable || editing.has(i)}
        />
      ))}
    </div>
  );
}
