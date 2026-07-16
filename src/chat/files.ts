import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";

export const MAX_FILE_BYTES = 128 * 1024;
export const MAX_CONTEXT_BYTES = 256 * 1024;
export const MAX_MENTIONS = 8;
export const MAX_TREE_ENTRIES = 5000;

export interface ChatFileEntry {
  path: string;
  type: "file" | "directory";
  changed: boolean;
  touched: boolean;
}

export interface ChatFileContent {
  path: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export class InvalidChatPathError extends Error {
  constructor(path: string) {
    super(`Path is outside the thread working directory: ${path}`);
    this.name = "InvalidChatPathError";
  }
}

export class ChatFileTooLargeError extends Error {
  constructor(path: string) {
    super(`File is too large to include in chat: ${path}`);
    this.name = "ChatFileTooLargeError";
  }
}

function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

function relativePath(cwd: string, path: string): string {
  const absoluteCwd = resolve(cwd);
  const absolutePath = resolve(absoluteCwd, path);
  const rel = normalize(relative(absoluteCwd, absolutePath));
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) {
    throw new InvalidChatPathError(path);
  }
  return rel;
}

export function safeChatPath(cwd: string, path: string): string {
  const rel = relativePath(cwd, path);
  const full = resolve(cwd, rel);
  const realCwd = realpathSync(cwd);
  const realFull = realpathSync(full);
  if (realFull !== realCwd && !realFull.startsWith(`${realCwd}/`)) {
    throw new InvalidChatPathError(path);
  }
  const stat = lstatSync(full);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
    throw new InvalidChatPathError(path);
  }
  return full;
}

function gitPaths(repoRoot: string, cwd: string): string[] {
  const raw = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const prefix = normalize(relative(repoRoot, cwd));
  return raw.split("\0").filter((path) => {
    if (!path) return false;
    const normalized = normalize(path);
    return prefix === "" || normalized === prefix || normalized.startsWith(`${prefix}/`);
  }).map((path) => {
    const normalized = normalize(path);
    return prefix === "" ? normalized : normalized.slice(prefix.length + 1);
  });
}

function changedPaths(repoRoot: string, cwd: string): Set<string> {
  try {
    const raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const prefix = normalize(relative(repoRoot, cwd));
    const result = new Set<string>();
    for (const record of raw.split("\0")) {
      if (record.length < 4) continue;
      const path = normalize(record.slice(3));
      if (prefix !== "" && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
      result.add(prefix === "" ? path : path.slice(prefix.length + 1));
    }
    return result;
  } catch {
    return new Set();
  }
}

export function listChatFiles(repoRoot: string, cwd: string, touched = new Set<string>()): ChatFileEntry[] {
  const files = gitPaths(repoRoot, cwd);
  const changed = changedPaths(repoRoot, cwd);
  const paths = new Set<string>(files);
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) paths.add(parts.slice(0, i).join("/"));
  }
  return [...paths].sort((a, b) => {
    const depth = (value: string) => value.split("/").length;
    return depth(a) - depth(b) || a.localeCompare(b);
  }).slice(0, MAX_TREE_ENTRIES).map((path) => ({
    path,
    type: files.includes(path) ? "file" : "directory",
    changed: changed.has(path) || [...changed].some((entry) => entry.startsWith(`${path}/`)),
    touched: touched.has(path) || [...touched].some((entry) => entry.startsWith(`${path}/`)),
  }));
}

export function readChatFile(cwd: string, path: string): ChatFileContent {
  const full = safeChatPath(cwd, path);
  const stat = lstatSync(full);
  if (!stat.isFile()) throw new InvalidChatPathError(path);
  if (stat.size > MAX_FILE_BYTES) throw new ChatFileTooLargeError(path);
  const buffer = readFileSync(full);
  return { path: relativePath(cwd, path), content: buffer.toString("utf8"), truncated: false, bytes: buffer.byteLength };
}

const MENTION = /@([A-Za-z0-9._/-]+)/g;

export function expandChatFileMentions(content: string, cwd: string): string {
  let totalBytes = Buffer.byteLength(content);
  let count = 0;
  return content.replace(MENTION, (match, mentionedPath: string) => {
    if (count >= MAX_MENTIONS) return match;
    let file: ChatFileContent;
    try {
      file = readChatFile(cwd, mentionedPath);
    } catch {
      return match;
    }
    const addition = `\n\n<context file="${file.path}">\n\`\`\`\n${file.content}\n\`\`\`\n</context>`;
    const additionBytes = Buffer.byteLength(addition);
    if (totalBytes + additionBytes > MAX_CONTEXT_BYTES) return match;
    totalBytes += additionBytes;
    count += 1;
    return addition;
  });
}
