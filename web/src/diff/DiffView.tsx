import { type DiffFile } from "./parseDiff";
import { CodeBlock } from "../codemirror/CodeBlock";
import { cn } from "@/lib/utils";

interface Props {
  files: DiffFile[];
}

function lineToText(line: { type: "add" | "del" | "context"; text: string }): string {
  if (line.type === "add") return `+${line.text}`;
  if (line.type === "del") return `-${line.text}`;
  return ` ${line.text}`;
}

function hunkToText(hunk: DiffFile["hunks"][number]): string {
  return hunk.lines.map(lineToText).join("\n");
}

export function DiffView({ files }: Props) {
  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground">No changes.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {files.map((file, fi) => (
        <section
          key={`${file.newPath}-${fi}`}
          className="overflow-hidden rounded-md border border-border"
        >
          <header className="border-b border-border bg-inset px-2.5 py-1.5 font-mono text-xs">
            {file.newPath}
          </header>
          <div className="font-mono text-xs leading-relaxed">
            {file.hunks.map((hunk, hi) => (
              <div
                key={hi}
                className={hi === 0 ? "" : "border-t border-border"}
              >
                <div className="bg-secondary px-2.5 py-0.5 text-muted-foreground">
                  {`@@ -${hunk.oldStart},${hunk.oldLen} +${hunk.newStart},${hunk.newLen} @@`}
                </div>
                <CodeBlock
                  value={hunkToText(hunk)}
                  lang="diff"
                  editable={false}
                  minHeight="0"
                  className={cn(
                    "!rounded-none !border-0 !bg-inset",
                    "[&_.cm-editor]:!bg-inset [&_.cm-editor]:!shadow-none",
                    "[&_.cm-scroller]:!overflow-x-auto [&_.cm-content]:!py-1",
                  )}
                />
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
