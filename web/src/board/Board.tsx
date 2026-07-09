import { useState } from "react";
import type { TaskCard, TaskStatus } from "../types";
import { TaskCardView } from "./TaskCard";
import { TaskDetailPanel } from "../detail/TaskDetail";
import { NewTaskModal } from "./NewTaskModal";
import { ToastHost } from "../toast/ToastHost";
import { useBoardContext } from "./BoardContext";
import { useNow } from "../hooks/useNow";

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: "backlog", title: "Backlog" },
  { status: "ready", title: "Ready" },
  { status: "building", title: "Building" },
  { status: "validating", title: "Validating" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

export function Board() {
  const { tasks, status } = useBoardContext();
  const [selected, setSelected] = useState<TaskCard | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const now = useNow(5000);

  return (
    <div className="board">
      <header className="board-header">
        <h1>Marshal</h1>
        <div className="board-header-actions">
          <button type="button" className="btn btn-primary" onClick={() => setShowNewTask(true)}>
            New Task
          </button>
          <span className={`ws-status ws-${status}`} title={`WebSocket: ${status}`}>
            {status}
          </span>
        </div>
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
      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} />}
      <ToastHost />
    </div>
  );
}
