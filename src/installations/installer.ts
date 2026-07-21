import {
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  chmodSync,
  renameSync,
  existsSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { resolve, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { extractArchive } from "./archive.js";
import { GLOBAL_DIR } from "../daemon/config.js";
import { getRegistryCatalog } from "../registry/store.js";
import type { RegistryAgent } from "../registry/types.js";
import type { RegistryDistribution } from "../registry/types.js";
import {
  cancelInstallation,
  createInstallation,
  finishInstallation,
  getInstalledAgent,
  getInstallationOperation,
  getLatestInstallationOperation,
  persistInstallationIntegrity,
  updateInstallationPhase,
  getInstallationByIdentity,
} from "../agents/store.js";
import type { AgentLaunchSpec, InstallationOperation } from "../agents/types.js";
import type { EventBus } from "../daemon/bus.js";
import { publishInstallationOperationUpdated } from "../daemon/bus.js";
import { activateInstalledAgent } from "../agents/activation.js";

export const INSTALL_TIMEOUT_MS = 120_000;
export const BINARY_MAX_BYTES = 256 * 1024 * 1024;
export const BINARY_MAX_REDIRECTS = 3;

function resumeActivation(operation: InstallationOperation, machineDir: string, bus?: EventBus): void {
  if (operation.status !== "installed" || !["not_started", "checking", "interrupted"].includes(operation.activation_status)) return;
  void activateInstalledAgent(operation.agent_id, operation.version, machineDir, bus, operation.id, operation.installation_id).catch(() => undefined);
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("checksum mismatch")) return "integrity_mismatch";
  if (message.includes("timed out")) return "download_timeout";
  if (message.includes("checksumless")) return "unverified_binary";
  if (message.includes("unsafe") || message.includes("escapes")) return "unsafe_archive";
  if (message.includes("exceeds")) return "installation_limit";
  return "installation_failed";
}

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

function normalizePlatform(platform: string): string {
  const [rawPlatform, rawArch] = platform.split("-");
  const normalizedPlatform = rawPlatform === "windows" ? "win32" : rawPlatform;
  const normalizedArch =
    rawArch === "aarch64" ? "arm64" : rawArch === "x86_64" ? "x64" : rawArch;
  return `${normalizedPlatform}-${normalizedArch}`;
}

function supportsPlatform(distribution: RegistryDistribution, platform: string): boolean {
  return (
    distribution.kind !== "binary" ||
    distribution.platforms?.some((candidate) => normalizePlatform(candidate) === normalizePlatform(platform)) ===
      true
  );
}

export function selectDistribution(
  agent: RegistryAgent,
  platform = `${process.platform}-${process.arch}`,
  preferred?: RegistryDistribution["kind"],
): RegistryDistribution {
  if (preferred) {
    const candidates = agent.distributions.filter(
      (entry) => entry.kind === preferred && supportsPlatform(entry, platform),
    );
    const selected =
      preferred === "binary"
        ? (candidates.find((entry) => Boolean(entry.checksum)) ?? candidates[0])
        : candidates[0];
    if (!selected)
      throw new Error(`agent does not provide a ${preferred} distribution for ${platform}`);
    return selected;
  }
  // A compatible, checksummed archive is the strongest local distribution. Do
  // not let registry ordering make an unverified binary win over a verified
  // one; checksumless binaries remain an explicit opt-in.
  const compatibleBinaries = agent.distributions.filter(
    (entry) => entry.kind === "binary" && supportsPlatform(entry, platform),
  );
  const binary =
    compatibleBinaries.find((entry) => Boolean(entry.checksum)) ?? compatibleBinaries[0];
  return (
    binary ??
    agent.distributions.find((entry) => entry.kind === "npx") ??
    agent.distributions.find((entry) => entry.kind === "uvx") ??
    (() => {
      throw new Error(`agent does not provide a supported distribution for ${platform}`);
    })()
  );
}

export function installCandidate(
  agent: RegistryAgent,
  platform = `${process.platform}-${process.arch}`,
  preferred?: RegistryDistribution["kind"],
): InstallCandidate {
  const distribution = selectDistribution(agent, platform, preferred);
  const binary = distribution.kind === "binary";
  return {
    agent_id: agent.id,
    version: agent.version,
    source: "registry",
    license: agent.license,
    distribution,
    checksum: distribution.checksum ?? null,
    integrity_policy: binary
      ? distribution.checksum
        ? "verified_if_declared"
        : "unverified_binary_allowed"
      : "not_applicable",
    installation_risk: binary ? (distribution.checksum ? "medium" : "high") : "medium",
  };
}

export function exactNpxPackage(value: string): string {
  const packageSpec = value.trim();
  if (
    !packageSpec ||
    packageSpec === "latest" ||
    /\s/.test(packageSpec) ||
    !/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+@[^@\s]+$/i.test(packageSpec)
  )
    throw new Error("npx distribution must use an exact package version");
  const version = packageSpec.slice(packageSpec.lastIndexOf("@") + 1);
  if (
    /^(latest|next|beta|alpha|canary|dev)$/i.test(version) ||
    !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  )
    throw new Error("npx distribution must use an exact semver version");
  return packageSpec;
}

export function exactUvxPackage(value: string): string {
  const packageSpec = value.trim();
  if (
    !packageSpec ||
    /\s/.test(packageSpec) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*==[^=\s]+$/.test(packageSpec)
  )
    throw new Error("uvx distribution must use an exact package version");
  const version = packageSpec.slice(packageSpec.indexOf("==") + 2);
  if (
    /^(latest|stable|main|master|dev|nightly|alpha|beta|rc)$/i.test(version) ||
    !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)
  )
    throw new Error("uvx distribution must use an exact package version");
  return packageSpec;
}

