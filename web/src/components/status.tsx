import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { AgentReadinessStatus, ChatThreadStatus, InstalledAgentStatus, TaskStatus } from "../types";

type Tone = "success" | "warn" | "error" | "accent" | "neutral";

const TASK_STATUS: Record<TaskStatus, { tone: Tone; label: string }> = {
  backlog: { tone: "neutral", label: "Backlog" },
  ready: { tone: "accent", label: "Ready" },
  building: { tone: "warn", label: "Building" },
  validating: { tone: "warn", label: "Validating" },
  review: { tone: "accent", label: "Review" },
  done: { tone: "success", label: "Done" },
};

const THREAD_STATUS: Record<ChatThreadStatus, { tone: Tone; label: string }> = {
  draft: { tone: "neutral", label: "Draft" },
  active: { tone: "success", label: "Active" },
  closed: { tone: "neutral", label: "Closed" },
  error: { tone: "error", label: "Error" },
};

const READINESS: Record<AgentReadinessStatus, { tone: Tone; label: string }> = {
  unknown: { tone: "neutral", label: "Not probed" },
  probing: { tone: "accent", label: "Probing" },
  ready: { tone: "success", label: "Ready" },
  authentication_required: { tone: "warn", label: "Auth required" },
  failed: { tone: "error", label: "Probe failed" },
};

const INSTALL_STATUS: Record<InstalledAgentStatus, { tone: Tone; label: string }> = {
  installing: { tone: "accent", label: "Installing" },
  installed: { tone: "success", label: "Installed" },
  failed: { tone: "error", label: "Failed" },
  interrupted: { tone: "warn", label: "Interrupted" },
};

const DOT_TONE: Record<Tone, string> = {
  success: "bg-success",
  warn: "bg-warn",
  error: "bg-error",
  accent: "bg-primary",
  neutral: "bg-muted-foreground/40",
};

export function StatusDot({ tone, className }: { tone: Tone; className?: string }): JSX.Element {
  return <span aria-hidden className={cn("inline-block size-1.5 shrink-0 rounded-full", DOT_TONE[tone], className)} />;
}

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }): JSX.Element {
  const meta = TASK_STATUS[status];
  return <Badge tone={meta.tone} className={className}><StatusDot tone={meta.tone} />{meta.label}</Badge>;
}

export function ThreadStatusDot({ status, className }: { status: ChatThreadStatus; className?: string }): JSX.Element {
  const meta = THREAD_STATUS[status];
  return <StatusDot tone={meta.tone} className={className} />;
}

export function threadStatusLabel(status: ChatThreadStatus): string {
  return THREAD_STATUS[status].label;
}

export function ReadinessBadge({ status, className }: { status: AgentReadinessStatus; className?: string }): JSX.Element {
  const meta = READINESS[status];
  return <Badge tone={meta.tone} className={className}><StatusDot tone={meta.tone} />{meta.label}</Badge>;
}

export function InstallStatusBadge({ status, className }: { status: InstalledAgentStatus; className?: string }): JSX.Element {
  const meta = INSTALL_STATUS[status];
  return <Badge tone={meta.tone} className={className}><StatusDot tone={meta.tone} />{meta.label}</Badge>;
}
