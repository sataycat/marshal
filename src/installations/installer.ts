import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { GLOBAL_DIR } from "../daemon/config.js";
import { getRegistryCatalog } from "../registry/store.js";
import type { RegistryAgent } from "../registry/types.js";
import type { RegistryDistribution } from "../registry/types.js";
import { createInstallation, finishInstallation, getInstalledAgent, getInstallationOperation, getLatestInstallationOperation } from "../agents/store.js";
import type { AgentLaunchSpec, InstallationOperation } from "../agents/types.js";

export const INSTALL_TIMEOUT_MS = 120_000;

export interface InstallCandidate {
  agent_id: string;
  version: string;
  source: "registry";
  license: string;
  distribution: RegistryDistribution;
  checksum: string | null;
  integrity_policy: "verified_if_declared" | "unverified_binary_allowed" | "not_applicable";
  installation_risk: "low" | "medium" | "high";
}

export function selectDistribution(agent: RegistryAgent, platform = `${process.platform}-${process.arch}`, preferred?: RegistryDistribution["kind"]): RegistryDistribution {
  if (preferred) {
    const selected = agent.distributions.find((entry) => entry.kind === preferred && (entry.kind !== "binary" || entry.platforms?.includes(platform)));
    if (!selected) throw new Error(`agent does not provide a ${preferred} distribution for ${platform}`);
    return selected;
  }
  const binary = agent.distributions.find((entry) => entry.kind === "binary" && entry.platforms?.includes(platform));
  return binary ?? agent.distributions.find((entry) => entry.kind === "npx") ?? agent.distributions.find((entry) => entry.kind === "uvx") ?? (() => { throw new Error(`agent does not provide a supported distribution for ${platform}`); })();
}

export function installCandidate(agent: RegistryAgent, platform = `${process.platform}-${process.arch}`): InstallCandidate {
  const distribution = selectDistribution(agent, platform);
  const binary = distribution.kind === "binary";
  return { agent_id: agent.id, version: agent.version, source: "registry", license: agent.license, distribution, checksum: distribution.checksum ?? null, integrity_policy: binary ? (distribution.checksum ? "verified_if_declared" : "unverified_binary_allowed") : "not_applicable", installation_risk: binary ? (distribution.checksum ? "medium" : "high") : "medium" };
}

export function exactNpxPackage(value: string): string {
  const packageSpec = value.trim();
  if (!packageSpec || packageSpec === "latest" || /\s/.test(packageSpec) || !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[^@\s]+$/i.test(packageSpec)) throw new Error("npx distribution must use an exact package version");
  const version = packageSpec.slice(packageSpec.lastIndexOf("@") + 1);
  if (/^(latest|next|beta|alpha|canary|dev)$/i.test(version) || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("npx distribution must use an exact semver version");
  return packageSpec;
}

export function exactUvxPackage(value: string): string {
  const packageSpec = value.trim();
  if (!packageSpec || /\s/.test(packageSpec) || !/^[A-Za-z0-9][A-Za-z0-9._-]*==[^=\s]+$/.test(packageSpec)) throw new Error("uvx distribution must use an exact package version");
  const version = packageSpec.slice(packageSpec.indexOf("==") + 2);
  if (/^(latest|stable|main|master|dev|nightly|alpha|beta|rc)$/i.test(version) || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error("uvx distribution must use an exact package version");
  return packageSpec;
}

export interface NpxRunner { (packageSpecifier: string, cwd: string): Promise<void>; }

export function runNpx(packageSpecifier: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["--yes", "--package", packageSpecifier, "node", "-e", ""], { cwd, stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("npx installation timed out")); }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error(stderr.trim() || `npx exited with code ${code ?? "unknown"}`)); });
  });
}

export interface UvxRunner { (packageSpecifier: string, cwd: string): Promise<void>; }

export function runUvx(packageSpecifier: string, cwd: string): Promise<void> {
  const command = packageSpecifier.slice(0, packageSpecifier.indexOf("=="));
  return new Promise((resolvePromise, reject) => {
    const child = spawn("uvx", ["--from", packageSpecifier, command, "--help"], { cwd, stdio: ["ignore", "ignore", "pipe"], shell: false });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("uvx installation timed out")); }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (code === 0) resolvePromise(); else reject(new Error(stderr.trim() || `uvx exited with code ${code ?? "unknown"}`)); });
  });
}

export async function startInstallation(agent: RegistryAgent, machineDir = GLOBAL_DIR, runner?: NpxRunner | UvxRunner, preferred?: RegistryDistribution["kind"]): Promise<InstallationOperation> {
  const distribution = selectDistribution(agent, `${process.platform}-${process.arch}`, preferred);
  if (distribution.kind !== "npx" && distribution.kind !== "uvx") throw new Error("binary installation is not implemented in this slice");
  if (!distribution.package) throw new Error(`agent does not provide a ${distribution.kind} distribution`);
  const packageSpecifier = distribution.kind === "npx" ? exactNpxPackage(distribution.package) : exactUvxPackage(distribution.package);
  const installRunner = runner ?? (distribution.kind === "npx" ? runNpx : runUvx);
  const existing = getInstalledAgent(agent.id, agent.version, machineDir);
  if (existing?.status === "installed") return getLatestInstallationOperation(agent.id, agent.version, machineDir)!;
  const running = getLatestInstallationOperation(agent.id, agent.version, machineDir);
  if (running?.status === "installing") return running;
  const operationId = randomUUID();
  const installationRoot = resolve(machineDir, "agents", agent.id, agent.version);
  const installationId = `${agent.id}@${agent.version}`;
  const launch = distribution.kind === "npx" ? { command: "npx", args: ["--yes", packageSpecifier, ...(distribution.args ?? [])] } : { command: "uvx", args: ["--from", packageSpecifier, packageSpecifier.slice(0, packageSpecifier.indexOf("==")), ...(distribution.args ?? [])] };
  const provenance = { exact_version: agent.version, distribution: distribution.kind, source: "registry" as const, package_specifier: packageSpecifier, archive_identity: null, registry_snapshot_fetched_at: getRegistryCatalog(machineDir).snapshot?.fetched_at ?? "unknown", installation_root: installationRoot, integrity_status: "not_applicable" as const };
  const operation = createInstallation({ id: agent.id, version: agent.version, source: "registry", license: agent.license, distribution: distribution.kind, package_specifier: packageSpecifier, launch: launch satisfies AgentLaunchSpec, provenance, installation_id: installationId, installation_root: installationRoot, registry_snapshot_fetched_at: provenance.registry_snapshot_fetched_at, integrity_status: provenance.integrity_status, status: "installing", readiness_status: "unknown", readiness_error: null, protocol_version: null, capabilities: null, auth_methods: [], raw_initialize: null, probed_at: null }, operationId, machineDir);
  void (async () => {
    const installRoot = installationRoot;
    try {
      mkdirSync(installRoot, { recursive: true });
      await installRunner(packageSpecifier, installRoot);
      writeFileSync(resolve(installRoot, "manifest.json"), JSON.stringify({ agent_id: agent.id, version: agent.version, package_specifier: packageSpecifier, installed_at: new Date().toISOString() }) + "\n", { encoding: "utf8" });
      finishInstallation(operationId, "installed", null, machineDir);
    } catch (error) {
      finishInstallation(operationId, "failed", error instanceof Error ? error.message : String(error), machineDir);
    }
  })();
  return operation;
}

export function installationOperation(id: string, machineDir = GLOBAL_DIR): InstallationOperation {
  const operation = getInstallationOperation(id, machineDir);
  if (!operation) throw new Error("installation operation not found");
  return operation;
}
