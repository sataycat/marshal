import { useEffect, useState } from "react";
import { X } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { fetchTaskDetail, fetchTaskDiff, type DiffStats } from "../api/client";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { useBoardContext } from "../board/BoardContext";
import { actionsForStatus, confirmMessage, type BoardAction } from "../board/actions";
import type { TaskDetail } from "../types";
import { DiffView } from "../diff/DiffView";
import { parseUnifiedDiff } from "../diff/parseDiff";
import { SpecChatPanel } from "../specchat/SpecChatPanel";

interface Props {
  slug: string;
  onClose: () => void;
}

export function TaskDetailPanel({ slug, onClose }: Props) {
  const { freezeTask, transitionTask, mergeTask, confirm } = useBoardContext();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setDiff(null);
    setDiffError(null);
    setDiffStats(null);
    fetchTaskDetail(slug)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    setDiffError(null);
    setDiffStats(null);
    if (detail === null || detail.status !== "review") return;
    fetchTaskDiff(slug)
      .then((res) => {
        if (cancelled) return;
        setDiff(res.diff);
        setDiffStats(res.stats);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setDiff(null);
        setDiffError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [slug, detail?.status]);

  const runAction = async (action: BoardAction): Promise<void> => {
    if (detail === null || busy) return;
    if (action.confirm) {
      const ok = await confirm({
        title: "Are you sure?",
        message: confirmMessage(action),
      });
      if (!ok) return;
    }
    setBusy(true);
    const previous: TaskDetail = detail;
    setDetail({ ...detail, status: action.to });
    try {
      let result: TaskDetail | null;
      if (action.kind === "freeze") {
        result = await freezeTask(slug, previous);
      } else if (action.kind === "merge") {
        result = await mergeTask(slug, previous);
      } else {
        result = await transitionTask(slug, action.to, previous);
      }
      if (result) {
        setDetail(result);
      } else {
        setDetail(previous);
      }
    } finally {
      setBusy(false);
    }
  };

  const actions = detail ? actionsForStatus(detail.status) : [];

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <SheetTitle className="truncate text-base">
                {detail?.title ?? "Task Detail"}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs">
                {detail?.slug ?? slug}
              </SheetDescription>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close detail"
            >
              <X aria-hidden />
            </Button>
          </div>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <p className="mb-3 text-sm text-[var(--color-error)]">{error}</p>
          )}
          {!detail && !error && <p className="text-sm text-muted">Loading…</p>}
          {detail && (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
                <span>
                  Status:{" "}
                  <strong className="font-semibold text-text">
                    {detail.status}
                  </strong>
                </span>
                <span>Retries: {detail.retry_count}</span>
              </div>
              {detail.last_failure && (
                <details className="rounded-md border border-[var(--color-error-border)] bg-[var(--color-error-bg)] p-2 text-xs">
                  <summary className="cursor-pointer font-medium text-[var(--color-error)]">
                    Last failure
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-text">
                    {detail.last_failure}
                  </pre>
                </details>
              )}
              <Separator />
              <h3 className="text-sm font-semibold">Spec</h3>
              <MarkdownWithCode className="spec leading-relaxed" src={detail.spec_markdown} />
              {detail.status === "backlog" && (
                <SpecChatPanel
                  slug={slug}
                  detail={detail}
                  onSpecUpdated={(updated) => setDetail(updated)}
                  onFrozen={(frozen) => {
                    if (frozen) setDetail(frozen);
                  }}
                />
              )}
              {detail.status === "review" && (
                <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
                  <h3 className="flex items-baseline gap-2 text-sm font-semibold">
                    Diff
                    {diffStats && (
                      <span className="text-xs font-normal text-muted">
                        {" "}· {diffStats.files} file
                        {diffStats.files === 1 ? "" : "s"}, +
                        {diffStats.insertions}, -{diffStats.deletions}
                      </span>
                    )}
                  </h3>
                  {diffError && (
                    <p className="text-sm text-[var(--color-error)]">
                      {diffError}
                    </p>
                  )}
                  {!diff && !diffError && (
                    <p className="text-sm text-muted">Loading diff…</p>
                  )}
                  {diff !== null && <DiffView files={parseUnifiedDiff(diff)} />}
                </div>
              )}
            </div>
          )}
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-border bg-muted/30 p-3">
            {actions.map((action) => {
              const isWarn = action.confirm;
              const isPrimary = action.kind === "merge" || action.kind === "freeze";
              return (
                <Button
                  key={action.key}
                  type="button"
                  variant={
                    isPrimary ? "default" : isWarn ? "destructive" : "outline"
                  }
                  onClick={() => void runAction(action)}
                  disabled={busy}
                  size="sm"
                >
                  {action.label}
                </Button>
              );
            })}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
