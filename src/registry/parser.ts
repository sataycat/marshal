import type { RegistryAgent, RegistryDistribution } from "./types.js";

export class RegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryValidationError";
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RegistryValidationError(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field);
}

const PLATFORMS = new Set(["linux-x64", "linux-arm64", "linux-x86_64", "linux-aarch64", "darwin-x64", "darwin-arm64", "darwin-x86_64", "darwin-aarch64", "win32-x64", "windows-x64", "windows-arm64"]);
const ARCHIVE_FORMATS = new Set(["tar.gz", "tgz", "zip"]);

function safePath(value: unknown, field: string): string {
  const path = requiredString(value, field).replaceAll("\\", "/");
  if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === "") || /^[A-Za-z]:/.test(path)) throw new RegistryValidationError(`${field} must be a safe relative path`);
  return path;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.includes("\0"))) throw new RegistryValidationError(`${field} must be an array of strings`);
  return value.map((item) => item as string);
}

function archive(value: Record<string, unknown>, field: string): Pick<RegistryDistribution, "archive_url" | "archive_format" | "checksum" | "executable" | "args" | "env" | "platform"> {
  const url = requiredString(value.url ?? value.archive_url, `${field}.url`);
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new RegistryValidationError(`${field}.url must be a valid URL`); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new RegistryValidationError(`${field}.url must use http or https`);
  const format = requiredString(value.format ?? value.archive_format, `${field}.format`).toLowerCase();
  if (!ARCHIVE_FORMATS.has(format)) throw new RegistryValidationError(`${field}.format is unsupported`);
  const checksum = value.checksum === undefined || value.checksum === null ? undefined : requiredString(value.checksum, `${field}.checksum`).replace(/^sha256:/i, "").toLowerCase();
  if (checksum !== undefined && !/^[a-f0-9]{64}$/.test(checksum)) throw new RegistryValidationError(`${field}.checksum must be a SHA-256 digest`);
  const env = value.env === undefined ? undefined : value.env;
  if (env !== undefined && (env === null || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([key, item]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof item !== "string" || item.includes("\0")))) throw new RegistryValidationError(`${field}.env must contain safe string environment metadata`);
  return { platform: optionalString(value.platform, `${field}.platform`), archive_url: url, archive_format: format as "tar.gz" | "tgz" | "zip", checksum, executable: safePath(value.executable ?? value.executable_path, `${field}.executable`), args: value.args === undefined ? [] : stringArray(value.args, `${field}.args`), env: env as Record<string, string> | undefined };
}

function distributions(value: unknown, index: number): RegistryDistribution[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RegistryValidationError(`agents[${index}].distribution must be an object`);
  const result: RegistryDistribution[] = [];
  const distribution = value as Record<string, unknown>;
  if (distribution.npx !== undefined) {
    const npx = distribution.npx;
    if (npx === null || typeof npx !== "object" || Array.isArray(npx)) throw new RegistryValidationError(`agents[${index}].distribution.npx must be an object`);
    result.push({ kind: "npx", package: requiredString((npx as Record<string, unknown>).package, `agents[${index}].distribution.npx.package`), args: (npx as Record<string, unknown>).args === undefined ? [] : stringArray((npx as Record<string, unknown>).args, `agents[${index}].distribution.npx.args`) });
  }
  if (distribution.uvx !== undefined) {
    const uvx = distribution.uvx;
    if (uvx === null || typeof uvx !== "object" || Array.isArray(uvx)) throw new RegistryValidationError(`agents[${index}].distribution.uvx must be an object`);
    result.push({ kind: "uvx", package: requiredString((uvx as Record<string, unknown>).package, `agents[${index}].distribution.uvx.package`), args: (uvx as Record<string, unknown>).args === undefined ? [] : stringArray((uvx as Record<string, unknown>).args, `agents[${index}].distribution.uvx.args`) });
  }
  if (distribution.binary !== undefined) {
    if (distribution.binary === null || typeof distribution.binary !== "object" || Array.isArray(distribution.binary)) throw new RegistryValidationError(`agents[${index}].distribution.binary must be an object`);
    const binary = distribution.binary as Record<string, unknown>;
    const platforms = Object.keys(binary).filter((platform) => platform.length > 0);
    if (platforms.length === 0) throw new RegistryValidationError(`agents[${index}].distribution.binary must list a platform`);
    for (const platform of platforms) {
      if (!PLATFORMS.has(platform)) throw new RegistryValidationError(`agents[${index}].distribution.binary.${platform} is an unsupported platform`);
      const value = binary[platform];
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RegistryValidationError(`agents[${index}].distribution.binary.${platform} must be an object`);
      result.push({ kind: "binary", platforms: [platform], ...archive(value as Record<string, unknown>, `agents[${index}].distribution.binary.${platform}`) });
    }
  }
  if (result.length === 0) throw new RegistryValidationError(`agents[${index}].distribution must provide a supported distribution`);
  return result;
}

export function parseRegistryDocument(value: unknown): { version: string; agents: RegistryAgent[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RegistryValidationError("registry document must be an object");
  const document = value as Record<string, unknown>;
  const version = requiredString(document.version, "version");
  if (!/^1\./.test(version)) throw new RegistryValidationError(`unsupported registry version: ${version}`);
  if (!Array.isArray(document.agents)) throw new RegistryValidationError("agents must be an array");
  const agents = document.agents.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RegistryValidationError(`agents[${index}] must be an object`);
    const agent = value as Record<string, unknown>;
    const authors = agent.authors === undefined ? [] : agent.authors;
    if (!Array.isArray(authors) || authors.some((author) => typeof author !== "string" || author.trim() === "")) throw new RegistryValidationError(`agents[${index}].authors must be an array of strings`);
    return {
      id: requiredString(agent.id, `agents[${index}].id`),
      name: requiredString(agent.name, `agents[${index}].name`),
      version: requiredString(agent.version, `agents[${index}].version`),
      description: requiredString(agent.description, `agents[${index}].description`),
      repository: optionalString(agent.repository, `agents[${index}].repository`),
      website: optionalString(agent.website, `agents[${index}].website`),
      authors: authors.map((author) => author.trim()),
      license: requiredString(agent.license, `agents[${index}].license`),
      icon: optionalString(agent.icon, `agents[${index}].icon`),
      distributions: distributions(agent.distribution, index),
    } satisfies RegistryAgent;
  });
  const ids = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) throw new RegistryValidationError(`duplicate agent id: ${agent.id}`);
    ids.add(agent.id);
  }
  return { version, agents };
}
