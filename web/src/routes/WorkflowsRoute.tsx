import { useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { Badge } from "../components/ui/badge";
import { PageHeader } from "../components/PageHeader";
import { useConfirmContext } from "../components/ConfirmDialog";
import { useInstalledAgentsQuery, useWorkflowProfilesQuery, useCreateWorkflowProfileMutation, useUpdateWorkflowProfileMutation, useDeleteWorkflowProfileMutation } from "../api/queries";
import { useRepositoriesQuery } from "../api/queries";
import { cn } from "@/lib/utils";
import type { WorkflowRole, PermissionPolicy, WorkflowProfile } from "../types";

const roles: WorkflowRole[] = ["specAuthor", "builder", "validator"];
const labels: Record<WorkflowRole, string> = { specAuthor: "Spec author", builder: "Builder", validator: "Validator" };
const roleHints: Record<WorkflowRole, string> = {
  specAuthor: "Refines the task spec before freeze.",
  builder: "Implements the frozen spec in a worktree.",
  validator: "Independently verifies the build result.",
};

const selectClass = "h-9 w-full rounded-lg border border-input bg-transparent px-2 text-sm text-text outline-none transition-colors focus-visible:border-ring";

export function WorkflowsRoute(): JSX.Element {
  const repositories = useRepositoriesQuery();
  const repositoryId = repositories.data?.selected_repository_id ?? null;
  const profiles = useWorkflowProfilesQuery(repositoryId);
  const agents = useInstalledAgentsQuery();
  const create = useCreateWorkflowProfileMutation();
  const update = useUpdateWorkflowProfileMutation();
  const remove = useDeleteWorkflowProfileMutation();
  const { confirm } = useConfirmContext();
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("Default workflow");
  const [policy, setPolicy] = useState<PermissionPolicy>("allow_reads_ask_writes");
  const [unattended, setUnattended] = useState(false);
  const [timeoutMinutes, setTimeoutMinutes] = useState(5);
  const [retries, setRetries] = useState(2);
  const [commands, setCommands] = useState("pnpm run check\npnpm run test");
  const [decorrelate, setDecorrelate] = useState(true);
  const [assignments, setAssignments] = useState<Record<WorkflowRole, { agent_id: string; agent_version: string; model: string; mode: string }>>({ specAuthor: blank(), builder: blank(), validator: blank() });
  const readyAgents = useMemo(() => (agents.data ?? []).filter((agent) => agent.status === "installed" && agent.readiness_status === "ready"), [agents.data]);

  const edit = (profile: WorkflowProfile): void => {
    setSelected(profile.id);
    setName(profile.name);
    setPolicy(profile.permission_policy);
    setUnattended(profile.unattended_authorized);
    setTimeoutMinutes(profile.timeout_ms / 60000);
    setRetries(profile.max_retries);
    setCommands(profile.verification_commands.join("\n"));
    setDecorrelate(profile.require_decorrelated_builder_validator);
    setAssignments(Object.fromEntries(roles.map((role) => {
      const item = profile.assignments.find((entry) => entry.role === role);
      return [role, { agent_id: item?.agent_id ?? "", agent_version: item?.agent_version ?? "", model: item?.model ?? "", mode: item?.mode ?? "" }];
    })) as typeof assignments);
  };

  const save = async (): Promise<void> => {
    if (!repositoryId) return;
    const input = {
      name,
      permission_policy: policy,
      unattended_authorized: unattended,
      timeout_ms: Math.round(timeoutMinutes * 60000),
      max_retries: retries,
      verification_commands: commands.split("\n").map((line) => line.trim()).filter(Boolean),
      require_decorrelated_builder_validator: decorrelate,
      assignments: roles.filter((role) => assignments[role].agent_id).map((role) => ({ role, ...assignments[role], model: assignments[role].model || null, mode: assignments[role].mode || null })),
    };
    if (selected) await update.mutateAsync({ repositoryId, id: selected, input });
    else {
      const profile = await create.mutateAsync({ repositoryId, input });
      setSelected(profile.id);
    }
    await profiles.refetch();
  };

  const removeProfile = async (): Promise<void> => {
    if (!repositoryId || !selected) return;
    const ok = await confirm({ title: "Delete workflow profile", message: "Delete this workflow profile? Tasks that reference it keep their history.", confirmLabel: "Delete" });
    if (!ok) return;
    await remove.mutateAsync({ repositoryId, id: selected });
    setSelected(null);
    await profiles.refetch();
  };

  const saving = create.isPending || update.isPending;

  return (
    <div className="mx-auto w-full max-w-6xl overflow-y-auto px-4 py-6 md:px-8">
      <PageHeader
        eyebrow="Software factory"
        title="Workflow profiles"
        description="Assign installed agents to the spec, build, and validate roles. Assignment never starts an agent — unattended execution is a separate, explicit decision."
      />
      <div className="mt-6 grid gap-6 lg:grid-cols-[16rem_1fr]">
        <aside>
          <Button variant="outline" className="w-full" onClick={() => { setSelected(null); setName("New workflow"); setPolicy("allow_reads_ask_writes"); setUnattended(false); setTimeoutMinutes(5); setRetries(2); setCommands(""); setDecorrelate(true); setAssignments({ specAuthor: blank(), builder: blank(), validator: blank() }); }}>
            <Plus aria-hidden />
            New profile
          </Button>
          <div className="mt-3 space-y-2">
            {(profiles.data ?? []).map((profile) => (
              <button
                key={profile.id}
                type="button"
                onClick={() => edit(profile)}
                className={cn(
                  "block w-full rounded-xl border p-3 text-left transition-colors",
                  selected === profile.id ? "border-primary/50 bg-primary/5" : "border-border bg-panel hover:border-input",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <span className="min-w-0 flex-1 truncate">{profile.name}</span>
                  {profile.unattended_authorized && <Badge tone="warn">Unattended</Badge>}
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {profile.assignments.length} of 3 roles assigned · {policyLabel(profile.permission_policy)}
                </span>
              </button>
            ))}
            {profiles.data?.length === 0 && <p className="px-1 py-2 text-xs text-muted-foreground">No profiles yet. Create one to assign agents to factory roles.</p>}
          </div>
        </aside>

        <div className="flex flex-col gap-5">
          <section className="rounded-xl border border-border bg-panel p-5" aria-labelledby="wf-roles">
            <h2 id="wf-roles" className="text-sm font-semibold">Agent assignments</h2>
            <p className="mt-1 text-xs text-muted-foreground">Only installed, ready agents can be assigned. The same agent may fill several roles.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-3">
              {roles.map((role) => (
                <div key={role} className="rounded-lg border border-border bg-inset p-3.5">
                  <h3 className="text-sm font-medium">{labels[role]}</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">{roleHints[role]}</p>
                  <label className="mt-3 block text-xs font-medium text-muted-foreground">
                    Agent
                    <select
                      className={cn(selectClass, "mt-1 font-mono text-xs")}
                      value={assignments[role].agent_id ? `${assignments[role].agent_id}\n${assignments[role].agent_version}` : ""}
                      onChange={(event) => {
                        const [agent_id, agent_version] = event.target.value.split("\n");
                        setAssignments({ ...assignments, [role]: { ...assignments[role], agent_id, agent_version } });
                      }}
                    >
                      <option value="">Unassigned</option>
                      {readyAgents.map((agent) => <option key={`${agent.id}@${agent.version}`} value={`${agent.id}\n${agent.version}`}>{agent.id}@{agent.version}</option>)}
                    </select>
                  </label>
                  <label className="mt-2.5 block text-xs font-medium text-muted-foreground">
                    Model <span className="font-normal">(optional)</span>
                    <Input className="mt-1 h-8 font-mono text-xs" placeholder="e.g. sonnet" value={assignments[role].model} onChange={(event) => setAssignments({ ...assignments, [role]: { ...assignments[role], model: event.target.value } })} />
                  </label>
                  <label className="mt-2.5 block text-xs font-medium text-muted-foreground">
                    Mode <span className="font-normal">(optional)</span>
                    <Input className="mt-1 h-8 font-mono text-xs" placeholder="e.g. plan" value={assignments[role].mode} onChange={(event) => setAssignments({ ...assignments, [role]: { ...assignments[role], mode: event.target.value } })} />
                  </label>
                </div>
              ))}
            </div>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={decorrelate} onChange={(event) => setDecorrelate(event.target.checked)} />
              Require builder and validator to differ
              <span className="text-xs text-muted-foreground">— validation should not inherit the builder's blind spots.</span>
            </label>
          </section>

          <section className="rounded-xl border border-border bg-panel p-5" aria-labelledby="wf-policy">
            <h2 id="wf-policy" className="text-sm font-semibold">Permissions and limits</h2>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium">
                Permission policy
                <select className={cn(selectClass, "mt-1")} value={policy} onChange={(event) => setPolicy(event.target.value as PermissionPolicy)}>
                  <option value="reject_all">Reject all</option>
                  <option value="allow_reads_ask_writes">Allow reads, ask for writes</option>
                  <option value="allow_workspace">Allow within workspace</option>
                  <option value="unattended_allow_all">Unattended allow-all (sandbox required)</option>
                </select>
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="text-sm font-medium">
                  Timeout (minutes)
                  <Input type="number" min={0.5} step={0.5} className="mt-1" value={timeoutMinutes} onChange={(event) => setTimeoutMinutes(Number(event.target.value))} />
                </label>
                <label className="text-sm font-medium">
                  Max retries
                  <Input type="number" min={0} className="mt-1" value={retries} onChange={(event) => setRetries(Number(event.target.value))} />
                </label>
              </div>
            </div>
            <label className="mt-4 flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={unattended} onChange={(event) => setUnattended(event.target.checked)} />
              <span>
                I explicitly authorize unattended execution under this policy.
                <span className="mt-0.5 block text-xs text-muted-foreground">ACP permissions are mediation, not a sandbox. Use an external sandbox before selecting unattended allow-all.</span>
              </span>
            </label>
          </section>

          <section className="rounded-xl border border-border bg-panel p-5" aria-labelledby="wf-verify">
            <h2 id="wf-verify" className="text-sm font-semibold">Deterministic verification</h2>
            <p className="mt-1 text-xs text-muted-foreground">One command per line. The command result is the pass/fail gate — agent commentary is evidence, not the verdict.</p>
            <Textarea className="mt-3 font-mono text-xs" rows={4} placeholder={"pnpm run check\npnpm run test"} value={commands} onChange={(event) => setCommands(event.target.value)} />
          </section>

          <div className="flex items-center gap-2">
            <Button onClick={() => void save()} disabled={!repositoryId || saving}>
              <Save aria-hidden />
              {saving ? "Saving…" : selected ? "Save profile" : "Create profile"}
            </Button>
            {selected && (
              <Button variant="ghost" className="ml-auto text-muted-foreground hover:text-error" onClick={() => void removeProfile()} disabled={remove.isPending}>
                <Trash2 aria-hidden />
                Delete profile
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function policyLabel(policy: PermissionPolicy): string {
  switch (policy) {
    case "reject_all": return "reject all";
    case "allow_reads_ask_writes": return "reads allowed, asks for writes";
    case "allow_workspace": return "workspace allowed";
    case "unattended_allow_all": return "unattended allow-all";
  }
}

function blank(): { agent_id: string; agent_version: string; model: string; mode: string } {
  return { agent_id: "", agent_version: "", model: "", mode: "" };
}
