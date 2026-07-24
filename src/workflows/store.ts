import { randomUUID } from "node:crypto";
import { openMachineDb } from "../storage/machine.js";
import { getInstalledAgent } from "../agents/store.js";
import type { AgentCapabilities } from "../agents/types.js";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";
import { historicalProvenance } from "../agents/provenance.js";
import type {
  AgentAssignment,
  PermissionPolicy,
  WorkflowProfile,
  WorkflowRole,
  WorkflowValidationIssue,
} from "./types.js";

const ROLES: WorkflowRole[] = ["specAuthor", "builder", "validator"];
const POLICIES: PermissionPolicy[] = [
  "reject_all",
  "allow_reads_ask_writes",
  "allow_workspace",
  "unattended_allow_all",
];

function db(machineDir?: string) {
  return openMachineDb(machineDir);
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}
function assignment(row: Record<string, unknown>): AgentAssignment {
  return {
    id: String(row.id),
    profile_id: String(row.profile_id),
    role: String(row.role) as WorkflowRole,
    agent_id: String(row.agent_id),
    agent_version: String(row.agent_version),
    model: row.model == null ? null : String(row.model),
    mode: row.mode == null ? null : String(row.mode),
    agent_provenance: parseJson<HistoricalAgentProvenance>(
      row.agent_provenance,
      historicalProvenance(String(row.agent_id), String(row.agent_version)),
    ),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
function profile(row: Record<string, unknown>, assignments: AgentAssignment[]): WorkflowProfile {
  return {
    id: String(row.id),
    repository_id: String(row.repository_id),
    name: String(row.name),
    permission_policy: String(row.permission_policy) as PermissionPolicy,
    unattended_authorized: Number(row.unattended_authorized) === 1,
    timeout_ms: Number(row.timeout_ms),
    max_retries: Number(row.max_retries),
    verification_commands: parseJson(row.verification_commands, []),
    require_decorrelated_builder_validator:
      Number(row.require_decorrelated_builder_validator) === 1,
    assignments,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export interface WorkflowProfileInput {
  name: string;
  permission_policy: PermissionPolicy;
  unattended_authorized: boolean;
  timeout_ms: number;
  max_retries: number;
  verification_commands: string[];
  require_decorrelated_builder_validator: boolean;
  assignments: Array<{
    role: WorkflowRole;
    agent_id: string;
    agent_version: string;
    model?: string | null;
    mode?: string | null;
  }>;
}

export function validateWorkflowProfile(
  repositoryId: string,
  input: WorkflowProfileInput,
  machineDir?: string,
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  if (!input.name.trim())
    issues.push({ field: "name", code: "required", message: "Profile name is required" });
  if (!POLICIES.includes(input.permission_policy))
    issues.push({
      field: "permission_policy",
      code: "invalid",
      message: "Unknown permission policy",
    });
  if (input.unattended_authorized && input.permission_policy !== "unattended_allow_all")
    issues.push({
      field: "unattended_authorized",
      code: "policy_required",
      message: "Unattended authorization requires the unattended allow-all policy",
    });
  if (
    !Number.isInteger(input.timeout_ms) ||
    input.timeout_ms < 1000 ||
    input.timeout_ms > 86_400_000
  )
    issues.push({
      field: "timeout_ms",
      code: "range",
      message: "Timeout must be between 1 second and 24 hours",
    });
  if (!Number.isInteger(input.max_retries) || input.max_retries < 0 || input.max_retries > 20)
    issues.push({
      field: "max_retries",
      code: "range",
      message: "Retries must be between 0 and 20",
    });
  if (
    !Array.isArray(input.verification_commands) ||
    input.verification_commands.some(
      (command) => typeof command !== "string" || !command.trim() || command.length > 2000,
    )
  )
    issues.push({
      field: "verification_commands",
      code: "invalid",
      message: "Verification commands must be non-empty strings no longer than 2000 characters",
    });
  const seen = new Set<string>();
  for (const item of input.assignments ?? []) {
    if (!ROLES.includes(item.role)) {
      issues.push({
        field: "assignments",
        code: "invalid_role",
        message: `Unknown workflow role: ${item.role}`,
      });
      continue;
    }
    if (seen.has(item.role))
      issues.push({
        field: `assignments.${item.role}`,
        code: "duplicate",
        message: "Each workflow role can only be assigned once",
      });
    seen.add(item.role);
    const agent = getInstalledAgent(item.agent_id, item.agent_version, machineDir);
    if (!agent || agent.status !== "installed") {
      issues.push({
        field: `assignments.${item.role}`,
        code: "agent_not_installed",
        message: `${item.agent_id}@${item.agent_version} is not installed`,
      });
      continue;
    }
    if (agent.readiness_status !== "ready") {
      issues.push({
        field: `assignments.${item.role}`,
        code: "agent_not_ready",
        message: `${item.agent_id}@${item.agent_version} is not ready; complete its readiness check before assigning it`,
      });
      continue;
    }
    const capabilities = agent.capabilities as AgentCapabilities | null;
    if (!capabilities?.prompt.text)
      issues.push({
        field: `assignments.${item.role}`,
        code: "text_unsupported",
        message: `${item.agent_id}@${item.agent_version} does not advertise text prompts`,
      });
    const advertised = (agent.raw_initialize as Record<string, unknown> | null)?.configOptions as
      | Record<string, unknown>
      | undefined;
    const models = Array.isArray(advertised?.models)
      ? advertised.models.filter((value): value is string => typeof value === "string")
      : [];
    const modes = Array.isArray(advertised?.modes)
      ? advertised.modes.filter((value): value is string => typeof value === "string")
      : [];
    if (item.model && models.length > 0 && !models.includes(item.model))
      issues.push({
        field: `assignments.${item.role}.model`,
        code: "unsupported",
        message: `Model ${item.model} was not negotiated by ${item.agent_id}`,
      });
    if (item.mode && modes.length > 0 && !modes.includes(item.mode))
      issues.push({
        field: `assignments.${item.role}.mode`,
        code: "unsupported",
        message: `Mode ${item.mode} was not negotiated by ${item.agent_id}`,
      });
  }
  if (input.require_decorrelated_builder_validator) {
    const builder = input.assignments.find((item) => item.role === "builder");
    const validator = input.assignments.find((item) => item.role === "validator");
    if (
      builder &&
      validator &&
      builder.agent_id === validator.agent_id &&
      builder.agent_version === validator.agent_version &&
      (builder.model ?? null) === (validator.model ?? null) &&
      (builder.mode ?? null) === (validator.mode ?? null)
    )
      issues.push({
        field: "assignments.validator",
        code: "not_decorrelated",
        message: "Builder and validator must use different agent, version, model, or mode",
      });
  }
  if (!repositoryId)
    issues.push({ field: "repository_id", code: "required", message: "Repository is required" });
  return issues;
}

export function listWorkflowProfiles(repositoryId: string, machineDir?: string): WorkflowProfile[] {
  const database = db(machineDir);
  const rows = database
    .prepare("SELECT * FROM workflow_profiles WHERE repository_id = ? ORDER BY name COLLATE NOCASE")
    .all(repositoryId) as Record<string, unknown>[];
  return rows.map((row) => profile(row, listAssignments(repositoryId, String(row.id), machineDir)));
}
export function getWorkflowProfile(
  repositoryId: string,
  id: string,
  machineDir?: string,
): WorkflowProfile | undefined {
  const database = db(machineDir);
  const row = database
    .prepare("SELECT * FROM workflow_profiles WHERE repository_id = ? AND id = ?")
    .get(repositoryId, id) as Record<string, unknown> | undefined;
  return row ? profile(row, listAssignments(repositoryId, id, machineDir)) : undefined;
}
function listAssignments(repositoryId: string, profileId: string, machineDir?: string): AgentAssignment[] {
  return (
    db(machineDir)
      .prepare("SELECT a.* FROM agent_assignments a JOIN workflow_profiles p ON p.repository_id = a.repository_id AND p.id = a.profile_id WHERE a.repository_id = ? AND a.profile_id = ? ORDER BY a.role")
      .all(repositoryId, profileId) as Record<string, unknown>[]
  ).map(assignment);
}
export function saveWorkflowProfile(
  repositoryId: string,
  input: WorkflowProfileInput,
  id: string = randomUUID(),
  machineDir?: string,
): WorkflowProfile {
  const issues = validateWorkflowProfile(repositoryId, input, machineDir);
  if (issues.length) throw new WorkflowValidationError(issues);
  const database = db(machineDir);
  const now = new Date().toISOString();
  database.transaction(() => {
    database
      .prepare(
        "INSERT INTO workflow_profiles (id, repository_id, name, permission_policy, unattended_authorized, timeout_ms, max_retries, verification_commands, require_decorrelated_builder_validator, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(repository_id, id) DO UPDATE SET name=excluded.name, permission_policy=excluded.permission_policy, unattended_authorized=excluded.unattended_authorized, timeout_ms=excluded.timeout_ms, max_retries=excluded.max_retries, verification_commands=excluded.verification_commands, require_decorrelated_builder_validator=excluded.require_decorrelated_builder_validator, updated_at=excluded.updated_at",
      )
      .run(
        id,
        repositoryId,
        input.name.trim(),
        input.permission_policy,
        input.unattended_authorized ? 1 : 0,
        input.timeout_ms,
        input.max_retries,
        JSON.stringify(input.verification_commands),
        input.require_decorrelated_builder_validator ? 1 : 0,
        now,
        now,
      );
    database.prepare("DELETE FROM agent_assignments WHERE repository_id = ? AND profile_id = ?").run(repositoryId, id);
    for (const item of input.assignments) {
      const installed = getInstalledAgent(item.agent_id, item.agent_version, machineDir);
      database
        .prepare(
          "INSERT INTO agent_assignments (id, repository_id, profile_id, role, agent_id, agent_version, model, mode, agent_provenance, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
           randomUUID(),
           repositoryId,
           id,
          item.role,
          item.agent_id,
          item.agent_version,
          item.model ?? null,
          item.mode ?? null,
          JSON.stringify(
            historicalProvenance(
              item.agent_id,
              item.agent_version,
              installed?.provenance,
              installed?.installation_id,
            ),
          ),
          now,
          now,
        );
    }
  })();
  return getWorkflowProfile(repositoryId, id, machineDir)!;
}
export function deleteWorkflowProfile(
  repositoryId: string,
  id: string,
  machineDir?: string,
): boolean {
  const database = db(machineDir);
  return database.transaction(() => {
    const result = database
      .prepare("DELETE FROM workflow_profiles WHERE repository_id = ? AND id = ?")
      .run(repositoryId, id);
    database.prepare("DELETE FROM agent_assignments WHERE repository_id = ? AND profile_id = ?").run(repositoryId, id);
    return result.changes > 0;
  })();
}
export class WorkflowValidationError extends Error {
  constructor(public readonly issues: WorkflowValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "WorkflowValidationError";
  }
}
