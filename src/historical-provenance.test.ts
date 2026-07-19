import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createInstallation, finishInstallation, removeInstalledAgent, setAgentReadiness } from "./agents/store.js";
import { historicalProvenance } from "./agents/provenance.js";
import { createSession, getSession } from "./acp/supervisor-store.js";
import { createChatAttachment, getChatAttachment } from "./chat/attachments.js";
import { createChatThread, getChatThread } from "./chat/store.js";
import { RunLog } from "./daemon/run-log.js";
import { createSpecAuthorSession, getSpecAuthorSession } from "./tasks/author-store.js";
import { createTask } from "./tasks/store.js";
import { registerRepository } from "./repositories/store.js";
import { saveWorkflowProfile } from "./workflows/store.js";

const provenance = historicalProvenance("demo", "1.2.3", {
  exact_version: "1.2.3", distribution: "npx", source: "registry", package_specifier: "demo@1.2.3",
  archive_identity: null, registry_snapshot_fetched_at: "snapshot-1", installation_root: "/owned/demo",
  integrity_status: "not_applicable",
}, "install-1");

function install(machineDir: string): void {
  createInstallation({ id: "demo", version: "1.2.3", source: "registry", license: "MIT", distribution: "npx", package_specifier: "demo@1.2.3", launch: { command: "npx", args: ["demo@1.2.3"] }, registry_snapshot_fetched_at: "snapshot-1", integrity_status: "not_applicable", status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null, installation_id: "install-1", provenance: { exact_version: "1.2.3", distribution: "npx", source: "registry", package_specifier: "demo@1.2.3", archive_identity: null, registry_snapshot_fetched_at: "snapshot-1", installation_root: "/owned/demo", integrity_status: "not_applicable" } }, "operation-1", machineDir);
  finishInstallation("operation-1", "installed", null, machineDir);
  setAgentReadiness("demo", "1.2.3", { readiness_status: "ready", readiness_error: null, protocol_version: 1, capabilities: { prompt: { text: true, image: false, audio: false, embedded_context: false }, session: { close: true, list: false, load: false, fork: false, resume: false }, load_session: false, auth: { logout: false } }, auth_methods: [], raw_initialize: {}, probed_at: new Date().toISOString() }, machineDir);
}

describe("historical agent provenance", () => {
  it("keeps thread, session, run, assignment, spec-author, and attachment history readable after installation removal", () => {
    const root = mkdtempSync(join(tmpdir(), "marshal-history-repo-"));
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-history-machine-"));
    install(machineDir);
    execFileSync("git", ["init", "-q", root]);

    const thread = createChatThread({ agentId: "demo", agentVersion: "1.2.3", agentProvenance: provenance }, root);
    const attachment = createChatAttachment(thread.id, { type: "image/png", name: "evidence.png", size: 8, bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) }, root);
    const session = createSession({ ownerType: "thread", ownerId: thread.id, agentId: "demo", agentVersion: "1.2.3", agentProvenance: provenance }, root);
    const task = createTask({ slug: "history-task", title: "History", specMarkdown: "spec" }, root);
    const runLog = new RunLog(root);
    const runId = runLog.startRun(task.id, "builder", "demo", "build", { agentVersion: "1.2.3", agentProvenance: provenance });
    const repository = registerRepository(root, machineDir);
    const profile = saveWorkflowProfile(repository.id, { name: "History", permission_policy: "allow_reads_ask_writes", unattended_authorized: false, timeout_ms: 1000, max_retries: 0, verification_commands: [], require_decorrelated_builder_validator: false, assignments: [{ role: "builder", agent_id: "demo", agent_version: "1.2.3" }] }, undefined, machineDir);
    const author = createSpecAuthorSession({ taskId: task.id, repositoryId: repository.id, workflowProfileId: profile.id, assignmentId: profile.assignments[0].id, agentId: "demo", agentVersion: "1.2.3", agentProvenance: provenance, assignmentConfig: {} }, root);

    expect(removeInstalledAgent("demo", "1.2.3", machineDir)).toBe(true);

    expect(getChatThread(thread.id, root).agent_provenance).toMatchObject({ installation_id: "install-1", package_specifier: "demo@1.2.3", registry_snapshot_fetched_at: "snapshot-1" });
    expect(getSession(session.id, root)?.agent_provenance).toMatchObject({ installation_id: "install-1", distribution: "npx" });
    expect(runLog.getRun(runId)?.agentProvenance).toMatchObject({ installation_id: "install-1", integrity_status: "not_applicable" });
    expect(profile.assignments[0].agent_provenance).toMatchObject({ installation_id: "install-1", package_specifier: "demo@1.2.3" });
    expect(getSpecAuthorSession(author.id, root)?.agent_provenance).toMatchObject({ installation_id: "install-1", agent_version: "1.2.3" });
    expect(getChatAttachment(thread.id, attachment.id, root)).toMatchObject({ id: attachment.id, filename: "evidence.png" });
  });
});
