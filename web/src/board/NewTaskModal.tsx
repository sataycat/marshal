import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel, FieldDescription } from "@/components/ui/field";
import { useTaskStore } from "../state/taskStore";
import { useToastStore } from "../state/toastStore";
import { useCreateTaskMutation } from "../api/queries";
import { useRepositoriesQuery, useWorkflowProfilesQuery } from "../api/queries";

interface Props {
  onClose: () => void;
}

export function NewTaskModal({ onClose }: Props) {
  const applyTaskEvent = useTaskStore((state) => state.applyTaskEvent);
  const createTask = useCreateTaskMutation();
  const pushError = useToastStore((state) => state.pushError);
  const [title, setTitle] = useState("");
  const [spec, setSpec] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const repositories = useRepositoriesQuery();
  const repositoryId = repositories.data?.selected_repository_id ?? null;
  const profiles = useWorkflowProfilesQuery(repositoryId);
  const [profileId, setProfileId] = useState("");

  const submit = async (): Promise<void> => {
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      pushError("Title is required.");
      return;
    }
    if (!profileId) { pushError("Select a workflow profile."); return; }
    setSubmitting(true);
    const task = await createTask.mutateAsync({
      title: trimmed,
      spec_markdown: spec.trim().length > 0 ? spec : undefined,
      repository_id: repositoryId ?? undefined,
      workflow_profile_id: profileId || undefined,
    });
    const { spec_markdown: _spec, last_failure: _failure, ...card } = task;
    applyTaskEvent({ type: "task.created", payload: card, timestamp: new Date().toISOString() });
    setSubmitting(false);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New Task</DialogTitle>
          <DialogDescription>
            Create a backlog task. You can refine the spec in chat before freezing.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="new-task-profile">Workflow profile</FieldLabel>
            <select id="new-task-profile" className="h-10 w-full rounded-md border border-input bg-transparent px-2" value={profileId} onChange={(e) => setProfileId(e.target.value)} required>
              <option value="">Select a profile</option>
              {(profiles.data ?? []).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <FieldDescription>Authoring uses this profile's spec-author assignment. The task remains backlog until you review and freeze it.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="new-task-title">Title</FieldLabel>
            <Input
              id="new-task-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="A short, descriptive task title"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="new-task-spec">Spec markdown (optional)</FieldLabel>
            <FieldDescription>
              Initial spec. Editable in chat; frozen before build.
            </FieldDescription>
            <Textarea
              id="new-task-spec"
              value={spec}
              onChange={(e) => setSpec(e.target.value)}
              rows={10}
              placeholder={"## Goal\nDescribe what this task should accomplish."}
              className="font-mono text-sm"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? "Creating…" : "Create Task"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
