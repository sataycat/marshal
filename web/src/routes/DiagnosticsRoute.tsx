import { Activity, AlertTriangle, CheckCircle2, Database, FolderGit2, XCircle } from "lucide-react";
import { useState } from "react";
import { useDiagnosticsQuery, useReconnectRepositoryMutation, useRemoveRepositoryMutation } from "../api/queries";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/badge";

export function DiagnosticsRoute({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const query = useDiagnosticsQuery();
  const reconnect = useReconnectRepositoryMutation();
  const remove = useRemoveRepositoryMutation();
  const [paths, setPaths] = useState<Record<string, string>>({});
  if (query.isPending) return <div className="text-sm text-muted-foreground">Loading diagnostics…</div>;
  if (query.isError) return <div className="text-sm text-error">Diagnostics unavailable: {query.error.message}</div>;
  const data = query.data;
  const content = (
    <section aria-labelledby={embedded ? "diagnostics-heading" : undefined}>
      {embedded ? (
        <div>
          <p className="eyebrow">System</p>
          <h2 id="diagnostics-heading" className="mt-1.5 text-lg font-semibold tracking-[-0.015em]">Diagnostics</h2>
          <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">Daemon, repository, and registry health with stable machine codes and next actions.</p>
        </div>
      ) : <PageHeader
        eyebrow="System"
        title="Diagnostics"
        description="Daemon, repository, and registry health with stable machine codes and next actions."
      />}
      <div className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatusCard
          icon={Activity}
          title="Daemon"
          value={data.daemon.status === "ok" ? "Online" : data.daemon.status}
          detail={`v${data.daemon.version}${data.daemon.host ? ` · ${data.daemon.host}` : ""}`}
          ok={data.daemon.status === "ok"}
        />
        <StatusCard
          icon={FolderGit2}
          title="Repository"
          value={data.repository.selected?.name ?? "Not selected"}
          detail={data.repository.selected?.path ?? `${data.repository.registered_count} registered`}
          ok={data.repository.selected !== null}
        />
        <StatusCard
          icon={Database}
          title="Registry"
          value={data.registry.snapshot ? "Snapshot cached" : "No snapshot"}
          detail={data.registry.snapshot ? `Fetched ${new Date(data.registry.snapshot.fetched_at).toLocaleString()}` : "Refresh from the Agents page"}
          ok={data.registry.snapshot !== null}
        />
      </div>
      <h2 className="mt-8 text-sm font-semibold">Issues</h2>
      {data.issues.length === 0 ? (
        <div className="mt-3 flex items-center gap-2.5 rounded-xl border border-success-border bg-success-bg px-4 py-3 text-sm text-success">
          <CheckCircle2 aria-hidden className="size-4 shrink-0" />
          No known diagnostics require attention.
        </div>
      ) : (
        <div className="mt-3 space-y-2.5">
          {data.issues.map((issue) => (
            <article key={`${issue.code}:${issue.message}`} className="flex gap-3 rounded-xl border border-border bg-panel p-4">
              {issue.severity === "error"
                ? <XCircle aria-hidden className="mt-0.5 size-4.5 shrink-0 text-error" />
                : <AlertTriangle aria-hidden className="mt-0.5 size-4.5 shrink-0 text-warn" />}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[0.6875rem] font-medium">{issue.code}</code>
                  <Badge tone={issue.severity === "error" ? "error" : "warn"}>{issue.severity}</Badge>
                </div>
                <p className="mt-1.5 text-sm">{issue.message}</p>
                <p className="mt-1 text-sm text-muted-foreground">Next action: {issue.action}</p>
              </div>
            </article>
          ))}
        </div>
      )}
      {data.repository.repositories.some((repository) => repository.checkout_status !== "available") && (
        <section className="mt-8" aria-labelledby="repository-recovery-heading">
          <h2 id="repository-recovery-heading" className="text-sm font-semibold">Repository recovery</h2>
          <p className="mt-1 text-sm text-muted-foreground">History and daemon-owned files remain available by repository ID. Reconnect a moved checkout to resume source-dependent actions.</p>
          <div className="mt-3 space-y-2.5">
            {data.repository.repositories.filter((repository) => repository.checkout_status !== "available").map((repository) => (
              <div key={repository.id} className="rounded-xl border border-border bg-panel p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{repository.name}</p>
                  <Badge tone={repository.checkout_status === "unregistered" ? "warn" : "error"}>{repository.checkout_status}</Badge>
                </div>
                <p className="mt-1 font-mono text-xs text-muted-foreground">Retained ID: {repository.id}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <input
                    className="min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs"
                    aria-label={`Checkout path for ${repository.name}`}
                    placeholder="/path/to/checkout"
                    value={paths[repository.id] ?? ""}
                    onChange={(event) => setPaths((current) => ({ ...current, [repository.id]: event.target.value }))}
                  />
                  <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
                    disabled={!paths[repository.id]?.trim() || reconnect.isPending}
                    onClick={() => void reconnect.mutateAsync({ id: repository.id, path: paths[repository.id].trim() })}
                  >Reconnect checkout</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
      {data.repository.repositories.some((repository) => repository.registration_status === "registered") && (
        <section className="mt-8" aria-labelledby="repository-management-heading">
          <h2 id="repository-management-heading" className="text-sm font-semibold">Registered repositories</h2>
          <p className="mt-1 text-sm text-muted-foreground">Unregistering removes only the checkout from active selection. Threads, runs, and daemon-owned files remain retained by repository ID.</p>
          <div className="mt-3 space-y-2.5">
            {data.repository.repositories.filter((repository) => repository.registration_status === "registered").map((repository) => (
              <div key={repository.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-panel p-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{repository.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">{repository.path}</p>
                </div>
                <button
                  type="button"
                  className="rounded-md border border-error-border px-3 py-1.5 text-xs font-medium text-error hover:bg-error-bg disabled:opacity-50"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm(`Unregister ${repository.name}? History and daemon-owned files will be retained.`)) void remove.mutateAsync(repository.id);
                  }}
                >Unregister checkout</button>
              </div>
            ))}
          </div>
        </section>
      )}
    </section>
  );
  if (embedded) return content;
  return <div className="mx-auto w-full max-w-5xl overflow-y-auto px-4 py-6 md:px-8">{content}</div>;
}

function StatusCard({ icon: Icon, title, value, detail, ok }: { icon: typeof Activity; title: string; value: string; detail: string; ok: boolean }): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-panel p-4">
      <div className="flex items-center gap-2">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</p>
        <span className={ok ? "ml-auto size-1.5 rounded-full bg-success" : "ml-auto size-1.5 rounded-full bg-warn"} aria-hidden />
      </div>
      <p className="mt-2.5 text-sm font-semibold">{value}</p>
      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={detail}>{detail}</p>
    </div>
  );
}
