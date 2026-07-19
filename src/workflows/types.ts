export type WorkflowRole = "specAuthor" | "builder" | "validator";
export type PermissionPolicy = "reject_all" | "allow_reads_ask_writes" | "allow_workspace" | "unattended_allow_all";
import type { HistoricalAgentProvenance } from "../agents/provenance.js";

export interface AgentAssignment {
  id: string;
  profile_id: string;
  role: WorkflowRole;
  agent_id: string;
  agent_version: string;
  model: string | null;
  mode: string | null;
  agent_provenance: HistoricalAgentProvenance;
  created_at: string;
  updated_at: string;
}

export interface WorkflowProfile {
  id: string;
  repository_id: string;
  name: string;
  permission_policy: PermissionPolicy;
  unattended_authorized: boolean;
  timeout_ms: number;
  max_retries: number;
  verification_commands: string[];
  require_decorrelated_builder_validator: boolean;
  assignments: AgentAssignment[];
  created_at: string;
  updated_at: string;
}

export interface WorkflowValidationIssue { field: string; code: string; message: string }