export interface NpxRunner {
  (packageSpecifier: string, cwd: string): Promise<void>;
}

export function runNpx(packageSpecifier: string, cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("npx", ["--yes", "--package", packageSpecifier, "node", "-e", ""], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("npx installation timed out"));
    }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `npx exited with code ${code ?? "unknown"}`));
    });
  });
}

export interface UvxRunner {
  (packageSpecifier: string, cwd: string): Promise<void>;
}

export interface BinaryInstallOptions {
  allowUnverified?: boolean;
  fetch?: typeof fetch;
  retry?: boolean;
}
const installationRoots = new Map<string, string>();

async function downloadBinary(
  url: string,
  fetchImpl: typeof fetch,
  redirects = 0,
): Promise<Uint8Array> {
  if (redirects > BINARY_MAX_REDIRECTS) throw new Error("binary redirect limit exceeded");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTALL_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: "manual", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("binary redirect has no location");
      return downloadBinary(new URL(location, url).toString(), fetchImpl, redirects + 1);
    }
    if (!response.ok) throw new Error(`binary download failed with HTTP ${response.status}`);
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > BINARY_MAX_BYTES) throw new Error("binary download exceeds the 256 MiB limit");
    if (!response.body) throw new Error("binary download had no body");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > BINARY_MAX_BYTES) {
        await reader.cancel();
        throw new Error("binary download exceeds the 256 MiB limit");
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw new Error("binary download timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function binaryLaunch(
  root: string,
  executable: string,
  args: string[],
  env?: Record<string, string>,
): AgentLaunchSpec {
  const command = resolve(root, executable);
  const rootPath = resolve(root);
  const relativePath = relative(rootPath, command);
  if (
    relativePath.startsWith("..") ||
    relativePath.includes("\0") ||
    resolve(command) !== command ||
    executable.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(executable)
  )
    throw new Error("binary executable escapes installation root");
  return { command, args, ...(env ? { env } : {}) };
}

export async function installBinary(
  agent: RegistryAgent,
  distribution: RegistryDistribution,
  machineDir: string,
  operationId: string,
  allowUnverified = false,
  fetchImpl: typeof fetch = fetch,
  bus?: EventBus,
): Promise<void> {
  const publish = (): void => {
    if (bus)
      publishInstallationOperationUpdated(bus, getInstallationOperation(operationId, machineDir));
  };
  const operation = getInstallationOperation(operationId, machineDir)!;
  const root = operation.published_root!;
  const temp = operation.temporary_root!;
  try {
    if (distribution.kind !== "binary") throw new Error("not a binary distribution");
    if (!distribution.archive_url || !distribution.executable)
      throw new Error("binary distribution is incomplete");
    if (!distribution.checksum && !allowUnverified)
      throw new Error("checksumless binary requires explicit confirmation");
    updateInstallationPhase(operationId, "downloading", {}, machineDir);
    publish();
    const bytes = await downloadBinary(distribution.archive_url, fetchImpl);
    const observed = digest(bytes);
    updateInstallationPhase(operationId, "verifying", {}, machineDir);
    publish();
    persistInstallationIntegrity(
      operationId,
      distribution.checksum ?? null,
      observed,
      distribution.checksum && observed !== distribution.checksum
        ? "mismatch"
        : distribution.checksum
          ? "verified"
          : "unverified",
      machineDir,
    );
    if (distribution.checksum && observed !== distribution.checksum)
      throw new Error(
        `binary checksum mismatch: expected ${distribution.checksum}, observed ${observed}`,
      );
    updateInstallationPhase(operationId, "extracting", {}, machineDir);
    publish();
    if (distribution.archive_format) {
      extractArchive(bytes, distribution.archive_format, temp);
    } else {
      const executable = resolve(temp, distribution.executable);
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, bytes);
    }
    const launch = binaryLaunch(
      temp,
      distribution.executable,
      distribution.args ?? [],
      distribution.env,
    );
    chmodSync(launch.command, 0o755);
    writeFileSync(
      resolve(temp, "manifest.json"),
      JSON.stringify({
        agent_id: agent.id,
        version: agent.version,
        installation_id: operation.installation_id,
        archive_url: distribution.archive_url,
        expected_digest: distribution.checksum ?? null,
        observed_digest: observed,
        integrity_status: distribution.checksum ? "verified" : "unverified",
        launch: {
          executable: distribution.executable,
          args: distribution.args ?? [],
          env: distribution.env ?? null,
        },
      }) + "\n",
    );
    if (getInstallationOperation(operationId, machineDir)?.status !== "installing")
      throw new Error("installation cancelled");
    updateInstallationPhase(operationId, "publishing", {}, machineDir);
    publish();
    mkdirSync(dirname(root), { recursive: true });
    if (getInstallationOperation(operationId, machineDir)?.status !== "installing")
      throw new Error("installation cancelled");
    if (existsSync(root)) throw new Error("installation publication target already exists");
    renameSync(temp, root);
    finishInstallation(operationId, "installed", null, machineDir);
    publish();
    void activateInstalledAgent(agent.id, agent.version, machineDir, bus, operationId, operation.installation_id).catch(() => undefined);
  } catch (error) {
    finishInstallation(
      operationId,
      "failed",
      error instanceof Error ? error.message : String(error),
      machineDir,
      {
        code: failureCode(error),
        diagnostic: {
          message: error instanceof Error ? error.message : String(error),
          action: "Review the diagnostic and retry the installation.",
        },
      },
    );
    publish();
  } finally {
    rmSync(temp, { recursive: true, force: true });
    installationRoots.delete(operationId);
  }
}

