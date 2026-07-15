import { type DiffFile } from "./parseDiff";
import { cn } from "@/lib/utils";

interface Props {
  files: DiffFile[];
}

export function DiffView({ files }: Props) {
  if (files.length === 0) {
    return <p className="text-sm text-muted">No changes.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {files.map((file, fi) => (
        <section
          key={`${file.newPath}-${fi}`}
          className="overflow-hidden rounded-md border border-border"
        >
          <header className="border-b border-border bg-muted px-2.5 py-1.5 font-mono text-xs">
            {file.newPath}
          </header>
          <pre className="m-0 overflow-x-auto p-0 font-mono text-xs leading-relaxed">
            {file.hunks.map((hunk, hi) => (
              <div
                key={hi}
                className={hi === 0 ? "" : "border-t border-border"}
              >
                <div className="bg-secondary px-2.5 py-0.5 text-muted">
                  {`@@ -${hunk.oldStart},${hunk.oldLen} +${hunk.newStart},${hunk.newLen} @@`}
                </div>
                {hunk.lines.map((line, li) => (
                  <div
                    key={li}
                    className={cn(
                      "flex whitespace-pre",
                      line.type === "add" &&
                        "bg-[var(--color-diff-add-bg)] text-[var(--color-diff-add-fg)]",
                      line.type === "del" &&
                        "bg-[var(--color-diff-del-bg)] text-[var(--color-diff-del-fg)]",
                    )}
                  >
                    <span
                      className={cn(
                        "w-6 shrink-0 text-center text-muted select-none",
                        line.type === "add" && "bg-[var(--color-diff-add-bg)]",
                        line.type === "del" && "bg-[var(--color-diff-del-bg)]",
                      )}
                    >
                      {line.type === "add" ? "+" : line.type === "del" ? "-" : " "}
                    </span>
                    <span className="flex-1 whitespace-pre-wrap pl-1">
                      {line.text}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </pre>
        </section>
      ))}
    </div>
  );
}
