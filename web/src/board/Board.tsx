import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Plus } from "lucide-react";
import type { TaskCard, TaskStatus } from "../types";
import { TaskCardView } from "./TaskCard";
import { TaskDetailPanel } from "../detail/TaskDetail";
import { NewTaskModal } from "./NewTaskModal";
import { useTaskStore, selectTasks } from "../state/taskStore";
import { useNow } from "../hooks/useNow";
import { Button } from "@/components/ui/button";

const COLUMNS: { status: TaskStatus; title: string }[] = [
  { status: "backlog", title: "Backlog" },
  { status: "ready", title: "Ready" },
  { status: "building", title: "Building" },
  { status: "validating", title: "Validating" },
  { status: "review", title: "Review" },
  { status: "done", title: "Done" },
];

export function Board() {
  const tasks = useTaskStore(useShallow(selectTasks));
  const [selected, setSelected] = useState<TaskCard | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const now = useNow(5000);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-panel px-4 py-3 md:px-5">
        <h1 className="text-sm font-semibold tracking-wide uppercase text-muted">
          Board
        </h1>
        <div className="flex-1" />
        <Button onClick={() => setShowNewTask(true)} size="sm">
          <Plus aria-hidden />
          New Task
        </Button>
      </div>
      <div className="grid auto-rows-min gap-3 p-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <section
              className="flex min-h-32 flex-col gap-2 rounded-lg border border-border bg-panel p-2.5"
              key={col.status}
            >
              <h2 className="mb-1 flex items-center justify-between text-xs font-semibold tracking-wider text-muted uppercase">
                <span>{col.title}</span>
                <span className="rounded-md bg-secondary px-2 py-0.5 text-[0.65rem] text-text">
                  {items.length}
                </span>
              </h2>
              <div className="flex flex-col gap-2">
                {items.map((t) => (
                  <TaskCardView
                    key={t.id}
                    task={t}
                    now={now}
                    onClick={() => setSelected(t)}
                  />
                ))}
                {items.length === 0 && (
                  <p className="px-1 py-3 text-center text-xs text-muted">
                    No tasks.
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
      {selected && (
        <TaskDetailPanel slug={selected.slug} onClose={() => setSelected(null)} />
      )}
      {showNewTask && <NewTaskModal onClose={() => setShowNewTask(false)} />}
    </div>
  );
}
