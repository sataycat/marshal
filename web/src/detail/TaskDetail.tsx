import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
import { useTaskDetailQuery, useTaskDiffQuery } from "../api/queries";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { useTaskStore } from "../state/taskStore";
import { queryKeys } from "../api/queryKeys";
import { useFreezeTaskMutation, useMergeTaskMutation, useTransitionTaskMutation } from "../api/queries";
import { useConfirmContext } from "../components/ConfirmDialog";
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
  const applyTaskEvent = useTaskStore((state) => state.applyTaskEvent);
  const freezeTask = useFreezeTaskMutation();
  const transitionTask = useTransitionTaskMutation();
  const mergeTask = useMergeTaskMutation();
  const queryClient = useQueryClient();
  const { confirm } = useConfirmContext();
  const detailQuery = useTaskDetailQuery(slug);
  const detail = detailQuery.data ?? null;
  const [localDetail, setLocalDetail] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveDetail = localDetail?.slug === slug ? localDetail : detail;
  const diffQuery = useTaskDiffQuery(slug, effectiveDetail?.status === "review");
  const diff = diffQuery.data?.diff ?? null;
  const diffStats = diffQuery.data?.stats ?? null;

  const runAction = async (action: BoardAction): Promise<void> => {
    if (effectiveDetail === null || busy) return;
    if (action.confirm) {
      const ok = await confirm({
        title: "Are you sure?",
        message: confirmMessage(action),
      });
      if (!ok) return;
    }
    setBusy(true);
    const previous: TaskDetail = effectiveDetail;
    setLocalDetail({ ...effectiveDetail, status: action.to });
    try {
      let result: TaskDetail | null;
      if (action.kind === "freeze") {
        result = await freezeTask.mutateAsync({ slug });
      } else if (action.kind === "merge") {
        result = (await mergeTask.mutateAsync(slug)).task;
      } else {
        result = await transitionTask.mutateAsync({ slug, to: action.to });
      }
      if (result) {
        const { spec_markdown: _spec, last_failure: _failure, ...card } = result;
        applyTaskEvent({ type: "task.updated", payload: card, timestamp: new Date().toISOString() });
        queryClient.setQueryData(queryKeys.task(slug), result);
        setLocalDetail(result);
      } else {
        setLocalDetail(previous);
      }
    } finally {
      setBusy(false);
    }
  };

  const actions = effectiveDetail ? actionsForStatus(effectiveDetail.status) : [];

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
                {effectiveDetail?.title ?? "Task Detail"}
              </SheetTitle>
              <SheetDescription className="font-mono text-xs">
                 {effectiveDetail?.slug ?? slug}
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
          {detailQuery.error && (
            <p className="mb-3 text-sm text-[var(--color-error)]">{detailQuery.error.message}</p>
          )}
          {detailQuery.isPending && <p className="text-sm text-muted">Loading…</p>}
          {effectiveDetail && (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
                <span>
                  Status:{" "}
                  <strong className="font-semibold text-text">
                    {effectiveDetail.status}
                  </strong>
                </span>
                <span>Retries: {effectiveDetail.retry_count}</span>
              </div>
                {effectiveDetail.last_failure && (
                <details className="rounded-md border border-[var(--color-error-border)] bg-[var(--color-error-bg)] p-2 text-xs">
                  <summary className="cursor-pointer font-medium text-[var(--color-error)]">
                    Last failure
                  </summary>
                  <pre className="mt-2 whitespace-pre-wrap font-mono text-xs text-text">
                     {effectiveDetail.last_failure}
                  </pre>
                </details>
              )}
              <Separator />
              <h3 className="text-sm font-semibold">Spec</h3>
               <MarkdownWithCode className="spec leading-relaxed" src={effectiveDetail.spec_markdown} />
               {effectiveDetail.status === "backlog" && (
                <SpecChatPanel
                  slug={slug}
                    onSpecUpdated={(updated) => setLocalDetail(updated)}
                  onFrozen={(frozen) => {
                    if (frozen) setLocalDetail(frozen);
                  }}
                />
              )}
               {effectiveDetail.status === "review" && (
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
                   {diffQuery.error && (
                    <p className="text-sm text-[var(--color-error)]">
                       {diffQuery.error.message}
                    </p>
                  )}
                   {diffQuery.isPending && (
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
