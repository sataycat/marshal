import type { TaskCard } from "../types";
import { timeInState } from "../time";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "warn" | "success" | "error";

const ACCENT_BAR: Record<Tone, string> = {
  neutral: "before:bg-muted-foreground/30",
  accent: "before:bg-primary",
  warn: "before:bg-warn",
  success: "before:bg-success",
  error: "before:bg-error",
};

interface Props {
  task: TaskCard;
  now: number;
  tone: Tone;
  onClick: () => void;
}

export function TaskCardView({ task, now, tone, onClick }: Props) {
  return (
    <button
      onClick={onClick}
      type="button"
      className={cn(
        "relative flex cursor-pointer flex-col items-start gap-1 overflow-hidden rounded-lg border border-border bg-panel py-2.5 pr-3 pl-3.5 text-left",
        "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:content-['']",
        ACCENT_BAR[tone],
        "transition-colors hover:border-input hover:bg-card focus-visible:border-ring focus-visible:outline-none",
      )}
    >
      <span className="text-[0.8125rem] leading-snug font-medium text-text">{task.title}</span>
      <span className="max-w-full truncate font-mono text-[0.6875rem] text-muted-foreground">{task.slug}</span>
      <span className="mt-0.5 flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
        {task.retry_count > 0 && (
          <span className="rounded bg-warn-bg px-1 py-px font-medium text-warn">retry {task.retry_count}</span>
        )}
        {timeInState(task.updated_at, now)} in this state
      </span>
    </button>
  );
}
