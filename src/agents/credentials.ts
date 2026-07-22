import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { GLOBAL_DIR } from "../daemon/config.js";
import { openMachineDb } from "../storage/machine.js";

export interface CredentialBinding {
  installation_id: string;
  variable_name: string;
  credential_ref: string;
  secret: boolean;
  created_at: string;
  updated_at: string;
}

export interface CredentialStore {
  put(value: string, existingRef?: string): string;
  get(reference: string): string;
  delete?(reference: string): void;
}

export class ExternalFileCredentialStore implements CredentialStore {
  private readonly directory: string;

  constructor(machineDir = GLOBAL_DIR) {
    this.directory = resolve(machineDir, "credentials");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  put(value: string, existingRef?: string): string {
    const reference = existingRef ?? `file:${randomUUID()}`;
    const id = reference.startsWith("file:") ? reference.slice(5) : "";
    if (!/^[a-f0-9-]+$/i.test(id)) throw new Error("Credential reference is invalid");
    writeFileSync(resolve(this.directory, id), value, { encoding: "utf8", mode: 0o600, flag: "w" });
    return reference;
  }

  get(reference: string): string {
    const id = reference.startsWith("file:") ? reference.slice(5) : "";
    if (!/^[a-f0-9-]+$/i.test(id)) throw new Error("Credential reference is invalid");
    return readFileSync(resolve(this.directory, id), "utf8");
  }

  delete(reference: string): void {
    const id = reference.startsWith("file:") ? reference.slice(5) : "";
    if (!/^[a-f0-9-]+$/i.test(id)) return;
    try { rmSync(resolve(this.directory, id), { force: true }); } catch { /* best effort cleanup */ }
  }
}

function table(machineDir?: string) {
  const db = openMachineDb(machineDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_credential_bindings (
      installation_id TEXT NOT NULL,
      variable_name TEXT NOT NULL,
      credential_ref TEXT NOT NULL,
      secret INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (installation_id, variable_name)
    )
  `);
  return db;
}

export function bindAgentCredential(
  installationId: string,
  variableName: string,
  value: string,
  secret: boolean,
  machineDir?: string,
  store: CredentialStore = new ExternalFileCredentialStore(machineDir),
): CredentialBinding {
  const db = table(machineDir);
  const existing = db.prepare("SELECT credential_ref FROM agent_credential_bindings WHERE installation_id = ? AND variable_name = ?").get(installationId, variableName) as { credential_ref: string } | undefined;
  const reference = store.put(value, existing?.credential_ref);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO agent_credential_bindings (installation_id, variable_name, credential_ref, secret, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(installation_id, variable_name) DO UPDATE SET credential_ref = excluded.credential_ref, secret = excluded.secret, updated_at = excluded.updated_at`)
    .run(installationId, variableName, reference, secret ? 1 : 0, now, now);
  return getAgentCredentialBindings(installationId, machineDir).find((binding) => binding.variable_name === variableName)!;
}

export function getAgentCredentialBindings(installationId: string, machineDir?: string): CredentialBinding[] {
  return (table(machineDir).prepare("SELECT * FROM agent_credential_bindings WHERE installation_id = ? ORDER BY variable_name").all(installationId) as Record<string, unknown>[]).map((row) => ({
    installation_id: String(row.installation_id),
    variable_name: String(row.variable_name),
    credential_ref: String(row.credential_ref),
    secret: Number(row.secret) === 1,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

export function resolveAgentCredentialValues(
  installationId: string,
  machineDir?: string,
  store: CredentialStore = new ExternalFileCredentialStore(machineDir),
): Record<string, string> {
  return Object.fromEntries(getAgentCredentialBindings(installationId, machineDir).map((binding) => [binding.variable_name, store.get(binding.credential_ref)]));
}

export function deleteAgentCredentials(
  installationId: string,
  machineDir?: string,
  store: CredentialStore = new ExternalFileCredentialStore(machineDir),
): void {
  const bindings = getAgentCredentialBindings(installationId, machineDir);
  for (const binding of bindings) store.delete?.(binding.credential_ref);
  table(machineDir).prepare("DELETE FROM agent_credential_bindings WHERE installation_id = ?").run(installationId);
}