export function runUvx(packageSpecifier: string, cwd: string): Promise<void> {
  const command = packageSpecifier.slice(0, packageSpecifier.indexOf("=="));
  return new Promise((resolvePromise, reject) => {
    const child = spawn("uvx", ["--from", packageSpecifier, command, "--help"], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      shell: false,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("uvx installation timed out"));
    }, INSTALL_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(stderr.trim() || `uvx exited with code ${code ?? "unknown"}`));
    });
  });
}

export async function startInstallation(
  agent: RegistryAgent,
  machineDir = GLOBAL_DIR,
  runner?: NpxRunner | UvxRunner,
  preferred?: RegistryDistribution["kind"],
  options: BinaryInstallOptions = {},
  bus?: EventBus,
): Promise<InstallationOperation> {
  const distribution = selectDistribution(agent, `${process.platform}-${process.arch}`, preferred);
  if (distribution.kind === "binary") {
    const installationId = `${agent.id}@${agent.version}:binary:${distribution.archive_url}`;
    const duplicate = getInstallationByIdentity(
      agent.id,
      agent.version,
      "binary",
      installationId,
      machineDir,
    );
    if (duplicate && !options.retry && getInstalledAgent(agent.id, agent.version, machineDir, installationId)) {
      resumeActivation(duplicate, machineDir, bus);
      return duplicate;
    }
    const operationId = randomUUID();
    const root = resolve(machineDir, "agents", agent.id, agent.version, randomUUID());
    mkdirSync(resolve(machineDir, "agents"), { recursive: true });
    const temp = mkdtempSync(resolve(machineDir, "agents", `.tmp-${randomUUID()}-`));
    const integrity = distribution.checksum ? "unknown" : "unverified";
    const operation = createInstallation(
      {
        id: agent.id,
        version: agent.version,
        source: "registry",
        license: agent.license,
        distribution: "binary",
        package_specifier: null,
        launch: {
          command: resolve(root, distribution.executable ?? ""),
          args: distribution.args ?? [],
          env: distribution.env,
        },
        provenance: {
          exact_version: agent.version,
          distribution: "binary",
          source: "registry",
          package_specifier: null,
          archive_identity: distribution.archive_url ?? null,
          registry_snapshot_fetched_at:
            getRegistryCatalog(machineDir).snapshot?.fetched_at ?? "unknown",
          installation_root: root,
          integrity_status: integrity,
          expected_digest: distribution.checksum ?? null,
          observed_digest: null,
        },
        installation_id: installationId,
        installation_root: root,
        registry_snapshot_fetched_at:
          getRegistryCatalog(machineDir).snapshot?.fetched_at ?? "unknown",
        integrity_status: integrity,
        status: "installing",
        readiness_status: "unknown",
        readiness_error: null,
        protocol_version: null,
        capabilities: null,
        auth_methods: [],
        raw_initialize: null,
        probed_at: null,
      },
      operationId,
      machineDir,
      { phase: "resolving", temporary_root: temp, published_root: root },
    );
    installationRoots.set(operationId, temp);
    void installBinary(
      agent,
      distribution,
      machineDir,
      operationId,
      options.allowUnverified,
      options.fetch,
      bus,
    ).catch(() => undefined);
    return operation;
  }
  if (!distribution.package)
    throw new Error(`agent does not provide a ${distribution.kind} distribution`);
  const packageSpecifier =
    distribution.kind === "npx"
      ? exactNpxPackage(distribution.package)
      : exactUvxPackage(distribution.package);
  const installRunner = runner ?? (distribution.kind === "npx" ? runNpx : runUvx);
  const installationId = `${agent.id}@${agent.version}:${distribution.kind}:${packageSpecifier}`;
  const duplicate = getInstallationByIdentity(
    agent.id,
    agent.version,
    distribution.kind,
    installationId,
    machineDir,
  );
   if (duplicate && !options.retry && getInstalledAgent(agent.id, agent.version, machineDir, installationId)) {
      resumeActivation(duplicate, machineDir, bus);
      return duplicate;
    }
  const running = getInstallationByIdentity(
    agent.id,
    agent.version,
    distribution.kind,
    installationId,
    machineDir,
  );
  if (running?.status === "installing") return running;
  const operationId = randomUUID();
  mkdirSync(resolve(machineDir, "agents"), { recursive: true });
  const installationRoot = resolve(machineDir, "agents", agent.id, agent.version, randomUUID());
  const temporaryRoot = mkdtempSync(resolve(machineDir, "agents", ".tmp-package-"));
  installationRoots.set(operationId, temporaryRoot);
  const launch =
    distribution.kind === "npx"
      ? { command: "npx", args: ["--yes", packageSpecifier, ...(distribution.args ?? [])] }
      : {
          command: "uvx",
          args: [
            "--from",
            packageSpecifier,
            packageSpecifier.slice(0, packageSpecifier.indexOf("==")),
            ...(distribution.args ?? []),
          ],
        };
  const provenance = {
    exact_version: agent.version,
    distribution: distribution.kind,
    source: "registry" as const,
    package_specifier: packageSpecifier,
    archive_identity: null,
    registry_snapshot_fetched_at: getRegistryCatalog(machineDir).snapshot?.fetched_at ?? "unknown",
    installation_root: installationRoot,
    integrity_status: "not_applicable" as const,
  };
  const operation = createInstallation(
    {
      id: agent.id,
      version: agent.version,
      source: "registry",
      license: agent.license,
      distribution: distribution.kind,
      package_specifier: packageSpecifier,
      launch: launch satisfies AgentLaunchSpec,
      provenance,
      installation_id: installationId,
      installation_root: installationRoot,
      registry_snapshot_fetched_at: provenance.registry_snapshot_fetched_at,
      integrity_status: provenance.integrity_status,
      status: "installing",
      readiness_status: "unknown",
      readiness_error: null,
      protocol_version: null,
      capabilities: null,
      auth_methods: [],
      raw_initialize: null,
      probed_at: null,
    },
    operationId,
    machineDir,
    { temporary_root: temporaryRoot, published_root: installationRoot },
  );
  const publish = (): void => {
    if (bus)
      publishInstallationOperationUpdated(bus, getInstallationOperation(operationId, machineDir));
  };
  publish();
  void (async () => {
    try {
      updateInstallationPhase(operationId, "downloading", {}, machineDir);
      publish();
      await installRunner(packageSpecifier, temporaryRoot);
      if (getInstallationOperation(operationId, machineDir)?.status !== "installing")
        throw new Error("installation cancelled");
      updateInstallationPhase(operationId, "verifying", {}, machineDir);
      publish();
      updateInstallationPhase(operationId, "publishing", {}, machineDir);
      publish();
      writeFileSync(
        resolve(temporaryRoot, "manifest.json"),
        JSON.stringify({
          agent_id: agent.id,
          version: agent.version,
          installation_id: installationId,
          package_specifier: packageSpecifier,
          installed_at: new Date().toISOString(),
        }) + "\n",
        { encoding: "utf8" },
      );
      mkdirSync(dirname(installationRoot), { recursive: true });
      if (getInstallationOperation(operationId, machineDir)?.status !== "installing")
        throw new Error("installation cancelled");
      if (existsSync(installationRoot))
        throw new Error("installation publication target already exists");
      renameSync(temporaryRoot, installationRoot);
      finishInstallation(operationId, "installed", null, machineDir);
      publish();
      void activateInstalledAgent(agent.id, agent.version, machineDir, bus, operationId, operation.installation_id).catch(() => undefined);
    } catch (error) {
      if (getInstallationOperation(operationId, machineDir)?.status === "installing")
        finishInstallation(
          operationId,
          "failed",
          error instanceof Error ? error.message : String(error),
          machineDir,
          {
            code: failureCode(error),
            diagnostic: {
              message: error instanceof Error ? error.message : String(error),
              action: "Retry the installation.",
            },
          },
        );
      publish();
    } finally {
      if (existsSync(temporaryRoot)) rmSync(temporaryRoot, { recursive: true, force: true });
      installationRoots.delete(operationId);
    }
  })();
  return operation;
}

export function cancelInstallationOperation(
  operationId: string,
  machineDir = GLOBAL_DIR,
  bus?: EventBus,
): InstallationOperation {
  const operation = getInstallationOperation(operationId, machineDir);
  if (!operation) throw new Error("installation operation not found");
  if (operation.status !== "installing") return operation;
  const temp = installationRoots.get(operationId) ?? operation.temporary_root;
  if (temp) rmSync(temp, { recursive: true, force: true });
  const cancelled = cancelInstallation(operationId, machineDir);
  if (bus) publishInstallationOperationUpdated(bus, cancelled);
  return cancelled;
}

export function installationOperation(id: string, machineDir = GLOBAL_DIR): InstallationOperation {
  const operation = getInstallationOperation(id, machineDir);
  if (!operation) throw new Error("installation operation not found");
  return operation;
}
