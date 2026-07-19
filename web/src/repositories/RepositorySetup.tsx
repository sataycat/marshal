import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export function RepositorySetup(): JSX.Element {
  return <main className="flex min-h-svh items-center justify-center bg-bg px-4 text-text"><section className="w-full max-w-xl rounded-xl border border-border bg-panel p-8 shadow-sm"><p className="text-xs font-semibold uppercase tracking-widest text-primary">First launch</p><h1 className="mt-2 text-3xl font-semibold">Connect an ACP server</h1><p className="mt-3 text-base leading-7 text-muted">Marshal needs at least one installed and ready ACP server before you can start a project conversation.</p><Link href="/agents" className="mt-7 inline-block"><Button>Browse ACP servers</Button></Link></section></main>;
}
