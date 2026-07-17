export const queryKeys = {
  tasks: ["tasks"] as const,
  task: (slug: string) => ["task", slug] as const,
  taskDiff: (slug: string) => ["task", slug, "diff"] as const,
  specMessages: (slug: string) => ["task", slug, "spec-messages"] as const,
  threads: (archived: boolean) => ["threads", { archived }] as const,
  thread: (id: string) => ["thread", id] as const,
  files: (id: string) => ["thread", id, "files"] as const,
  file: (id: string, path: string) => ["thread", id, "file", path] as const,
  permissions: (id: string) => ["thread", id, "permissions"] as const,
  attachments: (id: string) => ["thread", id, "attachments"] as const,
  chatAgents: ["chat-agents"] as const,
};
