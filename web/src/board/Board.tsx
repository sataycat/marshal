import { useState } from "react";
import type { TaskCard, TaskStatus } from "../types";
import { TaskCardView } from "./TaskCard";
import { TaskDetailPanel } from "../detail/TaskDetail";
import { useNow } from "../hooks/useNow";

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: "backlog", title: "Backlog" },
  { status: "ready", title: "Ready" },
  { status: "building", title: "Building" },
  { status: "validating", title: "Validating" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

interface Props {
  tasks: TaskCard[];
  status: string;
}

export function Board({ tasks, status }: Props) {
  const [selected, setSelected] = useState<TaskCard | null>(null);
  const now = useNow(5000);

  return (
    <div className="board">
      <header className="board-header">
        <h1>Marshal</h1>
        <span className={`ws-status ws-${status}`} title={`WebSocket: ${status}`}>
          {status}
        </span>
      </header>
      <div className="columns">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <section className="column" key={col.status}>
              <h2>
                {col.title} <span className="count">{items.length}</span>
              </h2>
              <div className="cards">
                {items.map((t) => (
                  <TaskCardView key={t.id} task={t} now={now} onClick={() => setSelected(t)} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {selected && (
        <TaskDetailPanel slug={selected.slug} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
