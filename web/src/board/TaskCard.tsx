import type { TaskCard } from "../types";
import { timeInState } from "../time";
import { cn } from "@/lib/utils";

interface Props {
  task: TaskCard;
  now: number;
  onClick: () => void;
}

export function TaskCardView({ task, now, onClick }: Props) {
  const retry = task.retry_count > 0 ? `retry ${task.retry_count} · ` : "";
  return (
    <button
      onClick={onClick}
      type="button"
      className={cn(
        "flex cursor-pointer flex-col items-start gap-0.5 rounded-md border border-border bg-bg/40 p-2 text-left font-sans text-inherit",
        "transition-colors hover:border-primary focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
      )}
    >
      <span className="text-sm font-semibold text-text">{task.title}</span>
      <span className="font-mono text-xs text-muted">{task.slug}</span>
      <span className="text-[0.7rem] text-muted">
        {retry}
        {timeInState(task.updated_at, now)}
      </span>
    </button>
  );
}
