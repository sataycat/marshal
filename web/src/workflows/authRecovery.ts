export function workflowAuthRecoveryAvailable(run: { status: string; auth_recovery_resolved_at?: string | null }): boolean { return run.status === "authentication_required" && !run.auth_recovery_resolved_at; }
export function workflowAuthRecoveryCopy(role: string): string { return `Authorize a new ${role} attempt after signing in. This does not replay or start work automatically.`; }
