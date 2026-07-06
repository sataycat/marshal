import { openDb } from "../db/index.js";

export interface Task {
  id: number;
  slug: string;
  title: string;
  status: string;
  spec_markdown: string;
  created_at: string;
  updated_at: string;
}

export function listTasks(root?: string): Task[] {
  const db = openDb(root);
  return db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all() as Task[];
}
