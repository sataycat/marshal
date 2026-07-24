import { openDb } from "../db/index.js";
import { openRepositoryDb } from "../db/index.js";

/**
 * Normalize a free-form title into a kebab-case slug suitable for task branches
 * and filesystem paths. Rules mirror the slugs used elsewhere in Marshal (e.g.
 * `add-login`, `branch-check`): lowercase, hyphen-separated words, alphanumeric
 * plus hyphens only.
 */
export function slugifyTitle(title: string): string {
  const cleaned = title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "task";
}

/**
 * Generate a unique slug for a title by appending a numeric suffix on collision
 * with an existing task. The first attempt uses the bare slugified title; the
 * second uses `<slug>-2`, the third `<slug>-3`, and so on.
 */
export function generateUniqueSlug(repositoryId: string, title: string, machineDir?: string): string;
export function generateUniqueSlug(title: string, root?: string): string;
export function generateUniqueSlug(first: string, second?: string, third?: string): string {
  const scoped = second !== undefined;
  const title = scoped ? second! : first;
  const base = slugifyTitle(title);
  const db = scoped ? openRepositoryDb(first, third) : openDb(second);

  const exists = (slug: string): boolean => {
    const row = db.prepare(scoped ? "SELECT 1 FROM tasks WHERE repository_id_v2 = ? AND slug = ?" : "SELECT 1 FROM tasks WHERE slug = ?").get(...(scoped ? [first, slug] : [slug]));
    return row !== undefined;
  };

  if (!exists(base)) {
    return base;
  }

  let suffix = 2;
  while (exists(`${base}-${suffix}`)) {
    suffix++;
  }
  return `${base}-${suffix}`;
}
