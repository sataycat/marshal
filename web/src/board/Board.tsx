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
import { StatusDot } from "../components/status";
import { cn } from "@/lib/utils";

const COLUMNS: { status: TaskStatus; title: string; tone: "neutral" | "accent" | "warn" | "success" }[] = [
  { status: "backlog", title: "Backlog", tone: "neutral" },
  { status: "ready", title: "Ready", tone: "accent" },
  { status: "building", title: "Building", tone: "warn" },
  { status: "validating", title: "Validating", tone: "warn" },
  { status: "review", title: "Review", tone: "accent" },
  { status: "done", title: "Done", tone: "success" },
];

export function Board() {
  const tasks = useTaskStore(useShallow(selectTasks));
  const [selected, setSelected] = useState<TaskCard | null>(null);
  const [showNewTask, setShowNewTask] = useState(false);
  const now = useNow(5000);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-panel px-4 py-3 md:px-6">
        <div className="min-w-0">
          <p className="eyebrow">Software factory</p>
          <h1 className="mt-0.5 text-sm font-semibold tracking-tight">Execution board</h1>
        </div>
        <div className="flex-1" />
        <Button onClick={() => setShowNewTask(true)} size="sm">
          <Plus aria-hidden />
          New task
        </Button>
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-min gap-3 overflow-auto p-3 sm:grid-cols-2 md:grid-cols-3 md:p-4 lg:grid-cols-6">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.status);
          return (
            <section key={col.status} className="flex min-h-32 flex-col" aria-label={`${col.title} tasks`}>
              <h2 className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-text">
                <StatusDot tone={col.tone} className={cn((col.status === "building" || col.status === "validating") && "animate-pulse")} />
                {col.title}
                <span className="ml-auto rounded-md bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium text-muted-foreground">{items.length}</span>
              </h2>
              <div className="flex flex-col gap-2">
                {items.map((t) => (
                  <TaskCardView key={t.id} task={t} now={now} tone={col.tone} onClick={() => setSelected(t)} />
                ))}
                {items.length === 0 && (
                  <p className="rounded-lg border border-dashed border-border px-2 py-4 text-center text-xs text-muted-foreground">
                    No tasks
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
