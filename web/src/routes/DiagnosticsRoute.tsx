import { Activity, AlertTriangle, CheckCircle2, Database, FolderGit2, XCircle } from "lucide-react";
import { useDiagnosticsQuery } from "../api/queries";
import { PageHeader } from "../components/PageHeader";
import { Badge } from "../components/ui/badge";

export function DiagnosticsRoute({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const query = useDiagnosticsQuery();
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
