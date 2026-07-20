import { useState } from "react";
import { ArrowLeft, Eye, FileText, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "../codemirror/CodeBlock";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { shouldSendDraftKey } from "./draft";

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sending: boolean;
}

export function EditorPane({ value, onChange, onSend, sending, filePath, fileContent, onCloseFile }: Props & { filePath?: string | null; fileContent?: string | null; onCloseFile?: () => void }): JSX.Element {
  const [preview, setPreview] = useState(false);
  if (filePath !== undefined && filePath !== null) {
    return <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-border bg-bg md:border-r md:border-b-0 md:basis-[46%]"><header className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2"><Button type="button" size="icon-sm" variant="ghost" onClick={onCloseFile} aria-label="Back to draft"><ArrowLeft aria-hidden /></Button><FileText className="size-4 text-primary" aria-hidden /><div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{filePath}</h2><p className="text-[0.68rem] text-muted-foreground">Read-only file view</p></div><Button type="button" size="sm" onClick={() => onChange(`@${filePath}`)}><Send aria-hidden />Add mention</Button></header><div className="min-h-0 flex-1 overflow-auto p-3 md:p-4"><CodeBlock value={fileContent ?? "Loading file..."} lang={filePath.split(".").pop()} /></div></section>;
  }
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-border bg-bg md:border-r md:border-b-0 md:basis-[46%]">
      <header className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
        <FileText className="size-4 text-primary" aria-hidden />
        <div className="min-w-0 flex-1"><h2 className="text-sm font-semibold">Scratch draft</h2><p className="text-[0.68rem] text-muted-foreground">Markdown authoring buffer</p></div>
        <Button type="button" size="sm" variant={preview ? "default" : "outline"} onClick={() => setPreview((current) => !current)} aria-pressed={preview}><Eye aria-hidden />{preview ? "Edit" : "Preview"}</Button>
        <Button type="button" size="sm" onClick={onSend} disabled={sending || value.trim().length === 0}><Send aria-hidden />Send</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3 md:p-4">
        {preview ? <MarkdownWithCode className="mx-auto max-w-2xl text-sm leading-6" src={value || "_Nothing drafted yet._"} /> : <CodeBlock value={value} lang="md" editable onChange={onChange} onKeyDown={(event) => { if (shouldSendDraftKey(event)) { event.preventDefault(); onSend(); } }} minHeight="100%" className="min-h-full" />}
      </div>
      <p className="border-t border-border px-3 py-2 text-right text-[0.68rem] text-muted-foreground">Cmd/Ctrl+Enter to send, Shift+Enter for a new line</p>
    </section>
  );
}
