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
import { useRecoverRunAuthenticationMutation, useTaskDetailQuery, useTaskDiffQuery, useTaskRunsQuery } from "../api/queries";
import { MarkdownWithCode } from "../codemirror/MarkdownWithCode";
import { useTaskStore } from "../state/taskStore";
import { queryKeys } from "../api/queryKeys";
import { useFreezeTaskMutation, useMergeTaskMutation, useTransitionTaskMutation } from "../api/queries";
import { useConfirmContext } from "../components/ConfirmDialog";
import { TaskStatusBadge } from "../components/status";
import { actionsForStatus, confirmMessage, type BoardAction } from "../board/actions";
import type { TaskDetail } from "../types";
import { workflowAuthRecoveryAvailable, workflowAuthRecoveryCopy } from "../workflows/authRecovery";
import { DiffView } from "../diff/DiffView";
import { parseUnifiedDiff } from "../diff/parseDiff";
import { SpecChatPanel } from "../specchat/SpecChatPanel";
import { useRepositoriesQuery } from "../api/queries";

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
  const repositories = useRepositoriesQuery();
  const repositoryId = repositories.data?.selected_repository_id ?? null;
  const { confirm } = useConfirmContext();
  const detailQuery = useTaskDetailQuery(slug, repositoryId);
  const runsQuery = useTaskRunsQuery(slug, repositoryId);
  const recoverRun = useRecoverRunAuthenticationMutation();
  const detail = detailQuery.data ?? null;
  const [localDetail, setLocalDetail] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const effectiveDetail = localDetail?.slug === slug ? localDetail : detail;
  const diffQuery = useTaskDiffQuery(slug, repositoryId, effectiveDetail?.status === "review");
  const diff = diffQuery.data?.diff ?? null;
  const diffStats = diffQuery.data?.stats ?? null;
  const blockedRun = runsQuery.data?.find(workflowAuthRecoveryAvailable) ?? null;
  const recoverAuthentication = async (): Promise<void> => { if (!blockedRun || busy || !repositoryId) return; setBusy(true); try { await recoverRun.mutateAsync({ runId: blockedRun.id, repositoryId }); await Promise.all([queryClient.invalidateQueries({ queryKey: queryKeys.task(slug, repositoryId) }), queryClient.invalidateQueries({ queryKey: queryKeys.taskRuns(slug, repositoryId) }), queryClient.invalidateQueries({ queryKey: queryKeys.tasks(repositoryId) })]); const refreshed = await detailQuery.refetch(); if (refreshed.data) setLocalDetail(refreshed.data); } finally { setBusy(false); } };

  const runAction = async (action: BoardAction): Promise<void> => {
    if (effectiveDetail === null || busy) return;
    if (action.confirm) {
      const ok = await confirm({
        title: action.label,
        message: confirmMessage(action),
        confirmLabel: action.label,
      });
      if (!ok) return;
    }
    setBusy(true);
    const previous: TaskDetail = effectiveDetail;
    setLocalDetail({ ...effectiveDetail, status: action.to });
    try {
      let result: TaskDetail | null;
      if (action.kind === "freeze") {
         result = await freezeTask.mutateAsync({ slug, repositoryId: repositoryId! });
      } else if (action.kind === "merge") {
         result = (await mergeTask.mutateAsync({ slug, repositoryId: repositoryId! })).task;
      } else {
         result = await transitionTask.mutateAsync({ slug, repositoryId: repositoryId!, to: action.to });
      }
      if (result) {
        const { spec_markdown: _spec, last_failure: _failure, ...card } = result;
        applyTaskEvent({ type: "task.updated", payload: card, timestamp: new Date().toISOString() });
         queryClient.setQueryData(queryKeys.task(slug, repositoryId), result);
        setLocalDetail(result);
      } else {
        setLocalDetail(previous);
      }
    } finally {
      setBusy(false);
    }
  };

  const actions = effectiveDetail ? actionsForStatus(effectiveDetail.status) : [];
  const primaryActions = actions.filter((action) => action.kind === "merge" || action.kind === "freeze");
  const secondaryActions = actions.filter((action) => action.kind !== "merge" && action.kind !== "freeze");

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b border-border p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                {effectiveDetail && <TaskStatusBadge status={effectiveDetail.status} />}
              </div>
              <SheetTitle className="mt-2 truncate text-base">
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
            <p className="mb-3 rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error">{detailQuery.error.message}</p>
          )}
          {detailQuery.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {effectiveDetail && (
            <div className="flex flex-col gap-4 text-sm">
              <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                <div className="flex gap-1.5"><dt>Retries</dt><dd className="font-medium text-text">{effectiveDetail.retry_count}</dd></div>
                <div className="flex gap-1.5"><dt>Updated</dt><dd className="font-medium text-text">{new Date(effectiveDetail.updated_at).toLocaleString()}</dd></div>
              </dl>
              {effectiveDetail.last_failure && (
                <details className="rounded-lg border border-error-border bg-error-bg p-3 text-xs">
                  <summary className="cursor-pointer font-semibold text-error">
                    Last failure
                  </summary>
                  <pre className="mt-2 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-text">
                    {effectiveDetail.last_failure}
                  </pre>
                </details>
              )}
              {blockedRun && <section className="rounded-lg border border-warn-border bg-warn-bg p-3 text-xs text-warn"><p className="font-semibold">{blockedRun.role === "builder" ? "Builder" : "Validator"} sign-in required</p><p className="mt-1">{workflowAuthRecoveryCopy(blockedRun.role)}</p><Button type="button" className="mt-2" size="sm" variant="outline" onClick={() => void recoverAuthentication()} disabled={busy}>Authorize new attempt</Button></section>}
              <section>
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">Spec</h3>
                <MarkdownWithCode className="spec" src={effectiveDetail.spec_markdown} />
              </section>
              {effectiveDetail.status === "backlog" && (
                <SpecChatPanel
                   slug={slug}
                   repositoryId={repositoryId}
                  onSpecUpdated={(updated) => setLocalDetail(updated)}
                  onFrozen={(frozen) => {
                    if (frozen) setLocalDetail(frozen);
                  }}
                />
              )}
              {effectiveDetail.status === "review" && (
                <section className="border-t border-border pt-4">
                  <h3 className="mb-2 flex items-baseline gap-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Diff
                    {diffStats && (
                      <span className="font-mono font-normal normal-case">
                        {diffStats.files} file{diffStats.files === 1 ? "" : "s"} · <span className="text-success">+{diffStats.insertions}</span> <span className="text-error">-{diffStats.deletions}</span>
                      </span>
                    )}
                  </h3>
                  {diffQuery.error && (
                    <p className="rounded-lg border border-error-border bg-error-bg px-3 py-2 text-sm text-error">
                      {diffQuery.error.message}
                    </p>
                  )}
                  {diffQuery.isPending && (
                    <p className="text-sm text-muted-foreground">Loading diff…</p>
                  )}
                  {diff !== null && <DiffView files={parseUnifiedDiff(diff)} />}
                </section>
              )}
            </div>
          )}
        </div>
        {actions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border bg-panel p-3">
            {secondaryActions.map((action) => (
              <Button
                key={action.key}
                type="button"
                variant="outline"
                onClick={() => void runAction(action)}
                disabled={busy}
                size="sm"
              >
                {action.label}
              </Button>
            ))}
            <div className="flex-1" />
            {primaryActions.map((action) => (
              <Button
                key={action.key}
                type="button"
                onClick={() => void runAction(action)}
                disabled={busy}
                size="sm"
              >
                {action.label}
              </Button>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
