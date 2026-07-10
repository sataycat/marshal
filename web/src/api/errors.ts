export interface ApiErrorLike {
  message?: string;
  code?: string;
  status?: number;
}

export function extractErrorMessage(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const e = err as ApiErrorLike;
    if (typeof e.message === "string" && e.message.length > 0) return e.message;
  }
  if (typeof err === "string" && err.length > 0) return err;
  return "Unknown error";
}

export function friendlyErrorMessage(err: unknown): string {
  const base = extractErrorMessage(err);
  const code =
    err !== null && typeof err === "object" && "code" in err
      ? (err as ApiErrorLike).code
      : undefined;
  if (code === "invalid_transition") {
    return "That transition is not allowed from the current state.";
  }
  if (code === "freeze_failed") {
    return "Could not freeze the spec. Make sure the spec is not empty.";
  }
  if (code === "duplicate_slug") {
    return "A task with that title already exists.";
  }
  if (code === "task_not_found") {
    return "That task no longer exists.";
  }
  if (code === "merge_conflict") {
    return "The merge has conflicts. Resolve them in your checkout and retry.";
  }
  if (code === "merge_failed") {
    return "The merge could not be completed. The source checkout may be dirty.";
  }
  if (code === "no_worktree") {
    return "This task has no worktree to merge.";
  }
  if (code === "not_review") {
    return "That action is only available while the task is in review.";
  }
  if (code === "diff_failed") {
    return "Could not load the diff for this task.";
  }
  return base;
}
