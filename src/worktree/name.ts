import { createHash } from "node:crypto";

const ADJECTIVES = [
  "brisk",
  "calm",
  "crimson",
  "keen",
  "lucid",
  "quiet",
  "sharp",
  "swift",
  "tidy",
  "vivid",
  "bold",
  "bright",
  "cool",
  "deep",
  "fair",
  "firm",
  "fresh",
  "grand",
  "mild",
  "noble",
  "pale",
  "prime",
  "rich",
  "sleek",
  "stark",
  "true",
  "wise",
  "amber",
  "azure",
  "drab",
  "jade",
  "rosy",
  "rust",
  "sage",
  "teal",
];

const NOUNS = [
  "crane",
  "drum",
  "echo",
  "fox",
  "hawk",
  "owl",
  "path",
  "pine",
  "spark",
  "wave",
  "bear",
  "deer",
  "dove",
  "fish",
  "frog",
  "goat",
  "hare",
  "kite",
  "lark",
  "mole",
  "newt",
  "pike",
  "rook",
  "seal",
  "swan",
  "toad",
  "wren",
  "yak",
  "zest",
  "cliff",
  "dune",
  "fjord",
  "glen",
  "knoll",
  "mesa",
  "ridge",
];

export function descriptorForSlug(slug: string, attempt = 0): string {
  const hash = createHash("sha256").update(slug).digest("hex");
  const adjIndex = parseInt(hash.slice(0, 8), 16) % ADJECTIVES.length;
  const nounIndex = parseInt(hash.slice(8, 16), 16) % NOUNS.length;
  const suffix = attempt > 0 ? `-${attempt}` : "";
  return `${ADJECTIVES[adjIndex]}-${NOUNS[nounIndex]}${suffix}`;
}

export function branchNameForSlug(slug: string, descriptor: string): string {
  return `marshal/task/${slug}-${descriptor}`;
}
