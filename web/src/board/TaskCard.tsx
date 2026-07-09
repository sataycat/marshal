import type { TaskCard } from "../types";
import { timeInState } from "../time";

interface Props {
  task: TaskCard;
  now: number;
  onClick: () => void;
}

export function TaskCardView({ task, now, onClick }: Props) {
  const retry = task.retry_count > 0 ? `retry ${task.retry_count} · ` : "";
  return (
    <button className="card" onClick={onClick} type="button">
      <span className="card-title">{task.title}</span>
      <span className="card-slug">{task.slug}</span>
      <span className="card-meta">
        {retry}
        {timeInState(task.updated_at, now)}
      </span>
    </button>
  );
}
