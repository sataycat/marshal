import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openMachineDb } from "../storage/machine.js";
import { bindAgentCredential, getAgentCredentialBindings } from "./credentials.js";
import { resolveAgentLaunchEnvironment } from "./launch-environment.js";

describe("installed agent launch environment", () => {
  it("combines host, pinned, credentials, and additional auth env with explicit precedence", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-launch-env-"));
    bindAgentCredential("install-a", "TOKEN", "credential-value", true, machineDir);
    const installation = { installation_id: "install-a", launch: { command: "agent", args: [], env: { TOKEN: "pinned-value", PINNED: "yes" } } };
    expect(resolveAgentLaunchEnvironment(installation, machineDir, { hostEnv: { TOKEN: "host-value", HOST: "yes" }, additionalEnv: { TOKEN: "terminal-value", EXTRA: "yes" } })).toEqual({
      HOST: "yes", PINNED: "yes", TOKEN: "terminal-value", EXTRA: "yes",
    });
  });

  it("scopes bindings to the exact installation and stores only external references in SQLite", () => {
    const machineDir = mkdtempSync(join(tmpdir(), "marshal-credential-store-"));
    const secret = "super-secret-fixture-value";
    bindAgentCredential("install-a", "API_KEY", secret, true, machineDir);
    expect(resolveAgentLaunchEnvironment({ installation_id: "install-a", launch: { command: "agent", args: [] } }, machineDir, { hostEnv: {} })).toEqual({ API_KEY: secret });
    expect(resolveAgentLaunchEnvironment({ installation_id: "install-b", launch: { command: "agent", args: [] } }, machineDir, { hostEnv: {} })).toEqual({});
    const binding = getAgentCredentialBindings("install-a", machineDir)[0];
    expect(binding.credential_ref).toMatch(/^file:/);
    expect(JSON.stringify(binding)).not.toContain(secret);
    const rows = openMachineDb(machineDir).prepare("SELECT * FROM agent_credential_bindings").all();
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(readFileSync(join(machineDir, "machine.db"))).not.toContain(Buffer.from(secret));
  });
});
