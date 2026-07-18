import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Repository } from "../types";
import { queryKeys } from "../api/queryKeys";
import { useRegisterRepositoryMutation, useSelectRepositoryMutation } from "../api/queries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function RepositorySetup({ repositories }: { repositories: Repository[] }): JSX.Element {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const register = useRegisterRepositoryMutation();
  const select = useSelectRepositoryMutation();
  const choose = async (id: string): Promise<void> => { try { await select.mutateAsync(id); await client.invalidateQueries({ queryKey: queryKeys.repositories }); } catch (e) { setError(e instanceof Error ? e.message : "Unable to select repository"); } };
  const add = async (): Promise<void> => { setError(null); try { const repo = await register.mutateAsync(path); await choose(repo.id); } catch (e) { setError(e instanceof Error ? e.message : "Unable to register repository"); } };
  return <main className="flex min-h-svh items-center justify-center bg-bg px-4 text-text"><section className="w-full max-w-xl rounded-xl border border-border bg-panel p-6 shadow-sm"><p className="text-xs font-semibold uppercase tracking-widest text-primary">First launch</p><h1 className="mt-2 text-2xl font-semibold">Choose a repository</h1><p className="mt-2 text-sm text-muted">Marshal keeps repository registrations and selection on this machine. Existing `.marshal/state.db` data is preserved in place.</p><div className="mt-6 flex gap-2"><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/path/to/git/repository" onKeyDown={(e) => { if (e.key === "Enter") void add(); }} /><Button onClick={() => void add()} disabled={!path.trim() || register.isPending}>Add repository</Button></div>{error && <p className="mt-3 text-sm text-danger">{error}</p>}{repositories.length > 0 && <div className="mt-6 space-y-2"><p className="text-sm font-medium">Registered repositories</p>{repositories.map((repo) => <button key={repo.id} type="button" onClick={() => void choose(repo.id)} className="block w-full rounded-lg border border-border px-3 py-2 text-left hover:bg-secondary"><span className="block font-medium">{repo.name}</span><span className="block truncate text-xs text-muted">{repo.path}</span></button>)}</div>}</section></main>;
}
