import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { registerRepository } from "../repositories/store.js";
import { createInstallation, finishInstallation, setAgentReadiness } from "../agents/store.js";
import { deleteWorkflowProfile, listWorkflowProfiles, saveWorkflowProfile, validateWorkflowProfile, type WorkflowProfileInput } from "./store.js";

function input(agent = "agent-a"): WorkflowProfileInput { return { name: "Default", permission_policy: "allow_reads_ask_writes", unattended_authorized: false, timeout_ms: 30_000, max_retries: 2, verification_commands: ["pnpm test"], require_decorrelated_builder_validator: true, assignments: [{ role: "builder", agent_id: agent, agent_version: "1.0.0" }, { role: "validator", agent_id: agent, agent_version: "1.0.0", mode: "review" }] }; }

describe("workflow profiles", () => {
  it("persists repository-scoped assignments without launch details", () => {
    const dir = mkdtempSync(`${tmpdir()}/marshal-workflows-`); const repository = registerRepository(process.cwd(), dir);
    createInstallation({ id: "agent-a", version: "1.0.0", source: "registry", license: "MIT", distribution: "npx", package_specifier: "agent-a@1.0.0", launch: { command: "npx", args: ["agent-a@1.0.0"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "install", dir);
    finishInstallation("install", "installed", null, dir); setAgentReadiness("agent-a", "1.0.0", { readiness_status: "ready", readiness_error: null, protocol_version: 1, capabilities: { prompt: { text: true, image: false, audio: false, embedded_context: false }, session: { close: true, list: false, load: false, fork: false, resume: false }, load_session: false, auth: { logout: false } }, auth_methods: [], raw_initialize: {}, probed_at: new Date().toISOString() }, dir);
    const saved = saveWorkflowProfile(repository.id, input(), undefined, dir); expect(listWorkflowProfiles(repository.id, dir)[0]).toMatchObject({ repository_id: repository.id, name: "Default" }); expect(saved.assignments[0]).not.toHaveProperty("launch"); expect(deleteWorkflowProfile(repository.id, saved.id, dir)).toBe(true);
  });
  it("selects a ready uvx installation for workflow assignments", () => {
    const dir = mkdtempSync(`${tmpdir()}/marshal-workflows-uvx-`); const repository = registerRepository(process.cwd(), dir);
    createInstallation({ id: "uv-agent", version: "1.2.3", source: "registry", license: "MIT", distribution: "uvx", package_specifier: "uv-agent==1.2.3", launch: { command: "uvx", args: ["--from", "uv-agent==1.2.3", "uv-agent", "acp"] }, registry_snapshot_fetched_at: "fixture", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, "uv-install", dir);
    finishInstallation("uv-install", "installed", null, dir); setAgentReadiness("uv-agent", "1.2.3", { readiness_status: "ready", readiness_error: null, protocol_version: 1, capabilities: { prompt: { text: true, image: false, audio: false, embedded_context: false }, session: { close: true, list: false, load: false, fork: false, resume: false }, load_session: false, auth: { logout: false } }, auth_methods: [], raw_initialize: {}, probed_at: new Date().toISOString() }, dir);
    const saved = saveWorkflowProfile(repository.id, { ...input("uv-agent"), assignments: [{ role: "builder", agent_id: "uv-agent", agent_version: "1.2.3" }] }, undefined, dir);
    expect(saved.assignments).toEqual([expect.objectContaining({ role: "builder", agent_id: "uv-agent", agent_version: "1.2.3" })]);
  });
  it("rejects unready agents and identical decorrelated assignments", () => {
    const dir = mkdtempSync(`${tmpdir()}/marshal-workflows-`); const issues = validateWorkflowProfile("repo", { ...input(), require_decorrelated_builder_validator: true, assignments: [{ role: "builder", agent_id: "missing", agent_version: "1" }, { role: "validator", agent_id: "missing", agent_version: "1" }] }, dir); expect(issues.map((issue) => issue.code)).toContain("agent_not_installed");
  });
});
