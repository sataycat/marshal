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

function distributions(value: unknown, index: number): RegistryDistribution[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new RegistryValidationError(`agents[${index}].distribution must be an object`);
  const result: RegistryDistribution[] = [];
  const distribution = value as Record<string, unknown>;
  if (distribution.npx !== undefined) {
    const npx = distribution.npx;
    if (npx === null || typeof npx !== "object" || Array.isArray(npx)) throw new RegistryValidationError(`agents[${index}].distribution.npx must be an object`);
    result.push({ kind: "npx", package: requiredString((npx as Record<string, unknown>).package, `agents[${index}].distribution.npx.package`) });
  }
  if (distribution.uvx !== undefined) {
    const uvx = distribution.uvx;
    if (uvx === null || typeof uvx !== "object" || Array.isArray(uvx)) throw new RegistryValidationError(`agents[${index}].distribution.uvx must be an object`);
    result.push({ kind: "uvx", package: requiredString((uvx as Record<string, unknown>).package, `agents[${index}].distribution.uvx.package`) });
  }
  if (distribution.binary !== undefined) {
    if (distribution.binary === null || typeof distribution.binary !== "object" || Array.isArray(distribution.binary)) throw new RegistryValidationError(`agents[${index}].distribution.binary must be an object`);
    const platforms = Object.keys(distribution.binary as Record<string, unknown>).filter((platform) => platform.length > 0);
    if (platforms.length === 0) throw new RegistryValidationError(`agents[${index}].distribution.binary must list a platform`);
    result.push({ kind: "binary", platforms });
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
